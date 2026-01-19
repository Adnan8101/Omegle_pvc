import { ChannelType, Events, type VoiceState } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import {
    getChannelState,
    isInterfaceChannel,
    registerChannel,
    unregisterChannel,
    getChannelByOwner,
} from '../utils/voiceManager';
import { getOwnerPermissions } from '../utils/permissions';
import { executeWithRateLimit, executeParallel, Priority } from '../utils/rateLimit';
import {
    getGuildSettings,
    getOwnerPermissions as getCachedOwnerPerms,
    getChannelPermissions,
    getWhitelist,
    batchUpsertPermissions,
} from '../utils/cache';

export const name = Events.VoiceStateUpdate;
export const once = false;

export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // Handle user joining a channel
    if (newState.channelId && newState.channelId !== oldState.channelId) {
        await handleJoin(client, newState);
    }

    // Handle user leaving a channel
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        await handleLeave(client, oldState);
    }
}

async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    // Check if joining interface channel
    if (isInterfaceChannel(channelId)) {
        await createPrivateChannel(client, state);
        return;
    }

    // Check if joining a private channel with admin strictness
    const channelState = getChannelState(channelId);
    if (channelState) {
        await enforceAdminStrictness(client, state, channelState.ownerId);
    }
}

async function handleLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild } = state;
    if (!channelId) return;

    const channelState = getChannelState(channelId);
    if (!channelState) return;

    // Check if channel is now empty
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return;

    if (channel.members.size === 0) {
        await deletePrivateChannel(channelId, guild.id);
    }
}

async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;
    if (!member || !interfaceChannel) return;

    // Check if user already has a channel
    const existingChannel = getChannelByOwner(guild.id, member.id);
    if (existingChannel) {
        const channel = guild.channels.cache.get(existingChannel);
        if (channel && channel.type === ChannelType.GuildVoice) {
            await executeWithRateLimit(`move:${member.id}`, () => member.voice.setChannel(channel), Priority.HIGH);
            return;
        }
    }

    try {
        // Create new voice channel with HIGH priority
        const ownerPerms = getOwnerPermissions();
        const newChannel = await executeWithRateLimit(
            `create:${guild.id}`,
            () => guild.channels.create({
                name: member.displayName,
                type: ChannelType.GuildVoice,
                parent: interfaceChannel.parent,
                permissionOverwrites: [
                    {
                        id: member.id,
                        allow: ownerPerms.allow,
                        deny: ownerPerms.deny,
                    },
                ],
            }),
            Priority.HIGH
        );

        // Register in memory immediately
        registerChannel(newChannel.id, guild.id, member.id);

        // Fetch cached owner permissions (from persistent table)
        const [_, ownerPermissions] = await Promise.all([
            // Save to database
            prisma.privateVoiceChannel.create({
                data: {
                    channelId: newChannel.id,
                    guildId: guild.id,
                    ownerId: member.id,
                },
            }),
            // Get cached owner permissions
            getCachedOwnerPerms(guild.id, member.id),
        ]);

        // Restore permissions in parallel if any exist
        if (ownerPermissions.length > 0) {
            // Batch Discord API calls
            const discordTasks = ownerPermissions.map(perm => ({
                route: `perms:${newChannel.id}:${perm.targetId}`,
                task: () => newChannel.permissionOverwrites.edit(perm.targetId, {
                    ViewChannel: true,
                    Connect: true,
                }),
                priority: Priority.NORMAL,
            }));

            // Run Discord API calls in parallel
            await executeParallel(discordTasks);

            // Batch DB insert
            await batchUpsertPermissions(
                newChannel.id,
                ownerPermissions.map(p => ({
                    targetId: p.targetId,
                    targetType: p.targetType,
                    permission: 'permit',
                }))
            );
        }

        // Move user to new channel
        await executeWithRateLimit(`move:${member.id}`, () => member.voice.setChannel(newChannel), Priority.HIGH);
    } catch {
        // Silently handle channel creation errors
    }
}

async function deletePrivateChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(channelId);

        // Remove from memory first (fast)
        unregisterChannel(channelId);

        // Delete channel and DB in parallel
        await Promise.all([
            channel?.isVoiceBased()
                ? executeWithRateLimit(`delete:${channelId}`, async () => { await channel.delete(); }, Priority.NORMAL)
                : Promise.resolve(),
            prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { }),
        ]);
    } catch {
        // Silently handle channel deletion errors
    }
}

async function enforceAdminStrictness(
    client: PVCClient,
    state: VoiceState,
    ownerId: string
): Promise<void> {
    const { guild, member, channelId } = state;
    if (!member || !channelId) return;

    // Get the voice channel from cache
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;

    // Quick checks first (no DB)
    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size >= channel.userLimit;

    if (!isLocked && !isHidden && !isFull) return;

    // Owner is always allowed
    if (member.id === ownerId) return;

    // Use cached guild settings
    const settings = await getGuildSettings(guild.id);
    if (!settings?.adminStrictness) return;

    // Fetch permissions and whitelist in parallel (cached)
    const memberRoleIds = member.roles.cache.map(r => r.id);
    const [channelPerms, whitelist] = await Promise.all([
        getChannelPermissions(channelId),
        getWhitelist(guild.id),
    ]);

    // Check if user is permitted
    const isUserPermitted = channelPerms.some(
        p => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return;

    // Check if any role is permitted
    const isRolePermitted = channelPerms.some(
        p => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return;

    // Check whitelist
    const isWhitelisted = whitelist.some(
        w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
    );
    if (isWhitelisted) return;

    // User is NOT permitted - disconnect them
    try {
        await member.voice.disconnect();

        // Send DM in background (don't await)
        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        member.send(
            `You do not have access to this voice channel.\nAsk ${ownerName} to give you access to join.`
        ).catch(() => { });
    } catch {
        // Silently handle strictness enforcement errors
    }
}

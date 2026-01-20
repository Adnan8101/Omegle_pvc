import { ChannelType, Events, type VoiceState, EmbedBuilder, AuditLogEvent } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import {
    getChannelState,
    isInterfaceChannel,
    registerChannel,
    unregisterChannel,
    getChannelByOwner,
    addUserToJoinOrder,
    removeUserFromJoinOrder,
    getNextUserInOrder,
    transferOwnership,
    isOnCooldown,
    setCooldown,
    hasTempPermission,
    unregisterInterfaceChannel,
    registerInterfaceChannel,
} from '../utils/voiceManager';
import { getOwnerPermissions } from '../utils/permissions';
import { executeWithRateLimit, executeParallel, Priority, fireAndForget } from '../utils/rateLimit';
import {
    getGuildSettings,
    getOwnerPermissions as getCachedOwnerPerms,
    getChannelPermissions,
    getWhitelist,
    batchUpsertPermissions,
} from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

export const name = Events.VoiceStateUpdate;
export const once = false;

export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    console.log(`[VSU] User ${member.user.username} | Old: ${oldState.channelId} | New: ${newState.channelId}`);

    if (newState.channelId && newState.channelId !== oldState.channelId) {
        console.log(`[VSU] Processing JOIN for channel ${newState.channelId}`);
        const wasKicked = await handleAccessProtection(client, newState);

        console.log(`[VSU] wasKicked: ${wasKicked}`);
        if (!wasKicked) {
            console.log(`[VSU] Calling handleJoin...`);
            await handleJoin(client, newState);
        }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        await handleLeave(client, oldState);
    }
}

async function handleAccessProtection(
    client: PVCClient,
    newState: VoiceState
): Promise<boolean> {
    const { channelId: newChannelId, guild, member } = newState;
    if (!newChannelId || !member) return false;

    const channelState = getChannelState(newChannelId);
    if (!channelState) return false;

    const channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return false;

    if (member.id === channelState.ownerId) return false;

    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size > channel.userLimit;

    if (!isLocked && !isHidden && !isFull) return false;

    const memberRoleIds = member.roles.cache.map(r => r.id);
    const [channelPerms, settings, whitelist] = await Promise.all([
        getChannelPermissions(newChannelId),
        getGuildSettings(guild.id),
        getWhitelist(guild.id),
    ]);

    const isUserPermitted = channelPerms.some(
        p => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return false;

    if (hasTempPermission(newChannelId, member.id)) return false;

    const isRolePermitted = channelPerms.some(
        p => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return false;

    const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');

    if (!settings?.adminStrictness) {
        if (hasAdminPerm) return false;
    } else {
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        if (isWhitelisted) return false;
    }

    // STRICT MODE: Audit Log check removed to enforce database-only permissions and improve performance during mass joins.
    // Previously, this allowed users moved by admins to stay. Now, if not in DB, they get kicked.

    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';

    // FIRE AND FORGET: Don't wait for kick to complete - J2C must never be blocked
    // Use unique route per user to maximize parallelism
    fireAndForget(
        `kick:${member.id}`,
        async () => {
            await member.voice.disconnect();

            // Send DM after disconnect (also fire and forget)
            const owner = guild.members.cache.get(channelState.ownerId);
            const ownerName = owner?.displayName || 'the owner';
            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle('🚫 Access Denied')
                .setDescription(
                    `You were removed from **${channel.name}** because the channel is **${reason}**.\n\n` +
                    `Ask **${ownerName}** to give you access to join.`
                )
                .setTimestamp();
            member.send({ embeds: [embed] }).catch(() => { });
        },
        Priority.LOW
    );

    // Log asynchronously - don't block
    logAction({
        action: LogAction.USER_REMOVED,
        guild: guild,
        user: member.user,
        channelName: channel.name,
        channelId: newChannelId,
        details: `Unauthorized access attempt blocked (channel is ${reason})`,
    }).catch(() => { });

    // Return true immediately - kick is queued, don't wait
    return true;
}

async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    console.log(`[handleJoin] Channel: ${channelId} | Guild: ${guild.id}`);

    let isInterface = isInterfaceChannel(channelId);
    console.log(`[handleJoin] isInterface (memory): ${isInterface}`);

    // FALLBACK: If not in memory, check DB (handles restart edge cases)
    if (!isInterface) {
        const settings = await getGuildSettings(guild.id);
        console.log(`[handleJoin] DB Settings:`, settings ? `interfaceVcId=${settings.interfaceVcId}` : 'null');
        if (settings?.interfaceVcId === channelId) {
            // Found in DB but not in memory - register it now
            console.log(`[handleJoin] Found in DB! Registering interface channel...`);
            registerInterfaceChannel(guild.id, channelId);
            isInterface = true;
        }
    }

    console.log(`[handleJoin] Final isInterface: ${isInterface}`);

    if (isInterface) {
        console.log(`[handleJoin] Calling createPrivateChannel...`);
        await createPrivateChannel(client, state);
        return;
    }

    const channelState = getChannelState(channelId);
    if (channelState) {
        const channel = guild.channels.cache.get(channelId);

        addUserToJoinOrder(channelId, member.id);

        if (channel) {
            await logAction({
                action: LogAction.USER_ADDED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} joined the voice channel`,
            });
        }
    }
}

async function handleLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId) return;

    const channelState = getChannelState(channelId);
    if (!channelState) return;

    if (member) {
        removeUserFromJoinOrder(channelId, member.id);
    }

    if (member) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
            await logAction({
                action: LogAction.USER_REMOVED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} left the voice channel`,
            });
        }
    }

    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.type === ChannelType.GuildVoice) {
        if (channel.members.size === 0) {
            await logAction({
                action: LogAction.CHANNEL_DELETED,
                guild: guild,
                channelName: channel.name,
                channelId: channelId,
                details: `Channel deleted (empty)`,
            });

            await deletePrivateChannel(channelId, guild.id);
        } else if (member && member.id === channelState.ownerId) {
            await transferChannelOwnership(client, channelId, guild, channel);
        }
    }
}

async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;
    if (!member || !interfaceChannel) return;

    if (isOnCooldown(member.id, 'CREATE_CHANNEL')) {
        try {
            await member.voice.disconnect();
        } catch { }
        return;
    }

    const existingChannel = getChannelByOwner(guild.id, member.id);
    if (existingChannel) {
        const channel = guild.channels.cache.get(existingChannel);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const freshMember = await guild.members.fetch(member.id);
                if (freshMember.voice.channelId) {
                    await freshMember.voice.setChannel(channel);
                }
            } catch { }
            return;
        } else {
            // Channel exists in memory but not in Discord - clean up stale data
            unregisterChannel(existingChannel);
            await prisma.privateVoiceChannel.delete({
                where: { channelId: existingChannel },
            }).catch(() => { });
        }
    }

    // Verify interface channel still exists in Discord
    const interfaceExists = guild.channels.cache.has(interfaceChannel.id);
    if (!interfaceExists) {
        // Interface channel was deleted - unregister and disconnect user
        unregisterInterfaceChannel(guild.id);
        try {
            await member.voice.disconnect();
        } catch { }
        return;
    }

    setCooldown(member.id, 'CREATE_CHANNEL');

    try {
        const ownerPerms = getOwnerPermissions();

        // Persistent History: Load from Cache
        const savedPermissions = await getCachedOwnerPerms(guild.id, member.id);

        const permissionOverwrites: any[] = [
            {
                id: member.id,
                allow: ownerPerms.allow,
                deny: ownerPerms.deny,
            },
        ];

        // Apply saved permissions to channel overrides
        for (const p of savedPermissions) {
            permissionOverwrites.push({
                id: p.targetId,
                allow: ['ViewChannel', 'Connect'],
            });
        }

        // IMMEDIATE priority - J2C must NEVER wait in queue
        const newChannel = await executeWithRateLimit(
            `create:${guild.id}`,
            () => guild.channels.create({
                name: member.displayName,
                type: ChannelType.GuildVoice,
                parent: interfaceChannel.parent,
                permissionOverwrites,
            }),
            Priority.IMMEDIATE
        );

        registerChannel(newChannel.id, guild.id, member.id);

        addUserToJoinOrder(newChannel.id, member.id);

        await prisma.privateVoiceChannel.create({
            data: {
                channelId: newChannel.id,
                guildId: guild.id,
                ownerId: member.id,
                createdAt: new Date(),
                permissions: {
                    create: savedPermissions.map(p => ({
                        targetId: p.targetId,
                        targetType: p.targetType,
                        permission: p.permission,
                    })),
                },
            },
        });


        const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            await freshMember.voice.setChannel(newChannel);

            try {
                const welcomeEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎉 Welcome to Your PVC')
                    .setDescription(`<@${member.id}>, your private voice channel has been created!`)
                    .setTimestamp();

                await newChannel.send({ embeds: [welcomeEmbed] });
            } catch { }

            await logAction({
                action: LogAction.CHANNEL_CREATED,
                guild: guild,
                user: member.user,
                channelName: newChannel.name,
                channelId: newChannel.id,
                details: `Private voice channel created`,
            });
        } else {
            await newChannel.delete();
            unregisterChannel(newChannel.id);
            await prisma.privateVoiceChannel.delete({ where: { channelId: newChannel.id } }).catch(() => { });
            return;
        }

        const ownerPermissions = await getCachedOwnerPerms(guild.id, member.id);
        if (ownerPermissions.length > 0) {
            const validPermissions: typeof ownerPermissions = [];
            const invalidTargetIds: string[] = [];

            for (const perm of ownerPermissions) {
                const isValidTarget = perm.targetType === 'role'
                    ? guild.roles.cache.has(perm.targetId)
                    : guild.members.cache.has(perm.targetId) || await guild.members.fetch(perm.targetId).catch(() => null);

                if (isValidTarget) {
                    validPermissions.push(perm);
                } else {
                    invalidTargetIds.push(perm.targetId);
                }
            }

            if (invalidTargetIds.length > 0) {
                await prisma.ownerPermission.deleteMany({
                    where: {
                        guildId: guild.id,
                        ownerId: member.id,
                        targetId: { in: invalidTargetIds },
                    },
                }).catch(() => { });
            }

            if (validPermissions.length > 0) {
                const discordTasks = validPermissions.map(perm => ({
                    route: `perms:${newChannel.id}:${perm.targetId}`,
                    task: () => newChannel.permissionOverwrites.edit(perm.targetId, {
                        ViewChannel: true,
                        Connect: true,
                    }),
                    priority: Priority.NORMAL,
                }));

                await executeParallel(discordTasks);

                await batchUpsertPermissions(
                    newChannel.id,
                    validPermissions.map(p => ({
                        targetId: p.targetId,
                        targetType: p.targetType,
                        permission: 'permit',
                    }))
                );
            }
        }
    } catch { }
}

async function transferChannelOwnership(
    client: PVCClient,
    channelId: string,
    guild: any,
    channel: any
): Promise<void> {
    try {
        const nextUserId = getNextUserInOrder(channelId);
        if (!nextUserId) {
            return;
        }

        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            return;
        }

        transferOwnership(channelId, nextUserId);

        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { ownerId: nextUserId },
        });

        const ownerPerms = getOwnerPermissions();
        await channel.permissionOverwrites.edit(nextUserId, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            MuteMembers: true,
            DeafenMembers: true,
            MoveMembers: true,
            ManageChannels: true,
        });

        try {
            await executeWithRateLimit(
                `rename:${channelId}`,
                () => channel.setName(newOwner.displayName),
                Priority.LOW
            );
        } catch { }

        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: newOwner.user,
            channelName: channel.name,
            channelId: channelId,
            details: `Ownership transferred to ${newOwner.user.username}`,
        });

        try {
            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('🔄 Ownership Transferred')
                .setDescription(
                    `<@${nextUserId}> is now the owner of this voice channel!`
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        } catch { }
    } catch { }
}

async function deletePrivateChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            unregisterChannel(channelId);
            await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });
            return;
        }

        const channel = guild.channels.cache.get(channelId);

        if (channel?.isVoiceBased()) {
            try {
                await executeWithRateLimit(`delete:${channelId}`, async () => {
                    await channel.delete();
                }, Priority.NORMAL);
            } catch { }
        }

        unregisterChannel(channelId);
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });

    } catch {
        unregisterChannel(channelId);
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });
    }
}

async function enforceAdminStrictness(
    client: PVCClient,
    state: VoiceState,
    ownerId: string
): Promise<void> {
    const { guild, member, channelId } = state;
    if (!member || !channelId) return;

    if (member.id === ownerId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;

    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size > channel.userLimit;

    if (!isLocked && !isHidden && !isFull) return;

    const settings = await getGuildSettings(guild.id);
    if (!settings?.adminStrictness) return;

    const memberRoleIds = member.roles.cache.map(r => r.id);
    const [channelPerms, whitelist] = await Promise.all([
        getChannelPermissions(channelId),
        getWhitelist(guild.id),
    ]);

    const isUserPermitted = channelPerms.some(
        p => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return;

    const isRolePermitted = channelPerms.some(
        p => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return;

    const isWhitelisted = whitelist.some(
        w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
    );
    if (isWhitelisted) return;

    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';

    try {
        await member.voice.disconnect();

        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('Access Denied')
            .setDescription(
                `You were disconnected from **${channel.name} PVC** because the channel is ${reason}.\n\n` +
                `Ask **${ownerName}** to give you access to join.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => { });
    } catch { }
}

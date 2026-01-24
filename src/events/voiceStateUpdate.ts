import { ChannelType, Events, type VoiceState, EmbedBuilder, AuditLogEvent, AttachmentBuilder } from 'discord.js';
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
    isTeamInterfaceChannel,
    getTeamInterfaceType,
    registerTeamChannel,
    registerTeamInterfaceChannel,
    unregisterTeamChannel,
    getTeamChannelState,
    getTeamChannelByOwner,
    transferTeamOwnership,
    TEAM_USER_LIMITS,
    type TeamType,
    acquireCreationLock,
    releaseCreationLock,
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
import { generateVcInterfaceEmbed, generateInterfaceImage, createInterfaceComponents } from '../utils/canvasGenerator';
import { isPvcPaused } from '../utils/pauseManager';

import { recordBotEdit } from './channelUpdate';
import { VoiceStateService } from '../services/voiceStateService';

export const name = Events.VoiceStateUpdate;
export const once = false;

// Hardcoded bot IDs that are always allowed (security bots, etc.)
const WHITELISTED_BOT_IDS = new Set([
    '536991182035746816', // Wick bot
]);

export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    if (newState.channelId && newState.channelId !== oldState.channelId) {
        const wasKicked = await handleAccessProtection(client, newState);
        if (!wasKicked) {
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

    // SECURITY: Block all bots except whitelisted ones
    if (member.user.bot && !WHITELISTED_BOT_IDS.has(member.user.id)) {
        // Kick unauthorized bots
        try {
            await member.voice.disconnect();
        } catch { }
        return true;
    }

    // 1. Fetch Authoritative State from DB
    // We do NOT use in-memory cache or Discord channel state for authority
    const dbState = await VoiceStateService.getVCState(newChannelId);

    // If not in DB, it's not a managed channel we control -> Ignore
    if (!dbState) return false;

    const channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return false;

    const ownerId = dbState.ownerId;
    if (member.id === ownerId) return false;

    // 2. Check Locks & Limits from DB
    const isLocked = dbState.isLocked;
    const isHidden = dbState.isHidden;
    const isFull = dbState.userLimit > 0 && channel.members.size > dbState.userLimit;

    if (!isLocked && !isHidden && !isFull) return false;

    // 3. Check Permissions (DB Authority)
    // We allow:
    // - Owner (checked above)
    // - Explicitly Permitted Users/Roles in DB
    // - Admins (If strictness is OFF) or Whitelisted Users (If strictness is ON)

    // Check DB Permissions
    const dbPermissions = dbState.permissions || [];
    const memberRoleIds = member.roles.cache.map(r => r.id);

    // Check specific user permit
    const isUserPermitted = dbPermissions.some(
        (p: any) => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return false;

    // Check role permit
    const isRolePermitted = dbPermissions.some(
        (p: any) => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return false;

    // Check Admin/Whitelist for BOTH PVC and Team channels
    const [settings, whitelist] = await Promise.all([
        getGuildSettings(guild.id),
        getWhitelist(guild.id),
    ]);

    const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');

    // For team channels, check team-specific strictness settings too
    const teamSettings = dbState.teamType ? await prisma.teamVoiceSettings.findUnique({
        where: { guildId: guild.id }
    }) : null;
    
    const strictnessEnabled = settings?.adminStrictness || teamSettings?.adminStrictness;

    if (!strictnessEnabled) {
        // Strictness OFF: Admins can bypass
        if (hasAdminPerm) return false;
    } else {
        // Strictness ON: Only Whitelisted Admins can bypass
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        if (isWhitelisted) return false;
    }

    // 4. KICK THE INTRUDER
    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
    const channelTypeName = 'voice channel'; // Generic name

    fireAndForget(
        `kick:${member.id}`,
        async () => {
            try {
                await member.voice.disconnect();
                const owner = guild.members.cache.get(ownerId);
                const ownerName = owner?.displayName || 'the owner';
                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('🚫 Access Denied')
                    .setDescription(
                        `You were removed from **${channel.name}** because the ${channelTypeName} is **${reason}**.\n\n` +
                        `Ask **${ownerName}** to give you access to join.`
                    )
                    .setTimestamp();
                member.send({ embeds: [embed] }).catch(() => { });
            } catch (err) {
                console.error(`[AccessProtection] Failed to kick ${member.id}:`, err);
            }
        },
        Priority.LOW
    );

    logAction({
        action: LogAction.USER_REMOVED,
        guild: guild,
        user: member.user,
        channelName: channel.name,
        channelId: newChannelId,
        details: `Unauthorized access attempt blocked (${channelTypeName} is ${reason})`,
        isTeamChannel: false, // We'd need to check type, but purely for logging.
    }).catch(() => { });

    return true;
}

async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    let isInterface = isInterfaceChannel(channelId);

    if (!isInterface) {
        const settings = await getGuildSettings(guild.id);
        if (settings?.interfaceVcId === channelId) {

            registerInterfaceChannel(guild.id, channelId);
            isInterface = true;
        }
    }

    if (isInterface) {

        if (isPvcPaused(guild.id)) {
            try {
                await member.voice.disconnect();
                const pauseEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('⏸️ PVC System Paused')
                    .setDescription(
                        `The Private Voice Channel system in **${guild.name}** is currently paused.\n\n` +
                        'Channel creation is temporarily disabled.\n' +
                        'Please wait for an administrator to resume the system.'
                    )
                    .setTimestamp();
                await member.send({ embeds: [pauseEmbed] }).catch(() => { });
            } catch { }
            return;
        }
        await createPrivateChannel(client, state);
        return;
    }

    let teamType = getTeamInterfaceType(channelId);

    if (!teamType) {
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
        });

        if (teamSettings) {
            if (teamSettings.duoVcId === channelId) {
                teamType = 'duo';
                registerTeamInterfaceChannel(guild.id, 'duo', channelId);
            } else if (teamSettings.trioVcId === channelId) {
                teamType = 'trio';
                registerTeamInterfaceChannel(guild.id, 'trio', channelId);
            } else if (teamSettings.squadVcId === channelId) {
                teamType = 'squad';
                registerTeamInterfaceChannel(guild.id, 'squad', channelId);
            }
        }
    }

    const ownedTeamChannel = getTeamChannelByOwner(guild.id, member.id);
    const ownedPvcChannel = getChannelByOwner(guild.id, member.id);

    if (ownedTeamChannel === channelId || ownedPvcChannel === channelId) {
        return;
    }

    if (teamType) {
        if (isPvcPaused(guild.id)) {
            try {
                await member.voice.disconnect();
                const pauseEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('⏸️ PVC System Paused')
                    .setDescription(
                        `The Private Voice Channel system in **${guild.name}** is currently paused.\n\n` +
                        'Team channel creation is temporarily disabled.\n' +
                        'Please wait for an administrator to resume the system.'
                    )
                    .setTimestamp();
                await member.send({ embeds: [pauseEmbed] }).catch(() => { });
            } catch { }
            return;
        }
        await createTeamChannel(client, state, teamType);
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
        return;
    }

    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {
        const channel = guild.channels.cache.get(channelId);

        addUserToJoinOrder(channelId, member.id);

        if (channel) {
            await logAction({
                action: LogAction.USER_ADDED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} joined the team channel`,
                isTeamChannel: true,
                teamType: teamChannelState.teamType,
            });
        }
    }
}

async function handleLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId) return;

    const channelState = getChannelState(channelId);
    if (channelState) {
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
            } else {
                const allBots = channel.members.every(m => m.user.bot);
                if (allBots && channel.members.size > 0) {
                    for (const [, botMember] of channel.members) {
                        await botMember.voice.disconnect().catch(() => { });
                    }

                    await logAction({
                        action: LogAction.CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Channel deleted (only bots remained)`,
                    });

                    await deletePrivateChannel(channelId, guild.id);
                } else if (member && member.id === channelState.ownerId) {
                    await transferChannelOwnership(client, channelId, guild, channel);
                }
            }
        }
        return;
    }

    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {
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
                    details: `${member.user.username} left the team channel`,
                    isTeamChannel: true,
                    teamType: teamChannelState.teamType,
                });
            }
        }

        const channel = guild.channels.cache.get(channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            if (channel.members.size === 0) {
                await logAction({
                    action: LogAction.TEAM_CHANNEL_DELETED,
                    guild: guild,
                    channelName: channel.name,
                    channelId: channelId,
                    details: `Team channel deleted (empty)`,
                    isTeamChannel: true,
                    teamType: teamChannelState.teamType,
                });

                await deleteTeamChannel(channelId, guild.id);
            } else {
                const allBots = channel.members.every(m => m.user.bot);
                if (allBots && channel.members.size > 0) {
                    for (const [, botMember] of channel.members) {
                        await botMember.voice.disconnect().catch(() => { });
                    }

                    await logAction({
                        action: LogAction.TEAM_CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Team channel deleted (only bots remained)`,
                        isTeamChannel: true,
                        teamType: teamChannelState.teamType,
                    });

                    await deleteTeamChannel(channelId, guild.id);
                } else if (member && member.id === teamChannelState.ownerId) {
                    await transferTeamChannelOwnership(client, channelId, guild, channel);
                }
            }
        }
    }
}

async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;

    if (!member || !interfaceChannel) return;

    const lockAcquired = await acquireCreationLock(guild.id, member.id);
    if (!lockAcquired) {

        try {
            await member.voice.disconnect();
        } catch { }
        return;
    }

    try {
        if (isOnCooldown(member.id, 'CREATE_CHANNEL')) {
            try {
                await member.voice.disconnect();
            } catch { }
            releaseCreationLock(guild.id, member.id);
            return;
        }

        let existingChannel = getChannelByOwner(guild.id, member.id);
        let existingType = 'PVC';

        if (!existingChannel) {
            existingChannel = getTeamChannelByOwner(guild.id, member.id);
            existingType = 'Team';
        }

        if (existingChannel) {
            let actuallyOwnsChannel = false;
            if (existingType === 'Team') {
                const teamDbCheck = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = teamDbCheck?.ownerId === member.id;
            } else {
                const pvcDbCheck = await prisma.privateVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = pvcDbCheck?.ownerId === member.id;
            }

            if (!actuallyOwnsChannel) {
                if (existingType === 'Team') {
                    unregisterTeamChannel(existingChannel);
                } else {
                    unregisterChannel(existingChannel);
                }
            } else {
                const channel = guild.channels.cache.get(existingChannel);
                if (channel && channel.type === ChannelType.GuildVoice) {
                    try {
                        const freshMember = await guild.members.fetch(member.id);
                        if (freshMember.voice.channelId) {
                            await freshMember.voice.setChannel(channel);
                        }
                    } catch (err) {
                        console.error('[VoiceStateUpdate] Failed to move member to existing channel:', err);
                    }
                    releaseCreationLock(guild.id, member.id);
                    return;
                } else {
                    if (existingType === 'Team') {
                        unregisterTeamChannel(existingChannel);
                        await prisma.teamVoiceChannel.delete({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    } else {
                        unregisterChannel(existingChannel);
                        await prisma.privateVoiceChannel.delete({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    }
                }
            }
        }

        const interfaceExists = guild.channels.cache.has(interfaceChannel.id);
        if (!interfaceExists) {
            unregisterInterfaceChannel(guild.id);
            try {
                await member.voice.disconnect();
            } catch { }
            releaseCreationLock(guild.id, member.id);
            return;
        }

        setCooldown(member.id, 'CREATE_CHANNEL');

        const ownerPerms = getOwnerPermissions();

        const savedPermissions = await getCachedOwnerPerms(guild.id, member.id);
        const permissionOverwrites: any[] = [
            {
                id: member.id,
                allow: ownerPerms.allow,
                deny: ownerPerms.deny,
            },
        ];

        const invalidTargetIds: string[] = [];
        for (const p of savedPermissions) {

            const isValidMember = guild.members.cache.has(p.targetId);
            const isValidRole = guild.roles.cache.has(p.targetId);

            if (isValidMember || isValidRole) {
                permissionOverwrites.push({
                    id: p.targetId,
                    allow: ['ViewChannel', 'Connect', 'SendMessages', 'EmbedLinks', 'AttachFiles'],
                });
            } else {
                invalidTargetIds.push(p.targetId);
            }
        }

        if (invalidTargetIds.length > 0) {
            prisma.ownerPermission.deleteMany({
                where: {
                    guildId: guild.id,
                    ownerId: member.id,
                    targetId: { in: invalidTargetIds },
                },
            }).catch(() => { });
        }

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

        // Create initial snapshot for the new channel


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

        releaseCreationLock(guild.id, member.id);

        const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            await freshMember.voice.setChannel(newChannel);

            try {
                const imageBuffer = await generateInterfaceImage();
                const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                const embed = generateVcInterfaceEmbed(guild, member.id, 'interface.png');
                const components = createInterfaceComponents();

                const interfaceMessage = await newChannel.send({
                    content: `<@${member.id}>`,
                    embeds: [embed],
                    files: [attachment],
                    components,
                });

                await interfaceMessage.pin().catch(() => { });
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
                // Record bot edit before modifying permissions
                recordBotEdit(newChannel.id);

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
    } catch (error) {

        releaseCreationLock(guild.id, member.id);
    }
}

async function transferChannelOwnership(
    client: PVCClient,
    channelId: string,
    guild: any,
    channel: any
): Promise<void> {
    try {

        let nextUserId = getNextUserInOrder(channelId);

        if (!nextUserId && channel.members.size > 0) {
            const currentState = getChannelState(channelId);
            const teamState = getTeamChannelState(channelId);
            const oldOwnerId = currentState?.ownerId || teamState?.ownerId;

            const availableMember = channel.members.find((m: any) => m.id !== oldOwnerId && !m.user.bot);
            if (availableMember) {
                nextUserId = availableMember.id;
            }
        }

        if (!nextUserId) {
            return;
        }

        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            return;
        }

        const currentState = getChannelState(channelId);
        const teamState = getTeamChannelState(channelId);
        const isTeamChannel = Boolean(teamState);

        if (currentState) {
            transferOwnership(channelId, nextUserId);
        }
        if (teamState) {
            transferTeamOwnership(channelId, nextUserId);
        }

        if (isTeamChannel && teamState) {
            await prisma.teamVoiceChannel.update({
                where: { channelId },
                data: { ownerId: nextUserId },
            });
        } else {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { ownerId: nextUserId },
            });
        }

        const ownerPerms = getOwnerPermissions();

        // Record bot edit before modifying channel
        recordBotEdit(channelId);

        await channel.permissionOverwrites.edit(nextUserId, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            SendMessages: true,
            EmbedLinks: true,
            AttachFiles: true,
            MuteMembers: true,
            DeafenMembers: true,
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

async function createTeamChannel(client: PVCClient, state: VoiceState, teamType: TeamType): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;

    if (!member || !interfaceChannel) return;

    const lockAcquired = await acquireCreationLock(guild.id, member.id);
    if (!lockAcquired) {
        try {
            await member.voice.disconnect();
        } catch { }
        return;
    }

    try {
        if (isOnCooldown(member.id, 'CREATE_CHANNEL')) {
            try {
                await member.voice.disconnect();
            } catch { }
            releaseCreationLock(guild.id, member.id);
            return;
        }

        let existingChannel = getChannelByOwner(guild.id, member.id);
        let existingType = 'PVC';

        if (!existingChannel) {
            existingChannel = getTeamChannelByOwner(guild.id, member.id);
            existingType = 'Team';
        }

        if (existingChannel) {
            let actuallyOwnsChannel = false;
            if (existingType === 'Team') {
                const teamDbCheck = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = teamDbCheck?.ownerId === member.id;
            } else {
                const pvcDbCheck = await prisma.privateVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = pvcDbCheck?.ownerId === member.id;
            }

            if (!actuallyOwnsChannel) {
                if (existingType === 'Team') {
                    unregisterTeamChannel(existingChannel);
                } else {
                    unregisterChannel(existingChannel);
                }
            } else {
                const channel = guild.channels.cache.get(existingChannel);
                const existingState = existingType === 'Team' ? getTeamChannelState(existingChannel) : getChannelState(existingChannel);

                if (channel && channel.type === ChannelType.GuildVoice) {
                    try {
                        const freshMember = await guild.members.fetch(member.id);
                        if (freshMember.voice.channelId) {
                            await freshMember.voice.setChannel(channel);

                            const channelTypeName = existingType === 'Team' && existingState && 'teamType' in existingState
                                ? existingState.teamType.toUpperCase()
                                : 'Private Voice';

                            const embed = new EmbedBuilder()
                                .setColor(0xFFA500)
                                .setTitle('Existing Channel')
                                .setDescription(
                                    `You already have an active **${channelTypeName}** channel.\n\n` +
                                    `You've been moved to your existing channel instead of creating a new one.\n\n` +
                                    `To create a different type, delete your current channel first using the Delete button.`
                                )
                                .setTimestamp();
                            await member.send({ embeds: [embed] }).catch(() => { });
                        }
                    } catch { }
                    releaseCreationLock(guild.id, member.id);
                    return;
                } else {
                    if (existingType === 'Team') {
                        unregisterTeamChannel(existingChannel);
                        await prisma.teamVoiceChannel.delete({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    } else {
                        unregisterChannel(existingChannel);
                        await prisma.privateVoiceChannel.delete({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    }
                }
            }
        }

        setCooldown(member.id, 'CREATE_CHANNEL');

        const userLimit = TEAM_USER_LIMITS[teamType];
        const ownerPerms = getOwnerPermissions();

        const newChannel = await executeWithRateLimit(
            `create:${guild.id}`,
            () => guild.channels.create({
                name: `${member.displayName}'s ${teamType.charAt(0).toUpperCase() + teamType.slice(1)}`,
                type: ChannelType.GuildVoice,
                parent: interfaceChannel.parent,
                userLimit: userLimit,
                permissionOverwrites: [
                    {
                        id: member.id,
                        allow: ownerPerms.allow,
                        deny: ownerPerms.deny,
                    },
                ],
            }),
            Priority.IMMEDIATE
        );

        registerTeamChannel(newChannel.id, guild.id, member.id, teamType);

        // Create initial snapshot for the new team channel


        addUserToJoinOrder(newChannel.id, member.id);

        await prisma.teamVoiceChannel.create({
            data: {
                channelId: newChannel.id,
                guildId: guild.id,
                ownerId: member.id,
                teamType: teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                createdAt: new Date(),
            },
        });

        releaseCreationLock(guild.id, member.id);

        const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            await freshMember.voice.setChannel(newChannel);

            try {
                const imageBuffer = await generateInterfaceImage();
                const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                const embed = generateVcInterfaceEmbed(guild, member.id, 'interface.png');
                embed.setTitle(`🎮 ${teamType.charAt(0).toUpperCase() + teamType.slice(1)} Controls`);
                const components = createInterfaceComponents();

                const interfaceMessage = await newChannel.send({
                    content: `<@${member.id}> - **User Limit:** ${userLimit}`,
                    embeds: [embed],
                    files: [attachment],
                    components,
                });

                await interfaceMessage.pin().catch(() => { });
            } catch { }

            await logAction({
                action: LogAction.TEAM_CHANNEL_CREATED,
                guild: guild,
                user: member.user,
                channelName: newChannel.name,
                channelId: newChannel.id,
                details: `${teamType.charAt(0).toUpperCase() + teamType.slice(1)} channel created (limit: ${userLimit})`,
                isTeamChannel: true,
                teamType: teamType,
            });
        } else {
            await newChannel.delete();
            unregisterTeamChannel(newChannel.id);
            await prisma.teamVoiceChannel.delete({ where: { channelId: newChannel.id } }).catch(() => { });
            return;
        }
    } catch (error) {
        releaseCreationLock(guild.id, member.id);
    }
}

async function deleteTeamChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            unregisterTeamChannel(channelId);
            await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => { });
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

        unregisterTeamChannel(channelId);
        await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => { });

    } catch {
        unregisterTeamChannel(channelId);
        await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => { });
    }
}

async function transferTeamChannelOwnership(
    client: PVCClient,
    channelId: string,
    guild: any,
    channel: any
): Promise<void> {
    try {
        const teamState = getTeamChannelState(channelId);
        const oldOwnerId = teamState?.ownerId;

        let nextUserId = getNextUserInOrder(channelId);

        if (!nextUserId && channel.members.size > 0) {

            const availableMember = channel.members.find((m: any) => m.id !== oldOwnerId && !m.user.bot);
            if (availableMember) {
                nextUserId = availableMember.id;
            }
        }

        if (!nextUserId) {
            return;
        }

        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            return;
        }

        transferTeamOwnership(channelId, nextUserId);

        await prisma.teamVoiceChannel.update({
            where: { channelId },
            data: { ownerId: nextUserId },
        });

        const ownerPerms = getOwnerPermissions();

        // Record bot edit before modifying channel
        recordBotEdit(channelId);

        await channel.permissionOverwrites.edit(nextUserId, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            SendMessages: true,
            EmbedLinks: true,
            AttachFiles: true,
            MuteMembers: true,
            DeafenMembers: true,
            ManageChannels: true,
        });

        const teamType = teamState?.teamType || 'Team';
        const teamTypeName = teamType.charAt(0).toUpperCase() + teamType.slice(1).toLowerCase();
        try {
            await executeWithRateLimit(
                `rename:${channelId}`,
                () => channel.setName(`${newOwner.displayName}'s ${teamTypeName}`),
                Priority.LOW
            );
        } catch { }

        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: newOwner.user,
            channelName: channel.name,
            channelId: channelId,
            details: `Team channel ownership transferred to ${newOwner.user.username}`,
            isTeamChannel: true,
            teamType: teamState?.teamType,
        });

        try {
            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('🔄 Ownership Transferred')
                .setDescription(
                    `<@${nextUserId}> is now the owner of this team channel!`
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        } catch { }
    } catch { }
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

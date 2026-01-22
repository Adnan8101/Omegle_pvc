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

export const name = Events.VoiceStateUpdate;
export const once = false;

export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    console.log(`[VoiceState] User: ${member.user.username} | Old: ${oldState.channelId} | New: ${newState.channelId}`);

    if (newState.channelId && newState.channelId !== oldState.channelId) {
        console.log(`[VoiceState] User ${member.user.username} joined channel ${newState.channelId}`);
        const wasKicked = await handleAccessProtection(client, newState);

        if (!wasKicked) {
            await handleJoin(client, newState);
        } else {
            console.log(`[VoiceState] User ${member.user.username} was kicked from channel`);
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

    // Check both PVC and team channel state
    const channelState = getChannelState(newChannelId);
    const teamChannelState = getTeamChannelState(newChannelId);
    
    // Not a PVC or team channel
    if (!channelState && !teamChannelState) return false;

    const channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return false;

    const ownerId = channelState?.ownerId || teamChannelState?.ownerId;
    const isTeamChannel = Boolean(teamChannelState);
    
    // Owner can always join
    if (member.id === ownerId) return false;

    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size > channel.userLimit;

    if (!isLocked && !isHidden && !isFull) return false;

    const memberRoleIds = member.roles.cache.map(r => r.id);
    
    // Get guild settings and whitelist (works for both PVC and team)
    const [settings, whitelist] = await Promise.all([
        getGuildSettings(guild.id),
        getWhitelist(guild.id),
    ]);
    
    // Get channel-specific permissions based on channel type
    let channelPerms: Array<{targetId: string; targetType: string; permission: string}> = [];
    if (isTeamChannel) {
        const teamPerms = await prisma.teamVoicePermission.findMany({
            where: { channelId: newChannelId },
        });
        channelPerms = teamPerms.map(p => ({ targetId: p.targetId, targetType: p.targetType, permission: p.permission }));
    } else {
        channelPerms = await getChannelPermissions(newChannelId);
    }

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

    // Admin strictness applies to BOTH PVC and team channels
    if (!settings?.adminStrictness) {
        // If strictness is OFF, admins bypass protection
        if (hasAdminPerm) return false;
    } else {
        // If strictness is ON, check whitelist (applies to both PVC and team)
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        if (isWhitelisted) return false;
    }

    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
    const channelTypeName = isTeamChannel ? 'team channel' : 'voice channel';

    // FIRE AND FORGET: Don't wait for kick to complete
    fireAndForget(
        `kick:${member.id}`,
        async () => {
            await member.voice.disconnect();

            const owner = guild.members.cache.get(ownerId!);
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
        },
        Priority.LOW
    );

    // Log asynchronously
    logAction({
        action: LogAction.USER_REMOVED,
        guild: guild,
        user: member.user,
        channelName: channel.name,
        channelId: newChannelId,
        details: `Unauthorized access attempt blocked (${channelTypeName} is ${reason})`,
        isTeamChannel: isTeamChannel,
        teamType: teamChannelState?.teamType,
    }).catch(() => { });

    return true;
}

async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    let isInterface = isInterfaceChannel(channelId);

    // FALLBACK: If not in memory, check DB (handles restart edge cases)
    if (!isInterface) {
        const settings = await getGuildSettings(guild.id);
        if (settings?.interfaceVcId === channelId) {
            // Found in DB but not in memory - register it now
            registerInterfaceChannel(guild.id, channelId);
            isInterface = true;
        }
    }

    if (isInterface) {
        // Check if PVC system is paused
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

    // Check for team interface channels
    let teamType = getTeamInterfaceType(channelId);
    console.log(`[HandleJoin] Checking team interface for channel ${channelId}: ${teamType || 'NOT TEAM'}`);
    
    // FALLBACK: If not in memory, check DB (handles restart edge cases or mismatched data)
    if (!teamType) {
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
        });
        
        if (teamSettings) {
            console.log(`[HandleJoin] Checking DB team settings - duo: ${teamSettings.duoVcId}, trio: ${teamSettings.trioVcId}, squad: ${teamSettings.squadVcId}`);
            
            if (teamSettings.duoVcId === channelId) {
                teamType = 'duo';
                registerTeamInterfaceChannel(guild.id, 'duo', channelId);
                console.log(`[HandleJoin] Found duo in DB, registered to memory`);
            } else if (teamSettings.trioVcId === channelId) {
                teamType = 'trio';
                registerTeamInterfaceChannel(guild.id, 'trio', channelId);
                console.log(`[HandleJoin] Found trio in DB, registered to memory`);
            } else if (teamSettings.squadVcId === channelId) {
                teamType = 'squad';
                registerTeamInterfaceChannel(guild.id, 'squad', channelId);
                console.log(`[HandleJoin] Found squad in DB, registered to memory`);
            } else {
                console.log(`[HandleJoin] Channel ${channelId} not matching any team interface in DB`);
            }
        } else {
            console.log(`[HandleJoin] No team settings found in DB for guild ${guild.id}`);
        }
    }
    
    // IMPORTANT: Check if user is joining their OWN channel (PVC or team - not the interface)
    const ownedTeamChannel = getTeamChannelByOwner(guild.id, member.id);
    const ownedPvcChannel = getChannelByOwner(guild.id, member.id);
    
    if (ownedTeamChannel === channelId || ownedPvcChannel === channelId) {
        console.log(`[HandleJoin] User ${member.user.username} joined their own channel ${channelId}, skipping creation`);
        return; // User joined their own created channel, don't create another
    }
    
    if (teamType) {
        console.log(`[HandleJoin] Team interface detected! Type: ${teamType}`);
        // Check if PVC system is paused
        if (isPvcPaused(guild.id)) {
            console.log(`[HandleJoin] PVC system is paused, disconnecting user`);
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
        console.log(`[HandleJoin] Calling createTeamChannel with type: ${teamType}`);
        await createTeamChannel(client, state, teamType);
        return;
    }

    // Check if joining an existing PVC
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

    // Check if joining an existing team channel
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

    // Check for regular PVC
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
            } else if (member && member.id === channelState.ownerId) {
                await transferChannelOwnership(client, channelId, guild, channel);
            }
        }
        return;
    }

    // Check for team channel
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
            } else if (member && member.id === teamChannelState.ownerId) {
                await transferTeamChannelOwnership(client, channelId, guild, channel);
            }
        }
    }
}

async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;

    if (!member || !interfaceChannel) return;

    // RACE CONDITION PROTECTION: Acquire lock before proceeding
    const lockAcquired = await acquireCreationLock(guild.id, member.id);
    if (!lockAcquired) {
        // Another creation is already in progress for this user
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

        // Double-check ownership after acquiring lock - CHECK BOTH PVC AND TEAM CHANNELS
        let existingChannel = getChannelByOwner(guild.id, member.id);
        let existingType = 'PVC';
        
        // Also check for team channels - user should only have ONE channel of any type
        if (!existingChannel) {
            existingChannel = getTeamChannelByOwner(guild.id, member.id);
            existingType = 'Team';
        }

        if (existingChannel) {
            console.log(`[CreatePrivateChannel] Found channel in memory - ${existingType}: ${existingChannel}`);
            
            // CRITICAL: Verify ownership in database before blocking
            let actuallyOwnsChannel = false;
            if (existingType === 'Team') {
                const teamDbCheck = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = teamDbCheck?.ownerId === member.id;
                console.log(`[CreatePrivateChannel] Database ownership check: ${actuallyOwnsChannel} (DB owner: ${teamDbCheck?.ownerId})`);
            } else {
                const pvcDbCheck = await prisma.privateVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = pvcDbCheck?.ownerId === member.id;
                console.log(`[CreatePrivateChannel] Database ownership check: ${actuallyOwnsChannel} (DB owner: ${pvcDbCheck?.ownerId})`);
            }
            
            if (!actuallyOwnsChannel) {
                // Memory was stale - user no longer owns this channel, clean up
                console.log(`[CreatePrivateChannel] Memory stale - user no longer owns channel, cleaning up`);
                if (existingType === 'Team') {
                    unregisterTeamChannel(existingChannel);
                } else {
                    unregisterChannel(existingChannel);
                }
                // Continue to create new channel
            } else {
                // User actually owns the channel - verify it exists in Discord
                const channel = guild.channels.cache.get(existingChannel);
                if (channel && channel.type === ChannelType.GuildVoice) {
                    try {
                        const freshMember = await guild.members.fetch(member.id);
                        if (freshMember.voice.channelId) {
                            await freshMember.voice.setChannel(channel);
                        }
                    } catch { }
                    releaseCreationLock(guild.id, member.id);
                    return;
                } else {
                    // Channel exists in memory but not in Discord - clean up stale data
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

        // Verify interface channel still exists in Discord
        const interfaceExists = guild.channels.cache.has(interfaceChannel.id);
        if (!interfaceExists) {
            // Interface channel was deleted - unregister and disconnect user
            unregisterInterfaceChannel(guild.id);
            try {
                await member.voice.disconnect();
            } catch { }
            releaseCreationLock(guild.id, member.id);
            return;
        }

        setCooldown(member.id, 'CREATE_CHANNEL');

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
        // Apply saved permissions to channel overrides - VALIDATE each one first
        const invalidTargetIds: string[] = [];
        for (const p of savedPermissions) {
            // Check if user/role still exists in guild cache
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
        // Clean up invalid permissions from DB in background
        if (invalidTargetIds.length > 0) {
            prisma.ownerPermission.deleteMany({
                where: {
                    guildId: guild.id,
                    ownerId: member.id,
                    targetId: { in: invalidTargetIds },
                },
            }).catch(() => { });
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

            // RELEASE LOCK IMMEDIATELY after successful channel creation and registration
            // This prevents race conditions during the async operations below
            releaseCreationLock(guild.id, member.id);

            const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            await freshMember.voice.setChannel(newChannel);

            try {
                // Send the full interface canvas with buttons to VC text chat
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

                // Pin the interface message
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
        // Error occurred, ensure lock is released
        console.error(`[CreatePrivateChannel] ERROR:`, error);
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
        // First try to get next user from join order
        let nextUserId = getNextUserInOrder(channelId);
        
        // If no one in join order, pick any member currently in the channel
        if (!nextUserId && channel.members.size > 0) {
            const currentState = getChannelState(channelId);
            const teamState = getTeamChannelState(channelId);
            const oldOwnerId = currentState?.ownerId || teamState?.ownerId;
            
            // Get first member that's not the old owner
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

        // Update memory state using proper transfer function
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

        // Rename channel to new owner's name
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

    console.log(`[CreateTeamChannel] START - User: ${member?.user.username}, Type: ${teamType}, Guild: ${guild.name}`);
    console.log(`[CreateTeamChannel] Interface channel: ${interfaceChannel?.id}`);

    if (!member || !interfaceChannel) {
        console.log(`[CreateTeamChannel] ABORT - Missing member or interface channel`);
        return;
    }

    // RACE CONDITION PROTECTION: Acquire lock before proceeding
    const lockAcquired = await acquireCreationLock(guild.id, member.id);
    if (!lockAcquired) {
        // Another creation is already in progress for this user
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

        // ENFORCEMENT: Double-check if user already owns ANY channel (PVC or team) after acquiring lock
        console.log(`[CreateTeamChannel] Checking for existing channels owned by ${member.user.username}`);
        
        // Check for regular PVC first
        let existingChannel = getChannelByOwner(guild.id, member.id);
        let existingType = 'PVC';
        
        // Then check for team channels
        if (!existingChannel) {
            existingChannel = getTeamChannelByOwner(guild.id, member.id);
            existingType = 'Team';
        }

        if (existingChannel) {
            console.log(`[CreateTeamChannel] Found channel in memory - ${existingType}: ${existingChannel}`);
            
            // CRITICAL: Verify ownership in database before blocking
            let actuallyOwnsChannel = false;
            if (existingType === 'Team') {
                const teamDbCheck = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = teamDbCheck?.ownerId === member.id;
                console.log(`[CreateTeamChannel] Database ownership check: ${actuallyOwnsChannel} (DB owner: ${teamDbCheck?.ownerId})`);
            } else {
                const pvcDbCheck = await prisma.privateVoiceChannel.findUnique({
                    where: { channelId: existingChannel },
                });
                actuallyOwnsChannel = pvcDbCheck?.ownerId === member.id;
                console.log(`[CreateTeamChannel] Database ownership check: ${actuallyOwnsChannel} (DB owner: ${pvcDbCheck?.ownerId})`);
            }
            
            if (!actuallyOwnsChannel) {
                // Memory was stale - user no longer owns this channel, clean up
                console.log(`[CreateTeamChannel] Memory stale - user no longer owns channel, cleaning up`);
                if (existingType === 'Team') {
                    unregisterTeamChannel(existingChannel);
                } else {
                    unregisterChannel(existingChannel);
                }
                // Continue to create new channel
            } else {
                // User actually owns the channel - verify it exists in Discord
                const channel = guild.channels.cache.get(existingChannel);
                const existingState = existingType === 'Team' ? getTeamChannelState(existingChannel) : getChannelState(existingChannel);
                
                if (channel && channel.type === ChannelType.GuildVoice) {
                    try {
                        const freshMember = await guild.members.fetch(member.id);
                        if (freshMember.voice.channelId) {
                            await freshMember.voice.setChannel(channel);
                            
                            // Send info message about existing channel
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
                    // Channel exists in memory but not in Discord - clean up stale data
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

        console.log(`[CreateTeamChannel] Creating channel - Type: ${teamType}, Limit: ${userLimit}`);
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

        console.log(`[CreateTeamChannel] Channel created: ${newChannel.id} - ${newChannel.name}`);

        registerTeamChannel(newChannel.id, guild.id, member.id, teamType);
        console.log(`[CreateTeamChannel] Channel registered in memory`);

        addUserToJoinOrder(newChannel.id, member.id);

        console.log(`[CreateTeamChannel] Saving to database...`);
        await prisma.teamVoiceChannel.create({
            data: {
                channelId: newChannel.id,
                guildId: guild.id,
                ownerId: member.id,
                teamType: teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                createdAt: new Date(),
            },
        });
        console.log(`[CreateTeamChannel] Database record created`);

        // RELEASE LOCK IMMEDIATELY after successful channel creation and registration
        // This prevents race conditions during the async operations below
        releaseCreationLock(guild.id, member.id);
        
        const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            console.log(`[CreateTeamChannel] Moving user to new channel...`);
            await freshMember.voice.setChannel(newChannel);
            console.log(`[CreateTeamChannel] User moved successfully`);

            try {
                // Send the full interface canvas with buttons to team VC text chat
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

                // Pin the interface message
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
            console.log(`[CreateTeamChannel] Logged action to webhook`);
        } else {
            console.log(`[CreateTeamChannel] CLEANUP - User not in voice, deleting channel`);
            await newChannel.delete();
            unregisterTeamChannel(newChannel.id);
            await prisma.teamVoiceChannel.delete({ where: { channelId: newChannel.id } }).catch(() => { });
            return;
        }
    } catch (error) { 
        // Error occurred, ensure lock is released
        console.error(`[CreateTeamChannel] ERROR:`, error);
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
        
        // First try to get next user from join order
        let nextUserId = getNextUserInOrder(channelId);
        
        // If no one in join order, pick any member currently in the channel
        if (!nextUserId && channel.members.size > 0) {
            // Get first member that's not the old owner
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

        // Rename to new owner's team name, preserving team type
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

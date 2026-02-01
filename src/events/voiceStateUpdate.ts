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
import { vcnsBridge } from '../vcns/bridge';
import { stateStore } from '../vcns/index';
import {
    getGuildSettings,
    getOwnerPermissions as getCachedOwnerPerms,
    getChannelPermissions,
    getWhitelist,
    batchUpsertPermissions,
    invalidateChannelPermissions,
} from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';
import { generateVcInterfaceEmbed, generateInterfaceImage, createInterfaceComponents } from '../utils/canvasGenerator';
import { isPvcPaused } from '../utils/pauseManager';
import { recordBotEdit } from './channelUpdate';
import { VoiceStateService } from '../services/voiceStateService';
import { hasTempDragPermission, removeTempDragPermission } from './messageCreate';
export const name = Events.VoiceStateUpdate;
export const once = false;
const WHITELISTED_BOT_IDS = new Set([
    '536991182035746816', 
]);
export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member) return;
    if (member.user.bot) {
        if (newState.channelId && newState.channelId !== oldState.channelId) {
            await handleBotJoin(client, newState);
        }
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
            await handleBotLeave(client, oldState);
        }
        return;
    }
    if (newState.channelId && newState.channelId !== oldState.channelId) {
        console.log(`[VCNS-JOIN] 🟢 User ${member.user.tag} (${member.id}) joining VC ${newState.channelId}`);
        const wasKicked = await handleAccessProtection(client, newState);
        if (!wasKicked) {
            console.log(`[VCNS-JOIN] ✅ User ${member.user.tag} successfully joined - processing handleJoin`);
            await handleJoin(client, newState);
        } else {
            console.log(`[VCNS-JOIN] ❌ User ${member.user.tag} was kicked by access protection`);
        }
    }
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        await handleLeave(client, oldState);
    }
}
async function handleBotJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member || !member.user.bot) return;
    const dbState = await VoiceStateService.getVCState(channelId);
    if (!dbState) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return;
    try {
        recordBotEdit(channelId);
        await vcnsBridge.editPermission({
            guild,
            channelId,
            targetId: member.id,
            permissions: {
                ViewChannel: true,
                Connect: true,
                Speak: true,
            },
        });
    } catch (err) {
        console.error(`[BotJoin] Failed to grant permissions to bot ${member.id}:`, err);
    }
}
async function handleBotLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member || !member.user.bot) return;
    const dbState = await VoiceStateService.getVCState(channelId);
    if (!dbState) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return;
    try {
        recordBotEdit(channelId);
        await vcnsBridge.removePermission({
            guild,
            channelId,
            targetId: member.id,
        });
    } catch (err) {
        console.error(`[BotLeave] Failed to remove permissions from bot ${member.id}:`, err);
    }
}
async function handleAccessProtection(
    client: PVCClient,
    newState: VoiceState
): Promise<boolean> {
    const { channelId: newChannelId, guild, member } = newState;
    if (!newChannelId || !member) return false;
    console.log(`[VCNS-ACCESS] 🔍 Starting access protection for ${member.user.tag} (${member.id}) in channel ${newChannelId}`);
    const globalBlock = stateStore.isGloballyBlocked(guild.id, member.id);
    if (globalBlock) {
        console.log(`[VCNS-ACCESS] 🚫 User ${member.user.tag} is GLOBALLY BLOCKED: ${globalBlock.reason}`);
        try {
            await vcnsBridge.kickUser({
                guild,
                channelId: newChannelId,
                userId: member.id,
                reason: 'Globally blocked from all voice channels',
                isImmediate: false, 
            });
        } catch (err) {
            console.error(`[VCNS-ACCESS] ❌ Failed to kick globally blocked user ${member.id}:`, err);
        }
        console.log(`[VCNS-ACCESS] ✅ Globally blocked user ${member.user.tag} kick initiated`);
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription(`You don't have access to voice channels in **${guild.name}**.\n\nContact server administrators.`)
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => { });
        logAction({
            action: LogAction.USER_REMOVED,
            guild: guild,
            user: member.user,
            channelName: `Channel ${newChannelId}`,
            channelId: newChannelId,
            details: `Blocked`,
            isTeamChannel: false,
        }).catch(() => { });
        return true;
    }
    let dbState = await VoiceStateService.getVCState(newChannelId);
    if (!dbState) {
        const memoryState = stateStore.getChannelState(newChannelId);
        if (memoryState) {
            console.log(`[VCNS-ACCESS] ⚠️ Channel ${newChannelId} in MEMORY but not DB - attempting auto-recovery...`);
            try {
                if (memoryState.isTeamChannel) {
                    await prisma.teamVoiceChannel.create({
                        data: {
                            channelId: newChannelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            teamType: (memoryState.teamType?.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD') || 'DUO',
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                } else {
                    await prisma.privateVoiceChannel.create({
                        data: {
                            channelId: newChannelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                }
                console.log(`[VCNS-ACCESS] ✅ Auto-recovered channel ${newChannelId} to database!`);
                dbState = await VoiceStateService.getVCState(newChannelId);
                if (dbState) {
                    console.log(`[VCNS-ACCESS] ✅ Verified auto-recovery, continuing with access protection`);
                } else {
                    console.log(`[VCNS-ACCESS] ❌ Auto-recovery verification failed - allowing access`);
                    return false;
                }
            } catch (recoveryErr: any) {
                console.error(`[VCNS-ACCESS] ❌ Auto-recovery failed:`, recoveryErr.message);
                console.log(`[VCNS-ACCESS] ⚠️ Channel ${newChannelId} not in DB - allowing access (recovery failed)`);
                return false;
            }
        } else {
            console.log(`[VCNS-ACCESS] ⚠️ Channel ${newChannelId} not in DB or memory - not a managed PVC, allowing access`);
            return false;
        }
    }
    const channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        console.log(`[VCNS-ACCESS] ⚠️ Channel ${newChannelId} not found in cache or not voice - skipping`);
        return false;
    }
    const ownerId = dbState.ownerId;
    if (member.id === ownerId) {
        console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} is OWNER - access granted`);
        return false;
    }
    const dbPermissions = dbState.permissions || [];
    const memberRoleIds = member.roles.cache.map(r => r.id);
    const isUserBanned = dbPermissions.some(
        (p: any) => p.targetId === member.id && p.permission === 'ban'
    );
    const isRoleBanned = dbPermissions.some(
        (p: any) => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'ban'
    );
    if (isUserBanned || isRoleBanned) {
        try {
            await vcnsBridge.kickUser({
                guild,
                channelId: newChannelId,
                userId: member.id,
                reason: 'Blocked from this channel',
                isImmediate: false, 
            });
        } catch (err) {
            console.error(`[VCNS-ACCESS] ❌ Failed to kick banned user ${member.id}:`, err);
        }
        console.log(`[VCNS-ACCESS] ✅ Banned user ${member.user.tag} kick initiated`);
        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setDescription(
                `You don't have access to **${channel.name}**.\n\nAsk **${ownerName}** to unblock you.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => { });
        logAction({
            action: LogAction.USER_REMOVED,
            guild: guild,
            user: member.user,
            channelName: channel.name,
            channelId: newChannelId,
            details: `Blocked`,
            isTeamChannel: false,
        }).catch(() => { });
        return true;
    }
    const hasPermanentAccess = stateStore.hasPermanentAccess(guild.id, ownerId, member.id);
    console.log(`[VCNS-ACCESS] 🔑 Permanent access check for ${member.user.tag}: ${hasPermanentAccess}`);
    if (hasPermanentAccess) {
        console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} has PERMANENT ACCESS from owner - bypass all restrictions`);
        
        // Add Discord permission overwrites if channel is locked/hidden
        if (dbState.isLocked || dbState.isHidden) {
            const channel = guild.channels.cache.get(newChannelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                try {
                    const { recordBotEdit } = await import('../events/channelUpdate');
                    recordBotEdit(newChannelId);
                    await vcnsBridge.editPermission({
                        guild,
                        channelId: newChannelId,
                        targetId: member.id,
                        permissions: {
                            ViewChannel: true,
                            Connect: true,
                        },
                    });
                    console.log(`[VCNS-ACCESS] ✅ Added Discord permissions for permanent access user ${member.user.tag}`);
                } catch (err) {
                    console.error(`[VCNS-ACCESS] ❌ Failed to set Discord permissions:`, err);
                }
            }
        }
        
        return false; 
    }
    console.log(`[VCNS-ACCESS] 🎟️ Checking channel permits for ${member.user.tag}, permissions count: ${dbPermissions.length}`);
    if (dbPermissions.length > 0) {
        console.log(`[VCNS-ACCESS] 🎟️ All permissions in DB:`, dbPermissions.map((p: any) => `${p.targetId}:${p.permission}`).join(', '));
    }
    
    // Check for channel permits (includes both permanent !au permits and temporary lock/hide permits)
    const hasDirectPermit = dbPermissions.some(
        (p: any) => p.targetId === member.id && p.permission === 'permit'
    );
    const hasRolePermit = dbPermissions.some(
        (p: any) => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    const hasChannelPermit = hasDirectPermit || hasRolePermit;
    
    console.log(`[VCNS-ACCESS] 🎟️ Permit check for ${member.id}: direct=${hasDirectPermit}, role=${hasRolePermit}, has=${hasChannelPermit}`);
    
    if (hasChannelPermit) {
        console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} has CHANNEL PERMIT (permanent !au OR temporary lock/hide) - bypass all restrictions`);
        return false;
    }
    console.log(`[VCNS-ACCESS] ⚙️ Loading guild settings for admin strictness...`);
    const isTeamChannel = 'teamType' in dbState;
    const [pvcSettings, teamSettings, whitelist] = await Promise.all([
        getGuildSettings(guild.id),
        prisma.teamVoiceSettings.findUnique({ where: { guildId: guild.id } }),
        getWhitelist(guild.id),
    ]);
    const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');
    const strictnessEnabled = isTeamChannel ? teamSettings?.adminStrictness : pvcSettings?.adminStrictness;
    const isWhitelisted = whitelist.some(
        w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
    );
    
    // Admin whitelist bypass ALL restrictions (strictness will NEVER work on them)
    if (isWhitelisted) {
        console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} is WHITELISTED - bypass ALL restrictions (strictness/locked/hidden/full)`);
        
        // Add Discord permission overwrites if channel is locked/hidden
        if (dbState.isLocked || dbState.isHidden) {
            const channel = guild.channels.cache.get(newChannelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                try {
                    const { recordBotEdit } = await import('../events/channelUpdate');
                    recordBotEdit(newChannelId);
                    await vcnsBridge.editPermission({
                        guild,
                        channelId: newChannelId,
                        targetId: member.id,
                        permissions: {
                            ViewChannel: true,
                            Connect: true,
                        },
                    });
                    console.log(`[VCNS-ACCESS] ✅ Added Discord permissions for whitelisted user ${member.user.tag}`);
                } catch (err) {
                    console.error(`[VCNS-ACCESS] ❌ Failed to set Discord permissions:`, err);
                }
            }
        }
        
        return false;
    }
    
    const isLocked = dbState.isLocked;
    const isHidden = dbState.isHidden;
    let isFull = false;
    let actualMembers = 0;
    if ('teamType' in dbState && dbState.teamType) {
        const teamTypeLower = (dbState.teamType as string).toLowerCase() as keyof typeof TEAM_USER_LIMITS;
        const teamLimit = TEAM_USER_LIMITS[teamTypeLower];
        if (teamLimit) {
            const voiceChannel = newState.channel;
            if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
                actualMembers = voiceChannel.members.size;
                isFull = actualMembers > teamLimit;
            }
        }
    } else {
        const voiceChannel = newState.channel;
        if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
            actualMembers = voiceChannel.members.size;
            isFull = dbState.userLimit > 0 && actualMembers > dbState.userLimit;
        }
    }
    const isRestricted = isLocked || isHidden || isFull;
    console.log(`[VCNS-ACCESS] 👨‍💼 Admin evaluation for ${member.user.tag}:`, {
        hasAdminPerm,
        strictnessEnabled: !!strictnessEnabled,
        isWhitelisted,
        isTeamChannel,
        hasChannelPermit,
        isLocked,
        isHidden,
        isFull,
        isRestricted
    });
    
    // Admin strictness: Only enforce for LOCKED or HIDDEN channels, not for full channels
    // Unlocked channels should allow admins even without permits
    const needsStrictnessCheck = strictnessEnabled && (isLocked || isHidden);
    
    if (needsStrictnessCheck) {
        if (isWhitelisted || hasChannelPermit) {
            console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} is ${isWhitelisted ? 'WHITELISTED' : 'has CHANNEL PERMIT'} - access granted (strictness ON, channel restricted)`);
            return false; 
        }
        
        console.log(`[VCNS-ACCESS] 🚨 STRICTNESS VIOLATION: ${member.user.tag} is NOT whitelisted/permitted, channel is restricted - INSTANT KICK`);
        const channelTypeName = isTeamChannel ? 'team voice channel' : 'voice channel';
        const restrictionReason = isLocked ? 'locked' : 'hidden';
        try {
            await vcnsBridge.kickUser({
                guild,
                channelId: newChannelId,
                userId: member.id,
                reason: `Admin strictness: not whitelisted (channel ${restrictionReason})`,
                isImmediate: true, 
            });
        } catch (err) {
            console.error(`[VCNS-ACCESS] ❌ Failed to kick non-whitelisted user ${member.id}:`, err);
        }
        console.log(`[VCNS-ACCESS] ✅ Strictness enforcement - ${member.user.tag} KICKED (not whitelisted, channel ${restrictionReason})`);
        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setDescription(
                `You don't have access to **${channel.name}**.\n\nAsk **${ownerName}** to give you access.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => { });
        logAction({
            action: LogAction.USER_REMOVED,
            guild: guild,
            user: member.user,
            channelName: channel.name,
            channelId: newChannelId,
            details: `No access`,
            isTeamChannel: isTeamChannel,
        }).catch(() => { });
        return true;
    }
    console.log(`[VCNS-ACCESS] 🔒 Channel restrictions:`, {
        isLocked,
        isHidden,
        isFull,
        userLimit: dbState.userLimit
    });
    if (!isRestricted) {
        console.log(`[VCNS-ACCESS] ✅ Channel is open and not full - access granted for ${member.user.tag}`);
        return false;
    }
    console.log(`[VCNS-ACCESS] 🔍 User ${member.user.tag} has no permits and channel is restricted (strictness OFF)`);
    if (isFull) {
        console.log(`[VCNS-ACCESS] 🚫 Channel is FULL - kicking ${member.user.tag} (no AU or permanent access)`);
        const reason = 'at capacity';
        const channelTypeName = isTeamChannel ? 'team voice channel' : 'voice channel';
        try {
            await vcnsBridge.kickUser({
                guild,
                channelId: newChannelId,
                userId: member.id,
                reason: 'Channel at capacity',
                isImmediate: false, 
            });
        } catch (err) {
            console.error(`[VCNS-ACCESS] ❌ Failed to kick user at capacity ${member.id}:`, err);
        }
        console.log(`[VCNS-ACCESS] ✅ Capacity violation - ${member.user.tag} kick initiated`);
        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setDescription(
                `You don't have access to **${channel.name}**.\n\nAsk **${ownerName}** to give you access.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => { });
        logAction({
            action: LogAction.USER_REMOVED,
            guild: guild,
            user: member.user,
            channelName: channel.name,
            channelId: newChannelId,
            details: `Channel ${reason}`,
            isTeamChannel: isTeamChannel,
        }).catch(() => { });
        return true;
    }
    if (!isLocked && !isHidden) {
        console.log(`[VCNS-ACCESS] ✅ Channel is not locked or hidden - access granted for ${member.user.tag}`);
        return false;
    }
    const reason = isLocked ? 'locked' : 'hidden';
    console.log(`[VCNS-ACCESS] 🚫 FINAL DECISION: Kicking ${member.user.tag} - Channel is ${reason}, no AU or permanent access`);
    const channelTypeName = isTeamChannel ? 'team voice channel' : 'voice channel';
    try {
        await vcnsBridge.kickUser({
            guild,
            channelId: newChannelId,
            userId: member.id,
            reason: 'Unauthorized access',
            isImmediate: false, 
        });
    } catch (err) {
        console.error(`[VCNS-ACCESS] ❌ Failed to kick unauthorized user ${member.id}:`, err);
    }
    console.log(`[VCNS-ACCESS] ✅ Unauthorized access - ${member.user.tag} kick initiated (reason: ${reason})`);
    const owner = guild.members.cache.get(ownerId);
    const ownerName = owner?.displayName || 'the owner';
    const embed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setDescription(
            `You don't have access to **${channel.name}**.\n\nAsk **${ownerName}** to give you access.`
        )
        .setTimestamp();
    member.send({ embeds: [embed] }).catch(() => { });
    logAction({
        action: LogAction.USER_REMOVED,
        guild: guild,
        user: member.user,
        channelName: channel.name,
        channelId: newChannelId,
        details: `Channel ${reason}`,
        isTeamChannel: false, 
    }).catch(() => { });
    return true;
}
async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;
    console.log(`[VCNS-HANDLEJOIN] 📌 Processing join for ${member.user.tag} in channel ${channelId}`);
    let isInterface = isInterfaceChannel(channelId);
    console.log(`[VCNS-HANDLEJOIN] 🔍 isInterfaceChannel(${channelId}) = ${isInterface}`);
    if (!isInterface) {
        const settings = await getGuildSettings(guild.id);
        console.log(`[VCNS-HANDLEJOIN] 🔍 Guild settings interfaceVcId = ${settings?.interfaceVcId}`);
        if (settings?.interfaceVcId === channelId) {
            registerInterfaceChannel(guild.id, channelId);
            isInterface = true;
            console.log(`[VCNS-HANDLEJOIN] ✅ Registered ${channelId} as interface channel`);
        }
    }
    if (isInterface) {
        console.log(`[VCNS-HANDLEJOIN] 🎯 Channel IS an interface - checking PVC pause status`);
        if (isPvcPaused(guild.id)) {
            console.log(`[VCNS-HANDLEJOIN] ⏸️ PVC is PAUSED - disconnecting user`);
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
        console.log(`[VCNS-HANDLEJOIN] 🚀 Calling createPrivateChannel for ${member.user.tag}`);
        await createPrivateChannel(client, state);
        console.log(`[VCNS-HANDLEJOIN] ✅ createPrivateChannel completed for ${member.user.tag}`);
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
    
    console.log(`[HandleLeave] User ${member?.user?.username} (${member?.id}) left channel ${channelId}`);
    
    // Clean up temporary lock permits when user leaves
    // ONLY remove if they were in the temp permit tracking (added during lock operation)
    // Do NOT remove permits added by !au command
    if (member) {
        const { hasTempLockPermit, removeTempLockPermit } = await import('../utils/voiceManager');
        
        if (hasTempLockPermit(channelId, member.id)) {
            console.log(`[HandleLeave] 🔓 Removing temporary lock permit for ${member.user.tag} (${member.id})`);
            
            // Remove from memory tracking ONLY
            removeTempLockPermit(channelId, member.id);
            
            // Do NOT remove from database - user may have been explicitly added with !au
            // which should persist even after they leave
            console.log(`[HandleLeave] ℹ️ Kept permit in DB (may be from !au command)`);
        }
    }
    
    // Handle temp drag permissions
    if (member && hasTempDragPermission(channelId, member.id)) {
        const pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
        const ownerId = pvcData?.ownerId || teamData?.ownerId;
        
        // Check if user should KEEP their permissions
        const hasPermanentAccess = ownerId ? stateStore.hasPermanentAccess(guild.id, ownerId, member.id) : false;
        const whitelist = await getWhitelist(guild.id);
        const memberRoleIds = member.roles.cache.map(r => r.id);
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        
        // Check if user has explicit AU permit
        let hasAUPermit = false;
        if (pvcData) {
            const existingPermits = await prisma.voicePermission.findMany({
                where: { channelId, targetId: member.id, permission: 'permit' }
            });
            hasAUPermit = existingPermits.length > 0;
        } else if (teamData) {
            const existingPermits = await prisma.teamVoicePermission.findMany({
                where: { channelId, targetId: member.id, permission: 'permit' }
            });
            hasAUPermit = existingPermits.length > 0;
        }
        
        // Only remove drag permissions if user doesn't have permanent access, AU, or admin whitelist
        if (hasPermanentAccess || isWhitelisted || hasAUPermit) {
            console.log(`[HandleLeave] ✅ User ${member.user.tag} has permanent access/AU/whitelist - KEEPING drag permit`);
        } else {
            console.log(`[HandleLeave] 🗑️ Removing temp drag permit for ${member.user.tag}`);
            if (pvcData) {
                await prisma.voicePermission.deleteMany({
                    where: {
                        channelId,
                        targetId: member.id,
                        permission: 'permit',
                    },
                }).catch(() => {});
            } else if (teamData) {
                await prisma.teamVoicePermission.deleteMany({
                    where: {
                        channelId,
                        targetId: member.id,
                        permission: 'permit',
                    },
                }).catch(() => {});
            }
        }
        
        removeTempDragPermission(channelId, member.id);
        invalidateChannelPermissions(channelId);
    }
    let channelState = getChannelState(channelId);
    if (!channelState) {
        console.log(`[HandleLeave] Channel ${channelId} not in memory, checking database...`);
        const dbChannel = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (dbChannel) {
            console.log(`[HandleLeave] Found channel in DB, owner: ${dbChannel.ownerId}. Registering in memory.`);
            const { registerChannel } = await import('../utils/voiceManager');
            registerChannel(channelId, dbChannel.guildId, dbChannel.ownerId);
            channelState = getChannelState(channelId);
        }
    }
    console.log(`[HandleLeave] channelState: ${channelState ? `owner=${channelState.ownerId}` : 'null'}`);
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
                    console.log(`[HandleLeave] 👑 Owner ${member.user.tag} (${member.id}) left channel ${channelId}`);
                    console.log(`[HandleLeave] Channel has ${channel.members.size} members remaining`);
                    const nonBotMembers = channel.members.filter((m: any) => !m.user.bot);
                    console.log(`[HandleLeave] Found ${nonBotMembers.size} non-bot members for transfer`);
                    if (nonBotMembers.size > 0) {
                        console.log(`[HandleLeave] Initiating ownership transfer...`);
                        await transferChannelOwnership(client, channelId, guild, channel);
                    } else {
                        console.log(`[HandleLeave] No non-bot members available, channel will be deleted`);
                        await logAction({
                            action: LogAction.CHANNEL_DELETED,
                            guild: guild,
                            channelName: channel.name,
                            channelId: channelId,
                            details: `Owner left, no members to transfer to`,
                        });
                        await deletePrivateChannel(channelId, guild.id);
                    }
                } else {
                    console.log(`[HandleLeave] Non-owner left. Member: ${member?.id}, Owner: ${channelState.ownerId}`);
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
        return;
    }
    const dbPvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    const dbTeam = !dbPvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
    if (dbPvc || dbTeam) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildVoice) return;
        const isTeamChannel = Boolean(dbTeam);
        const ownerId = dbPvc?.ownerId || dbTeam?.ownerId;
        if (dbPvc) {
            registerChannel(channelId, guild.id, dbPvc.ownerId);
        } else if (dbTeam) {
            registerTeamChannel(channelId, guild.id, dbTeam.ownerId, dbTeam.teamType.toLowerCase() as TeamType);
        }
        if (channel.members.size === 0) {
            if (isTeamChannel) {
                await logAction({
                    action: LogAction.TEAM_CHANNEL_DELETED,
                    guild: guild,
                    channelName: channel.name,
                    channelId: channelId,
                    details: `Team channel deleted (empty - DB fallback)`,
                    isTeamChannel: true,
                    teamType: dbTeam?.teamType.toLowerCase(),
                });
                await deleteTeamChannel(channelId, guild.id);
            } else {
                await logAction({
                    action: LogAction.CHANNEL_DELETED,
                    guild: guild,
                    channelName: channel.name,
                    channelId: channelId,
                    details: `Channel deleted (empty - DB fallback)`,
                });
                await deletePrivateChannel(channelId, guild.id);
            }
        } else {
            const allBots = channel.members.every(m => m.user.bot);
            if (allBots && channel.members.size > 0) {
                for (const [, botMember] of channel.members) {
                    await botMember.voice.disconnect().catch(() => { });
                }
                if (isTeamChannel) {
                    await deleteTeamChannel(channelId, guild.id);
                } else {
                    await deletePrivateChannel(channelId, guild.id);
                }
            } else if (member && ownerId === member.id) {
                if (isTeamChannel) {
                    await transferTeamChannelOwnership(client, channelId, guild, channel);
                } else {
                    await transferChannelOwnership(client, channelId, guild, channel);
                }
            }
        }
    }
}
async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;
    if (!member || !interfaceChannel) {
        console.log(`[VCNS-CREATE] ❌ No member or interfaceChannel - aborting`);
        return;
    }
    console.log(`[VCNS-CREATE] 🔐 Acquiring creation lock for ${member.user.tag}...`);
    const lockAcquired = await acquireCreationLock(guild.id, member.id);
    if (!lockAcquired) {
        console.log(`[VCNS-CREATE] ❌ Lock NOT acquired for ${member.user.tag} - disconnecting`);
        try {
            await member.voice.disconnect();
        } catch { }
        return;
    }
    console.log(`[VCNS-CREATE] ✅ Lock acquired for ${member.user.tag}`);
    try {
        if (isOnCooldown(member.id, 'CREATE_CHANNEL')) {
            console.log(`[VCNS-CREATE] ⏳ User ${member.user.tag} is on cooldown - disconnecting`);
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
        console.log(`[VCNS-CREATE] 🔍 Existing channel check: ${existingChannel || 'none'} (type: ${existingType})`);
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
                    }
                    releaseCreationLock(guild.id, member.id);
                    return;
                } else {
                    if (existingType === 'Team') {
                        unregisterTeamChannel(existingChannel);
                        await prisma.teamVoiceChannel.deleteMany({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    } else {
                        unregisterChannel(existingChannel);
                        await prisma.privateVoiceChannel.deleteMany({
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
        console.log(`[VCNS-CREATE] 🏗️ Calling vcnsBridge.createVC for ${member.user.tag}...`);
        console.log(`[VCNS-CREATE] 📝 parentId: ${interfaceChannel.parent?.id}`);
        const createResult = await vcnsBridge.createVC({
            guild,
            ownerId: member.id,
            channelName: member.displayName,
            parentId: interfaceChannel.parent?.id,
            permissionOverwrites,
            isTeam: false,
        });
        console.log(`[VCNS-CREATE] 📊 createVC result:`, JSON.stringify(createResult, null, 2));
        if (!createResult || !createResult.channelId) {
            console.log(`[VCNS-CREATE] ❌ No channelId returned - disconnecting user`);
            releaseCreationLock(guild.id, member.id);
            try {
                await member.voice.disconnect();
            } catch { }
            return;
        }
        let newChannel = guild.channels.cache.get(createResult.channelId);
        if (!newChannel) {
            try {
                newChannel = await guild.channels.fetch(createResult.channelId) as any;
            } catch {
                console.log(`[VCNS-CREATE] ❌ Could not fetch created channel ${createResult.channelId}`);
            }
        }
        if (!newChannel || !newChannel.isVoiceBased()) {
            console.log(`[VCNS-CREATE] ❌ Channel not found or not voice-based`);
            releaseCreationLock(guild.id, member.id);
            return;
        }
        recordBotEdit(newChannel.id);
        registerChannel(newChannel.id, guild.id, member.id);
        addUserToJoinOrder(newChannel.id, member.id);
        releaseCreationLock(guild.id, member.id);
        console.log(`[VCNS-CREATE] 🚚 Moving user ${member.user.tag} to new channel ${newChannel.id}`);
        const freshMember = await guild.members.fetch(member.id);
        if (!freshMember.voice.channelId) {
            console.log(`[VCNS-CREATE] ❌ User left voice before move - cleaning up`);
            await newChannel.delete().catch(() => {});
            unregisterChannel(newChannel.id);
            return;
        }
        await freshMember.voice.setChannel(newChannel);
        console.log(`[VCNS-CREATE] ✅ User moved successfully`);
        (async () => {
            try {
                if (savedPermissions.length > 0) {
                    await prisma.voicePermission.createMany({
                        data: savedPermissions.map(p => ({
                            channelId: newChannel.id,
                            targetId: p.targetId,
                            targetType: p.targetType,
                            permission: p.permission,
                        })),
                        skipDuplicates: true,
                    }).catch(err => {
                        console.error(`[VCNS-CREATE] Failed to add permissions to DB:`, err);
                    });
                }
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
                await logAction({
                    action: LogAction.CHANNEL_CREATED,
                    guild: guild,
                    user: member.user,
                    channelName: newChannel.name,
                    channelId: newChannel.id,
                    details: `Private voice channel created`,
                });
            } catch (err) {
                console.error(`[VCNS-CREATE] Background tasks error:`, err);
            }
        })();
        (async () => {
            try {
                const ownerPermissions = await getCachedOwnerPerms(guild.id, member.id);
                if (ownerPermissions.length > 0) {
                    console.log(`[VCNS-CREATE] 🔑 Applying ${ownerPermissions.length} permanent access grants for owner ${member.user.tag}`);
                    
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
                        console.log(`[VCNS-CREATE] 🗑️ Removing ${invalidTargetIds.length} invalid permanent access grants`);
                        await prisma.ownerPermission.deleteMany({
                            where: {
                                guildId: guild.id,
                                ownerId: member.id,
                                targetId: { in: invalidTargetIds },
                            },
                        }).catch(() => { });
                    }
                    
                    if (validPermissions.length > 0) {
                        console.log(`[VCNS-CREATE] ✅ Applying ${validPermissions.length} valid permanent access grants`);
                        recordBotEdit(newChannel.id);
                        
                        // Apply Discord permissions
                        for (const perm of validPermissions) {
                            await vcnsBridge.editPermission({
                                guild,
                                channelId: newChannel.id,
                                targetId: perm.targetId,
                                permissions: {
                                    ViewChannel: true,
                                    Connect: true,
                                },
                            });
                        }
                        
                        // Also add to database as permanent permits (not temporary)
                        // Use upsert to avoid duplicate key errors
                        for (const perm of validPermissions) {
                            await prisma.voicePermission.upsert({
                                where: {
                                    channelId_targetId: {
                                        channelId: newChannel.id,
                                        targetId: perm.targetId,
                                    },
                                },
                                update: {
                                    permission: 'permit',
                                    targetType: perm.targetType,
                                },
                                create: {
                                    channelId: newChannel.id,
                                    targetId: perm.targetId,
                                    targetType: perm.targetType,
                                    permission: 'permit',
                                },
                            }).catch((err) => {
                                console.error(`[VCNS-CREATE] Failed to upsert DB permit for ${perm.targetId}:`, err);
                            });
                        }
                        
                        invalidateChannelPermissions(newChannel.id);
                        console.log(`[VCNS-CREATE] ✅ Permanent access grants applied successfully`);
                    }
                }
            } catch (err) {
                console.error(`[VCNS-CREATE] Owner permissions error:`, err);
            }
        })();
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
        console.log(`[TransferOwnership] 🔄 Starting transfer for channel ${channelId}`);
        console.log(`[TransferOwnership] Channel members count: ${channel.members.size}`);
        const currentState = getChannelState(channelId);
        const teamState = getTeamChannelState(channelId);
        const oldOwnerId = currentState?.ownerId || teamState?.ownerId;
        console.log(`[TransferOwnership] Old owner ID: ${oldOwnerId}`);
        let nextUserId = getNextUserInOrder(channelId);
        console.log(`[TransferOwnership] Next in join order: ${nextUserId || 'none'}`);
        if (!nextUserId && channel.members.size > 0) {
            const availableMember = channel.members.find((m: any) => m.id !== oldOwnerId && !m.user.bot);
            if (availableMember) {
                nextUserId = availableMember.id;
                console.log(`[TransferOwnership] ✅ Found available member as fallback: ${nextUserId} (${availableMember.user.tag})`);
            }
        }
        if (!nextUserId) {
            console.log(`[TransferOwnership] ❌ No next user found, cannot transfer`);
            return;
        }
        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            console.log(`[TransferOwnership] ❌ Could not find member ${nextUserId} in guild cache`);
            return;
        }
        console.log(`[TransferOwnership] 👤 Transferring to ${newOwner.user.tag} (${newOwner.displayName})`);
        const isTeamChannel = Boolean(teamState);
        if (currentState) {
            transferOwnership(channelId, nextUserId);
            console.log(`[TransferOwnership] ✅ Updated PVC memory state`);
        }
        if (teamState) {
            transferTeamOwnership(channelId, nextUserId);
            console.log(`[TransferOwnership] ✅ Updated Team memory state`);
        }
        if (isTeamChannel && teamState) {
            await prisma.teamVoiceChannel.update({
                where: { channelId },
                data: { ownerId: nextUserId },
            });
            console.log(`[TransferOwnership] ✅ Updated DB owner for Team channel`);
        } else {
            // Check if channel exists in DB before updating
            const channelExists = await prisma.privateVoiceChannel.findUnique({
                where: { channelId },
            });
            
            if (channelExists) {
                await prisma.privateVoiceChannel.update({
                    where: { channelId },
                    data: { ownerId: nextUserId },
                });
                console.log(`[TransferOwnership] ✅ Updated DB owner for PVC channel`);
            } else {
                console.log(`[TransferOwnership] ⚠️ Channel ${channelId} not in DB, registering it now...`);
                // Re-register the channel
                const channelState = getChannelState(channelId);
                if (channelState) {
                    await prisma.privateVoiceChannel.create({
                        data: {
                            channelId,
                            ownerId: nextUserId,
                            guildId: guild.id,
                            isLocked: channelState.isLocked || false,
                            isHidden: channelState.isHidden || false,
                        },
                    });
                    console.log(`[TransferOwnership] ✅ Re-registered and updated DB owner for PVC channel`);
                } else {
                    console.error(`[TransferOwnership] ❌ Cannot transfer - channel not in memory either`);
                    throw new Error('Channel not in memory or database');
                }
            }
        }
        recordBotEdit(channelId);
        if (oldOwnerId) {
            try {
                await channel.permissionOverwrites.delete(oldOwnerId);
                console.log(`[TransferOwnership] ✅ Removed old owner ${oldOwnerId} permissions`);
            } catch (err) {
                console.log(`[TransferOwnership] ⚠️ Failed to remove old owner permissions:`, err);
            }
        }
        try {
            await channel.permissionOverwrites.edit(newOwner, {
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
            console.log(`[TransferOwnership] ✅ Granted new owner ${nextUserId} full permissions`);
        } catch (permErr) {
            console.error(`[TransferOwnership] ❌ Failed to set new owner permissions:`, permErr);
        }
        try {
            await channel.setName(newOwner.displayName);
            console.log(`[TransferOwnership] ✅ Renamed channel to: ${newOwner.displayName}`);
        } catch (err) {
            console.log(`[TransferOwnership] ⚠️ Failed to rename channel:`, err);
        }
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
            console.log(`[TransferOwnership] ✅ Sent notification embed`);
        } catch (sendErr) {
            console.log(`[TransferOwnership] ⚠️ Failed to send notification:`, sendErr);
        }
        console.log(`[TransferOwnership] ✅ Transfer completed successfully`);
    } catch (err) {
        console.error(`[TransferOwnership] ❌ Error during ownership transfer:`, err);
    }
}
async function deletePrivateChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            unregisterChannel(channelId);
            await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
            await prisma.voicePermission.deleteMany({ where: { channelId } }).catch(() => { });
            return;
        }
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
            try {
                channel = await guild.channels.fetch(channelId) as any;
            } catch {
            }
        }
        if (channel?.isVoiceBased()) {
            try {
                await vcnsBridge.deleteVC({
                    guild,
                    channelId,
                    isTeam: false,
                });
            } catch (err) {
                console.error(`[DeletePVC] Failed to delete channel from Discord:`, err);
            }
        }
        // Clean up memory state FIRST before DB
        unregisterChannel(channelId);
        invalidateChannelPermissions(channelId);
        
        // Then clean up database (use deleteMany to avoid errors if already deleted)
        await prisma.voicePermission.deleteMany({ where: { channelId } }).catch(() => { });
        await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
        
        console.log(`[DeletePVC] ✅ Channel ${channelId} fully cleaned up`);
    } catch (err) {
        console.error(`[DeletePVC] Error:`, err);
        // Still clean up memory even if DB cleanup fails
        unregisterChannel(channelId);
        invalidateChannelPermissions(channelId);
        
        await prisma.voicePermission.deleteMany({ where: { channelId } }).catch(() => { });
        await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
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
                        await prisma.teamVoiceChannel.deleteMany({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    } else {
                        unregisterChannel(existingChannel);
                        await prisma.privateVoiceChannel.deleteMany({
                            where: { channelId: existingChannel },
                        }).catch(() => { });
                    }
                }
            }
        }
        setCooldown(member.id, 'CREATE_CHANNEL');
        const userLimit = TEAM_USER_LIMITS[teamType];
        const ownerPerms = getOwnerPermissions();
        const createResult = await vcnsBridge.createVC({
            guild,
            ownerId: member.id,
            channelName: `${member.displayName}'s ${teamType.charAt(0).toUpperCase() + teamType.slice(1)}`,
            parentId: interfaceChannel.parent?.id,
            userLimit: userLimit,
            permissionOverwrites: [
                {
                    id: member.id,
                    allow: ownerPerms.allow,
                    deny: ownerPerms.deny,
                },
            ],
            isTeam: true,
            teamType: teamType,
        });
        if (!createResult || !createResult.channelId) {
            releaseCreationLock(guild.id, member.id);
            try {
                await member.voice.disconnect();
            } catch { }
            return;
        }
        const newChannel = guild.channels.cache.get(createResult.channelId);
        if (!newChannel || !newChannel.isVoiceBased()) {
            releaseCreationLock(guild.id, member.id);
            return;
        }
        recordBotEdit(newChannel.id);
        registerTeamChannel(newChannel.id, guild.id, member.id, teamType);
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
        
        // Apply permanent access grants in background
        (async () => {
            try {
                const ownerPermissions = await getCachedOwnerPerms(guild.id, member.id);
                if (ownerPermissions.length > 0) {
                    console.log(`[TEAM-CREATE] 🔑 Applying ${ownerPermissions.length} permanent access grants for owner ${member.user.tag}`);
                    
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
                        console.log(`[TEAM-CREATE] 🗑️ Removing ${invalidTargetIds.length} invalid permanent access grants`);
                        await prisma.ownerPermission.deleteMany({
                            where: {
                                guildId: guild.id,
                                ownerId: member.id,
                                targetId: { in: invalidTargetIds },
                            },
                        }).catch(() => { });
                    }
                    
                    if (validPermissions.length > 0) {
                        console.log(`[TEAM-CREATE] ✅ Applying ${validPermissions.length} valid permanent access grants`);
                        recordBotEdit(newChannel.id);
                        
                        // Apply Discord permissions
                        for (const perm of validPermissions) {
                            await vcnsBridge.editPermission({
                                guild,
                                channelId: newChannel.id,
                                targetId: perm.targetId,
                                permissions: {
                                    ViewChannel: true,
                                    Connect: true,
                                },
                            });
                        }
                        
                        // Also add to database as permanent permits
                        for (const perm of validPermissions) {
                            await prisma.teamVoicePermission.create({
                                data: {
                                    channelId: newChannel.id,
                                    targetId: perm.targetId,
                                    targetType: perm.targetType,
                                    permission: 'permit',
                                },
                            }).catch((err) => {
                                // Ignore if already exists
                                if (!err.message?.includes('Unique constraint')) {
                                    console.error(`[TEAM-CREATE] Failed to add DB permit for ${perm.targetId}:`, err);
                                }
                            });
                        }
                        
                        invalidateChannelPermissions(newChannel.id);
                        console.log(`[TEAM-CREATE] ✅ Permanent access grants applied successfully`);
                    }
                }
            } catch (err) {
                console.error(`[TEAM-CREATE] Owner permissions error:`, err);
            }
        })();
        
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
            await prisma.teamVoiceChannel.deleteMany({ where: { channelId: newChannel.id } }).catch(() => { });
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
            await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
            await prisma.teamVoicePermission.deleteMany({ where: { channelId } }).catch(() => { });
            return;
        }
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
            try {
                channel = await guild.channels.fetch(channelId) as any;
            } catch {
            }
        }
        if (channel?.isVoiceBased()) {
            try {
                await vcnsBridge.deleteVC({
                    guild,
                    channelId,
                    isTeam: true,
                });
            } catch (err) {
                console.error(`[DeleteTeam] Failed to delete channel from Discord:`, err);
            }
        }
        unregisterTeamChannel(channelId);
        await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
        await prisma.teamVoicePermission.deleteMany({ where: { channelId } }).catch(() => { });
    } catch (err) {
        console.error(`[DeleteTeam] Error:`, err);
        unregisterTeamChannel(channelId);
        await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
        await prisma.teamVoicePermission.deleteMany({ where: { channelId } }).catch(() => { });
    }
}
async function transferTeamChannelOwnership(
    client: PVCClient,
    channelId: string,
    guild: any,
    channel: any
): Promise<void> {
    try {
        console.log(`[TransferTeamOwnership] 🔄 Starting transfer for Team channel ${channelId}`);
        const teamState = getTeamChannelState(channelId);
        const oldOwnerId = teamState?.ownerId;
        console.log(`[TransferTeamOwnership] Old owner ID: ${oldOwnerId}`);
        let nextUserId = getNextUserInOrder(channelId);
        console.log(`[TransferTeamOwnership] Next in join order: ${nextUserId || 'none'}`);
        if (!nextUserId && channel.members.size > 0) {
            const availableMember = channel.members.find((m: any) => m.id !== oldOwnerId && !m.user.bot);
            if (availableMember) {
                nextUserId = availableMember.id;
                console.log(`[TransferTeamOwnership] ✅ Found available member: ${nextUserId}`);
            }
        }
        if (!nextUserId) {
            console.log(`[TransferTeamOwnership] ❌ No next user found, cannot transfer`);
            return;
        }
        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            console.log(`[TransferTeamOwnership] ❌ Member ${nextUserId} not in guild cache`);
            return;
        }
        console.log(`[TransferTeamOwnership] 👤 Transferring to ${newOwner.user.tag}`);
        transferTeamOwnership(channelId, nextUserId);
        console.log(`[TransferTeamOwnership] ✅ Updated memory state`);
        await prisma.teamVoiceChannel.update({
            where: { channelId },
            data: { ownerId: nextUserId },
        });
        console.log(`[TransferTeamOwnership] ✅ Updated DB owner`);
        recordBotEdit(channelId);
        if (oldOwnerId) {
            try {
                await channel.permissionOverwrites.delete(oldOwnerId);
                console.log(`[TransferTeamOwnership] ✅ Removed old owner permissions`);
            } catch (err) {
                console.log(`[TransferTeamOwnership] ⚠️ Failed to remove old owner perms:`, err);
            }
        }
        try {
            await channel.permissionOverwrites.edit(newOwner, {
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
            console.log(`[TransferTeamOwnership] ✅ Granted new owner permissions`);
        } catch (permErr) {
            console.error(`[TransferTeamOwnership] ❌ Failed to set permissions:`, permErr);
        }
        const teamType = teamState?.teamType || 'Team';
        const teamTypeName = teamType.charAt(0).toUpperCase() + teamType.slice(1).toLowerCase();
        try {
            await channel.setName(`${newOwner.displayName}'s ${teamTypeName}`);
            console.log(`[TransferTeamOwnership] ✅ Renamed channel`);
        } catch (err) {
            console.log(`[TransferTeamOwnership] ⚠️ Failed to rename:`, err);
        }
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

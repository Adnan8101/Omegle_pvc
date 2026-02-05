import { ChannelType, Events, type VoiceState, EmbedBuilder, AuditLogEvent, AttachmentBuilder, VoiceChannel } from 'discord.js';
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
        try {
            const wasKicked = await handleAccessProtection(client, newState);
            if (!wasKicked) {
                console.log(`[VCNS-JOIN] ✅ User ${member.user.tag} successfully joined - processing handleJoin`);
                await handleJoin(client, newState);
            } else {
                console.log(`[VCNS-JOIN] ❌ User ${member.user.tag} was kicked by access protection`);
            }
        } catch (err) {
            console.error(`[VCNS-JOIN] ❌ Critical error in handleJoin sequence:`, err);
        }
    }
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        try {
            await handleLeave(client, oldState);
        } catch (err) {
            console.error(`[VCNS-LEAVE] ❌ Critical error in handleLeave sequence:`, err);
        }
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
    let channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        try {
            const fetched = await guild.channels.fetch(newChannelId);
            if (fetched && fetched.type === ChannelType.GuildVoice) {
                channel = fetched as unknown as VoiceChannel;
            }
        } catch (error) {
            console.error(`[VCNS-ACCESS] ❌ Failed to fetch channel ${newChannelId} for access check:`, error);
        }
    }
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        console.log(`[VCNS-ACCESS] ⚠️ Channel ${newChannelId} is MANAGED (in DB) but unreachable (not in cache/fetch failed).`);
        console.log(`[VCNS-ACCESS] 🛡️ FAIL-SAFE: Kicking user ${member.user.tag} to prevent security bypass.`);
        try {
            await member.voice.disconnect('Security check failed - Channel state unknown');
            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setDescription(
                    `You were disconnected from **${newChannelId}** because the bot could not verify channel state.\n` +
                    `Please try joining again in a moment.`
                )
                .setTimestamp();
            member.send({ embeds: [embed] }).catch(() => { });
        } catch (kickErr) {
            console.error(`[VCNS-ACCESS] Failed to kick user during fail-safe:`, kickErr);
        }
        return true;
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
                    allowWhenHealthy: true,
                });
                console.log(`[VCNS-ACCESS] ✅ Synced Discord permissions for permanent access user ${member.user.tag}`);
            } catch (err) {
                console.error(`[VCNS-ACCESS] ❌ Failed to set Discord permissions:`, err);
            }
        }
        try {
            if ('teamType' in dbState) {
                await prisma.teamVoicePermission.upsert({
                    where: {
                        channelId_targetId: {
                            channelId: newChannelId,
                            targetId: member.id,
                        },
                    },
                    update: { permission: 'permit', targetType: 'user' },
                    create: {
                        channelId: newChannelId,
                        targetId: member.id,
                        targetType: 'user',
                        permission: 'permit',
                    },
                });
            } else {
                await prisma.voicePermission.upsert({
                    where: {
                        channelId_targetId: {
                            channelId: newChannelId,
                            targetId: member.id,
                        },
                    },
                    update: { permission: 'permit', targetType: 'user' },
                    create: {
                        channelId: newChannelId,
                        targetId: member.id,
                        targetType: 'user',
                        permission: 'permit',
                    },
                });
            }
            invalidateChannelPermissions(newChannelId);
            console.log(`[VCNS-ACCESS] ✅ Ensured DB permit for permanent access user ${member.user.tag}`);
        } catch (dbErr) {
            console.error(`[VCNS-ACCESS] ⚠️ Failed to ensure DB permit:`, dbErr);
        }
        return false;
    }
    console.log(`[VCNS-ACCESS] 🎟️ Checking channel permits for ${member.user.tag}, permissions count: ${dbPermissions.length}`);
    if (dbPermissions.length > 0) {
        console.log(`[VCNS-ACCESS] 🎟️ All permissions in DB:`, dbPermissions.map((p: any) => `${p.targetId}:${p.permission}`).join(', '));
    }
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
    const globalBlocks = await prisma.globalVCBlock.findMany({
        where: { guildId: guild.id, userId: member.id },
    });
    if (globalBlocks.length > 0) {
        console.log(`[VCNS-ACCESS] 🚫 User ${member.user.tag} is GLOBALLY BLOCKED - immediate kick`);
        return true; 
    }
    const channelBan = await (dbState.teamType 
        ? prisma.teamVoicePermission.findFirst({
            where: { channelId: newChannelId, targetId: member.id, permission: 'ban' }
        })
        : prisma.voicePermission.findFirst({
            where: { channelId: newChannelId, targetId: member.id, permission: 'ban' }
        })
    );
    if (channelBan) {
        console.log(`[VCNS-ACCESS] 🚫 User ${member.user.tag} is BANNED from this channel - immediate kick`);
        const ownerMember = await guild.members.fetch(ownerId).catch(() => null);
        const ownerName = ownerMember?.displayName || 'the owner';
        const blockEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🚫 Blocked from Voice Channel')
            .setDescription(
                `You are **blocked** from **${ownerName}**'s voice channel in **${guild.name}**.\n\n` +
                'You cannot join this channel by any means until you are unblocked.'
            )
            .setTimestamp();
        await member.send({ embeds: [blockEmbed] }).catch(() => {
            console.log(`[VCNS-ACCESS] Cannot DM blocked user ${member.user.tag}`);
        });
        return true; 
    }
    const results = await Promise.allSettled([
        getGuildSettings(guild.id),
        prisma.teamVoiceSettings.findUnique({ where: { guildId: guild.id } }),
        getWhitelist(guild.id),
    ]);
    const pvcSettings = results[0].status === 'fulfilled' ? results[0].value : null;
    const teamSettings = results[1].status === 'fulfilled' ? results[1].value : null;
    const whitelist = results[2].status === 'fulfilled' ? results[2].value : [];
    const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');
    const strictnessEnabled = isTeamChannel ? teamSettings?.adminStrictness : pvcSettings?.adminStrictness;
    const isWhitelisted = whitelist.some(
        w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
    );
    if (isWhitelisted) {
        console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} is WHITELISTED - bypass ALL restrictions (strictness/locked/hidden/full)`);
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
                    allowWhenHealthy: true, 
                });
                console.log(`[VCNS-ACCESS] ✅ Synced Discord permissions for whitelisted user ${member.user.tag}`);
            } catch (err) {
                console.error(`[VCNS-ACCESS] ❌ Failed to set Discord permissions:`, err);
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
    const needsStrictnessCheck = strictnessEnabled && (isLocked || isHidden);
    if (needsStrictnessCheck) {
        if (isWhitelisted || hasChannelPermit) {
            console.log(`[VCNS-ACCESS] ✅ User ${member.user.tag} is ${isWhitelisted ? 'WHITELISTED' : 'has CHANNEL PERMIT'} - bypass strictness (never kicked)`);
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
export async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
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
        if (ownedPvcChannel) {
            console.log(`[VCNS-HANDLEJOIN] ⚠️ User ${member.user.tag} already owns PVC ${ownedPvcChannel} - blocking team creation`);
            try {
                await member.voice.disconnect();
                const errorEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('❌ Cannot Create Team Channel')
                    .setDescription(
                        `You already own a Private Voice Channel.\n\n` +
                        'You can only own one voice channel at a time.\n' +
                        'Please delete your PVC first to create a team channel.'
                    )
                    .setTimestamp();
                await member.send({ embeds: [errorEmbed] }).catch(() => { });
            } catch { }
            return;
        }
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
    if (member) {
        const { hasTempLockPermit, removeTempLockPermit } = await import('../utils/voiceManager');
        if (hasTempLockPermit(channelId, member.id)) {
            console.log(`[HandleLeave] 🔓 Removing temporary lock permit for ${member.user.tag} (${member.id})`);
            removeTempLockPermit(channelId, member.id);
            const results = await Promise.allSettled([
                prisma.privateVoiceChannel.findUnique({ where: { channelId } }),
                prisma.teamVoiceChannel.findUnique({ where: { channelId } }),
            ]);
            const pvcData = results[0].status === 'fulfilled' ? results[0].value : null;
            const teamData = results[1].status === 'fulfilled' ? results[1].value : null;
            const ownerId = pvcData?.ownerId || teamData?.ownerId;
            if (ownerId) {
                const hasPermanentAccess = stateStore.hasPermanentAccess(guild.id, ownerId, member.id);
                if (!hasPermanentAccess) {
                    console.log(`[HandleLeave] 🗑️ Removing TEMP permit from DB for ${member.user.tag} (no permanent access)`);
                    try {
                        if (pvcData) {
                            await prisma.voicePermission.deleteMany({
                                where: {
                                    channelId,
                                    targetId: member.id,
                                    permission: 'permit'
                                }
                            });
                        } else if (teamData) {
                            await prisma.teamVoicePermission.deleteMany({
                                where: {
                                    channelId,
                                    targetId: member.id,
                                    permission: 'permit'
                                }
                            });
                        }
                        invalidateChannelPermissions(channelId);
                        console.log(`[HandleLeave] ✅ Temp permit removed from DB`);
                    } catch (err) {
                        console.error(`[HandleLeave] ⚠️ Failed to remove temp permit from DB:`, err);
                    }
                } else {
                    console.log(`[HandleLeave] ✅ User ${member.user.tag} has permanent access - keeping DB permit`);
                }
            }
        }
    }
    if (member && hasTempDragPermission(channelId, member.id)) {
        const results = await Promise.allSettled([
            prisma.privateVoiceChannel.findUnique({ where: { channelId } }),
            prisma.teamVoiceChannel.findUnique({ where: { channelId } }),
            getWhitelist(guild.id),
        ]);
        const pvcData = results[0].status === 'fulfilled' ? results[0].value : null;
        const teamData = results[1].status === 'fulfilled' ? results[1].value : null;
        const whitelist = results[2].status === 'fulfilled' ? results[2].value : [];
        const ownerId = pvcData?.ownerId || teamData?.ownerId;
        const hasPermanentAccess = ownerId ? stateStore.hasPermanentAccess(guild.id, ownerId, member.id) : false;
        const memberRoleIds = member.roles.cache.map(r => r.id);
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        let hasExplicitPermit = false;
        if (pvcData) {
            const ownerPerms = await prisma.ownerPermission.findMany({
                where: { guildId: guild.id, ownerId: pvcData.ownerId, targetId: member.id }
            });
            hasExplicitPermit = ownerPerms.length > 0;
        }
        const shouldKeepPermit = hasPermanentAccess || isWhitelisted || hasExplicitPermit;
        if (shouldKeepPermit) {
            console.log(`[HandleLeave] ✅ User ${member.user.tag} has permanent/explicit access - KEEPING permit`);
        } else {
            console.log(`[HandleLeave] 🗑️ Removing temp drag permit for ${member.user.tag}`);
            if (pvcData) {
                await prisma.voicePermission.deleteMany({
                    where: {
                        channelId,
                        targetId: member.id,
                        permission: 'permit',
                    },
                }).catch(() => { });
            } else if (teamData) {
                await prisma.teamVoicePermission.deleteMany({
                    where: {
                        channelId,
                        targetId: member.id,
                        permission: 'permit',
                    },
                }).catch(() => { });
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
                try {
                    await logAction({
                        action: LogAction.USER_REMOVED,
                        guild: guild,
                        user: member.user,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `${member.user.username} left the voice channel`,
                    });
                } catch (logErr) {
                    console.error('[HandleLeave] Failed to log user leave:', logErr);
                }
            }
        }
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
            try {
                console.log(`[HandleLeave] Channel ${channelId} not in cache, fetching from Discord...`);
                channel = await guild.channels.fetch(channelId) as any;
                console.log(`[HandleLeave] ✅ Successfully fetched channel ${channelId} from Discord`);
            } catch (fetchErr) {
                console.error(`[HandleLeave] ❌ Failed to fetch channel ${channelId} from Discord:`, fetchErr);
                console.log(`[HandleLeave] Channel not found on Discord, cleaning up database...`);
                await deletePrivateChannel(channelId, guild.id);
                return;
            }
        }
        if (channel && channel.type === ChannelType.GuildVoice) {
            if (channel.members.size === 0) {
                try {
                    await logAction({
                        action: LogAction.CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Channel deleted (empty)`,
                    });
                } catch (logErr) {
                    console.error('[HandleLeave] Failed to log channel deletion:', logErr);
                }
                await deletePrivateChannel(channelId, guild.id);
            } else {
                const allBots = channel.members.every(m => m.user.bot);
                if (allBots && channel.members.size > 0) {
                    for (const [, botMember] of channel.members) {
                        await botMember.voice.disconnect().catch(() => { });
                    }
                    try {
                        await logAction({
                            action: LogAction.CHANNEL_DELETED,
                            guild: guild,
                            channelName: channel.name,
                            channelId: channelId,
                            details: `Channel deleted (only bots remained)`,
                        });
                    } catch (logErr) {
                        console.error('[HandleLeave] Failed to log channel deletion (bots only):', logErr);
                    }
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
                        try {
                            await logAction({
                                action: LogAction.CHANNEL_DELETED,
                                guild: guild,
                                channelName: channel.name,
                                channelId: channelId,
                                details: `Owner left, no members to transfer to`,
                            });
                        } catch (logErr) {
                            console.error('[HandleLeave] Failed to log channel deletion (owner left):', logErr);
                        }
                        await deletePrivateChannel(channelId, guild.id);
                    }
                } else {
                    console.log(`[HandleLeave] Non-owner left. Member: ${member?.id}, Owner: ${channelState.ownerId}`);
                }
            }
            return;
        }
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
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
            try {
                console.log(`[HandleLeave] Team channel ${channelId} not in cache, fetching from Discord...`);
                channel = await guild.channels.fetch(channelId) as any;
                console.log(`[HandleLeave] ✅ Successfully fetched team channel ${channelId} from Discord`);
            } catch (fetchErr) {
                console.error(`[HandleLeave] ❌ Failed to fetch team channel ${channelId} from Discord:`, fetchErr);
                console.log(`[HandleLeave] Team channel not found on Discord, cleaning up database...`);
                await deleteTeamChannel(channelId, guild.id);
                return;
            }
        }
        if (channel && channel.type === ChannelType.GuildVoice) {
            if (channel.members.size === 0) {
                try {
                    await logAction({
                        action: LogAction.TEAM_CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Team channel deleted (empty)`,
                        isTeamChannel: true,
                        teamType: teamChannelState.teamType,
                    });
                } catch (logErr) {
                    console.error('[HandleLeave] Failed to log team channel deletion:', logErr);
                }
                await deleteTeamChannel(channelId, guild.id);
            } else {
                const allBots = channel.members.every(m => m.user.bot);
                if (allBots && channel.members.size > 0) {
                    for (const [, botMember] of channel.members) {
                        await botMember.voice.disconnect().catch(() => { });
                    }
                    try {
                        await logAction({
                            action: LogAction.TEAM_CHANNEL_DELETED,
                            guild: guild,
                            channelName: channel.name,
                            channelId: channelId,
                            details: `Team channel deleted (only bots remained)`,
                            isTeamChannel: true,
                            teamType: teamChannelState.teamType,
                        });
                    } catch (logErr) {
                        console.error('[HandleLeave] Failed to log team channel deletion (bots):', logErr);
                    }
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
        let channel = guild.channels.cache.get(channelId);
        if (!channel) {
            try {
                console.log(`[HandleLeave] Channel ${channelId} (DB fallback) not in cache, fetching from Discord...`);
                channel = await guild.channels.fetch(channelId) as any;
                console.log(`[HandleLeave] ✅ Successfully fetched channel ${channelId} (DB fallback) from Discord`);
            } catch (fetchErr) {
                console.error(`[HandleLeave] ❌ Failed to fetch channel ${channelId} (DB fallback) from Discord:`, fetchErr);
                console.log(`[HandleLeave] Channel not found on Discord (DB fallback), cleaning up database...`);
                const isTeamChannel = Boolean(dbTeam);
                if (isTeamChannel) {
                    await deleteTeamChannel(channelId, guild.id);
                } else {
                    await deletePrivateChannel(channelId, guild.id);
                }
                return;
            }
        }
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
                try {
                    await logAction({
                        action: LogAction.TEAM_CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Team channel deleted (empty - DB fallback)`,
                        isTeamChannel: true,
                        teamType: dbTeam?.teamType.toLowerCase(),
                    });
                } catch (logErr) {
                    console.error('[HandleLeave] Failed to log team fallback deletion:', logErr);
                }
                await deleteTeamChannel(channelId, guild.id);
            } else {
                try {
                    await logAction({
                        action: LogAction.CHANNEL_DELETED,
                        guild: guild,
                        channelName: channel.name,
                        channelId: channelId,
                        details: `Channel deleted (empty - DB fallback)`,
                    });
                } catch (logErr) {
                    console.error('[HandleLeave] Failed to log fallback deletion:', logErr);
                }
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
        console.log(`[VCNS-CREATE] 📋 Adding user ${member.user.tag} to persistent queue...`);
        const { vcQueueService, VCRequestType } = await import('../services/vcQueueService');
        const existingRequest = await vcQueueService.getUserRequest(member.id, guild.id);
        if (existingRequest) {
            const position = await vcQueueService.getQueuePosition(existingRequest.id);
            console.log(`[VCNS-CREATE] User already in queue at position ${position}`);
            releaseCreationLock(guild.id, member.id);
            try {
                await member.send({
                    embeds: [{
                        title: '⏳ Already in Queue',
                        description: `You're already waiting for your voice channel!\n\n**Queue Position:** #${position}\n\nPlease stay in the interface channel and your VC will be created automatically.`,
                        color: 0xFFA500,
                        timestamp: new Date().toISOString(),
                    }],
                }).catch(() => {});
            } catch {}
            return;
        }
        const request = await vcQueueService.createRequest({
            userId: member.id,
            guildId: guild.id,
            requestType: VCRequestType.PVC,
            channelName: member.displayName,
            parentId: interfaceChannel.parent?.id,
            permissionOverwrites,
            priority: 5,
        });
        releaseCreationLock(guild.id, member.id);
        const position = await vcQueueService.getQueuePosition(request.id);
        const queueSize = await vcQueueService.getQueueSize(guild.id);
        console.log(`[VCNS-CREATE] ✅ Request ${request.id} created - Position: ${position}/${queueSize}`);
        try {
            await member.send({
                embeds: [{
                    title: '✅ Added to VC Creation Queue',
                    description: `Your voice channel is being created!\n\n**Queue Position:** #${position} of ${queueSize}\n**Status:** ${request.status}\n\n⏳ Please **stay in the interface channel**. You'll be automatically moved to your new VC when it's ready!\n\nThis may take a few seconds if the server is busy.`,
                    color: 0x00FF00,
                    timestamp: new Date().toISOString(),
                    footer: {
                        text: 'We guarantee your VC will be created - infinite retry enabled',
                    },
                }],
            }).catch(() => {});
        } catch {}
        return;
    } catch (error) {
        console.error('[VCNS-CREATE] Error:', error);
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
        const { stateStore: vcnsStateStore } = await import('../vcns/index');
        vcnsStateStore.transferOwnership(channelId, nextUserId);
        console.log(`[TransferOwnership] ✅ Updated VCNS state`);
        if (isTeamChannel && teamState) {
            await prisma.teamVoiceChannel.update({
                where: { channelId },
                data: { ownerId: nextUserId },
            });
            console.log(`[TransferOwnership] ✅ Updated DB owner for Team channel`);
        } else {
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
        const { clearTempLockPermits } = await import('../utils/voiceManager');
        clearTempLockPermits(channelId);
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
        unregisterChannel(channelId);
        invalidateChannelPermissions(channelId);
        await prisma.voicePermission.deleteMany({ where: { channelId } }).catch(() => { });
        await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
        console.log(`[DeletePVC] ✅ Channel ${channelId} fully cleaned up`);
    } catch (err) {
        console.error(`[DeletePVC] Error:`, err);
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
        console.log(`[TEAM-CREATE] 📋 Adding user ${member.user.tag} to persistent queue for ${teamType}...`);
        const { vcQueueService, VCRequestType } = await import('../services/vcQueueService');
        let requestType: typeof VCRequestType[keyof typeof VCRequestType];
        switch (teamType) {
            case 'duo':
                requestType = VCRequestType.TEAM_DUO;
                break;
            case 'trio':
                requestType = VCRequestType.TEAM_TRIO;
                break;
            case 'squad':
                requestType = VCRequestType.TEAM_SQUAD;
                break;
            default:
                requestType = VCRequestType.PVC;
        }
        const existingRequest = await vcQueueService.getUserRequest(member.id, guild.id);
        if (existingRequest) {
            const position = await vcQueueService.getQueuePosition(existingRequest.id);
            console.log(`[TEAM-CREATE] User already in queue at position ${position}`);
            releaseCreationLock(guild.id, member.id);
            try {
                await member.send({
                    embeds: [{
                        title: '⏳ Already in Queue',
                        description: `You're already waiting for your ${teamType} channel!\n\n**Queue Position:** #${position}\n\nPlease stay in the interface channel and your VC will be created automatically.`,
                        color: 0xFFA500,
                        timestamp: new Date().toISOString(),
                    }],
                }).catch(() => {});
            } catch {}
            return;
        }
        const request = await vcQueueService.createRequest({
            userId: member.id,
            guildId: guild.id,
            requestType: requestType,
            channelName: `${member.displayName}'s ${teamType.charAt(0).toUpperCase() + teamType.slice(1)}`,
            parentId: interfaceChannel.parent?.id,
            permissionOverwrites: [
                {
                    id: member.id,
                    allow: ownerPerms.allow,
                    deny: ownerPerms.deny,
                },
            ],
            priority: 5,
        });
        releaseCreationLock(guild.id, member.id);
        const position = await vcQueueService.getQueuePosition(request.id);
        const queueSize = await vcQueueService.getQueueSize(guild.id);
        console.log(`[TEAM-CREATE] ✅ Request ${request.id} created - Position: ${position}/${queueSize}`);
        try {
            await member.send({
                embeds: [{
                    title: `✅ Added to ${teamType.toUpperCase()} Channel Queue`,
                    description: `Your team voice channel is being created!\n\n**Queue Position:** #${position} of ${queueSize}\n**Status:** ${request.status}\n**User Limit:** ${userLimit}\n\n⏳ Please **stay in the interface channel**. You'll be automatically moved to your new VC when it's ready!\n\nThis may take a few seconds if the server is busy.`,
                    color: 0x00FF00,
                    timestamp: new Date().toISOString(),
                    footer: {
                        text: 'We guarantee your VC will be created - infinite retry enabled',
                    },
                }],
            }).catch(() => {});
        } catch {}
        return;
    } catch (error) {
        console.error('[TEAM-CREATE] Error:', error);
        releaseCreationLock(guild.id, member.id);
    }
}
async function deleteTeamChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        const { clearTempLockPermits } = await import('../utils/voiceManager');
        clearTempLockPermits(channelId);
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
        const { stateStore: vcnsStateStore } = await import('../vcns/index');
        vcnsStateStore.transferOwnership(channelId, nextUserId);
        console.log(`[TransferTeamOwnership] ✅ Updated VCNS state`);
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

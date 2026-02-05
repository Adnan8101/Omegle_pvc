import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from './database';
import { RATE_LIMITS, PERMISSION_THRESHOLDS, RETRY_CONFIG } from './constants'; 
import {
    registerInterfaceChannel,
    registerChannel,
    registerTeamChannel,
    registerTeamInterfaceChannel,
    addUserToJoinOrder,
    transferOwnership,
    transferTeamOwnership,
} from './voiceManager';
import { invalidateChannelPermissions, getOwnerPermissions as getCachedOwnerPerms } from './cache';
import { stateStore } from '../vcns/index';
import { recordBotEdit } from '../events/channelUpdate';
export async function performAutoRefresh(client: PVCClient): Promise<void> {
    console.log('[AutoRefresh] 🔄 Starting automatic PVC refresh...');
    const guilds = await prisma.guildSettings.findMany({
        include: { privateChannels: true },
    });
    for (const guildSettings of guilds) {
        const guild = client.guilds.cache.get(guildSettings.guildId);
        if (!guild) {
            console.log(`[AutoRefresh] ⚠️ Guild ${guildSettings.guildId} not accessible - skipping`);
            continue;
        }
        console.log(`[AutoRefresh] 🔍 Processing guild: ${guild.name}`);
        let attempts = 0;
        const maxAttempts = RETRY_CONFIG.MAX_GUILD_REFRESH_ATTEMPTS; 
        while (attempts < maxAttempts) {
            try {
                await refreshGuild(guild);
                break; 
            } catch (err) {
                attempts++;
                console.error(`[AutoRefresh] ❌ Error refreshing guild ${guild.name} (attempt ${attempts}/${maxAttempts}):`, err);
                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, RATE_LIMITS.GUILD_REFRESH_RETRY_DELAY * attempts)); 
                }
            }
        }
    }
    console.log('[AutoRefresh] ✅ Auto-refresh completed');
}
async function refreshGuild(guild: Guild): Promise<void> {
    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
        include: { privateChannels: true },
    });
    const teamSettings = await prisma.teamVoiceSettings.findUnique({
        where: { guildId: guild.id },
        include: { teamChannels: true },
    });
    if (!settings && !teamSettings) {
        return; 
    }
    console.log(`[AutoRefresh] 📊 ${guild.name}: ${settings?.privateChannels?.length || 0} PVCs, ${teamSettings?.teamChannels?.length || 0} Team channels`);
    if (settings?.interfaceVcId) {
        const interfaceVc = guild.channels.cache.get(settings.interfaceVcId);
        if (interfaceVc) {
            registerInterfaceChannel(guild.id, settings.interfaceVcId);
        }
    }
    if (teamSettings) {
        if (teamSettings.duoVcId) registerTeamInterfaceChannel(guild.id, 'duo', teamSettings.duoVcId);
        if (teamSettings.trioVcId) registerTeamInterfaceChannel(guild.id, 'trio', teamSettings.trioVcId);
        if (teamSettings.squadVcId) registerTeamInterfaceChannel(guild.id, 'squad', teamSettings.squadVcId);
    }
    if (settings?.privateChannels) {
        for (const pvc of settings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (!channel || channel.type !== ChannelType.GuildVoice) {
                await prisma.privateVoiceChannel.deleteMany({ where: { channelId: pvc.channelId } }).catch(() => {});
                await prisma.voicePermission.deleteMany({ where: { channelId: pvc.channelId } }).catch(() => {});
                continue;
            }
            registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId, true);
            if (!stateStore.getChannelState(pvc.channelId)) {
                stateStore.registerChannel({
                    channelId: pvc.channelId,
                    guildId: pvc.guildId,
                    ownerId: pvc.ownerId,
                    isLocked: pvc.isLocked || false,
                    isHidden: pvc.isHidden || false,
                    userLimit: pvc.userLimit || 0,
                    isTeamChannel: false,
                    operationPending: false,
                    lastModified: Date.now(),
                });
            }
            await syncChannelPermissions(guild, channel as any, pvc.ownerId, pvc.channelId, false);
            for (const member of channel.members.values()) {
                if (!member.user.bot && member.id !== pvc.ownerId) {
                    addUserToJoinOrder(pvc.channelId, member.id);
                }
            }
        }
    }
    if (teamSettings?.teamChannels) {
        for (const tc of teamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (!channel || channel.type !== ChannelType.GuildVoice) {
                await prisma.teamVoiceChannel.deleteMany({ where: { channelId: tc.channelId } }).catch(() => {});
                await prisma.teamVoicePermission.deleteMany({ where: { channelId: tc.channelId } }).catch(() => {});
                continue;
            }
            registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as 'duo' | 'trio' | 'squad', true);
            if (!stateStore.getChannelState(tc.channelId)) {
                stateStore.registerChannel({
                    channelId: tc.channelId,
                    guildId: tc.guildId,
                    ownerId: tc.ownerId,
                    isLocked: tc.isLocked || false,
                    isHidden: tc.isHidden || false,
                    userLimit: tc.userLimit || 0,
                    isTeamChannel: true,
                    teamType: tc.teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                    operationPending: false,
                    lastModified: Date.now(),
                });
            }
            await syncChannelPermissions(guild, channel as any, tc.ownerId, tc.channelId, true);
            for (const member of channel.members.values()) {
                if (!member.user.bot && member.id !== tc.ownerId) {
                    addUserToJoinOrder(tc.channelId, member.id);
                }
            }
        }
    }
    console.log(`[AutoRefresh] ✅ ${guild.name}: Refresh complete`);
}
async function syncChannelPermissions(
    guild: Guild,
    channel: any,
    ownerId: string,
    channelId: string,
    isTeamChannel: boolean
): Promise<void> {
    try {
        const permanentPerms = await getCachedOwnerPerms(guild.id, ownerId);
        const permanentUserIds = new Set(permanentPerms.map(p => p.targetId));
        const memberIds: string[] = [];
        for (const member of channel.members.values()) {
            if (member.id === ownerId || member.user.bot) continue;
            memberIds.push(member.id);
        }
        const allAllowedIds = new Set([...permanentUserIds, ...memberIds]);
        if (isTeamChannel) {
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId, permission: 'permit' },
            });
        } else {
            await prisma.voicePermission.deleteMany({
                where: { channelId, permission: 'permit' },
            });
        }
        if (allAllowedIds.size > 0) {
            const permitData = Array.from(allAllowedIds).map(userId => ({
                channelId,
                targetId: userId,
                targetType: 'user' as const,
                permission: 'permit' as const,
            }));
            if (isTeamChannel) {
                await prisma.teamVoicePermission.createMany({
                    data: permitData,
                    skipDuplicates: true,
                });
            } else {
                await prisma.voicePermission.createMany({
                    data: permitData,
                    skipDuplicates: true,
                });
            }
        }
        invalidateChannelPermissions(channelId);
        recordBotEdit(channelId);
        await channel.permissionOverwrites.edit(ownerId, {
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
        }).catch(() => {});
        for (const userId of allAllowedIds) {
            await channel.permissionOverwrites.edit(userId, {
                ViewChannel: true,
                Connect: true,
                SendMessages: true,
                EmbedLinks: true,
                AttachFiles: true,
            }).catch(() => {});
            if (allAllowedIds.size > PERMISSION_THRESHOLDS.LARGE_BATCH_SIZE) {
                await new Promise(resolve => setTimeout(resolve, RATE_LIMITS.BATCH_PERMISSION_DELAY));
            }
        }
        console.log(`[AutoRefresh] ✅ Synced ${allAllowedIds.size} permits for channel ${channelId}`);
    } catch (err) {
        console.error(`[AutoRefresh] ❌ Failed to sync permissions for ${channelId}:`, err);
    }
}

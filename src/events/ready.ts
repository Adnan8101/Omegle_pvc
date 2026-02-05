import { Events, ChannelType, type VoiceChannel, PermissionFlagsBits, OverwriteType } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel, loadAllTeamInterfaces, registerTeamChannel, unregisterChannel, unregisterTeamChannel, type TeamType } from '../utils/voiceManager';
import { setRecordBotEditFn } from '../utils/discordApi';
import { recordBotEdit } from './channelUpdate';
import { handleJoin } from './voiceStateUpdate';
import { vcnsBridge } from '../vcns/bridge';
import { invalidateChannelPermissions } from '../utils/cache';
export const name = Events.ClientReady;
export const once = true;
export async function execute(client: PVCClient): Promise<void> {
    setRecordBotEditFn(recordBotEdit);
    await loadAllTeamInterfaces();
    console.log('[Ready] 🚀 Starting VC Creation Queue Worker...');
    const { vcQueueWorker } = await import('../services/vcQueueWorker');
    await vcQueueWorker.start(client);
    console.log('[Ready] ✅ VC Creation Queue Worker started');
    console.log('[Ready] Loading PVC state from database...');
    const { stateStore } = await import('../vcns/index');
    try {
        const guildSettings = await prisma.guildSettings.findMany({
            include: { privateChannels: true },
        });
        let registeredCount = 0;
        let cleanedCount = 0;
        for (const settings of guildSettings) {
            const guild = client.guilds.cache.get(settings.guildId);
            if (!guild) continue;
            if (settings.interfaceVcId) {
                const interfaceChannel = guild.channels.cache.get(settings.interfaceVcId);
                if (interfaceChannel) {
                    registerInterfaceChannel(settings.guildId, settings.interfaceVcId);
                    if (interfaceChannel.type === ChannelType.GuildVoice && interfaceChannel.members.size > 0) {
                        const waitingMembers = interfaceChannel.members.filter(m => !m.user.bot);
                        if (waitingMembers.size > 0) {
                            console.log(`[Ready] 🚀 Kickstarting ${waitingMembers.size} users waiting in PVC Interface...`);
                            for (const member of waitingMembers.values()) {
                                handleJoin(client, member.voice).catch(err =>
                                    console.error(`[Ready] Failed to kickstart PVC for ${member.user.tag}:`, err)
                                );
                            }
                        }
                    }
                }
            }
            const teamSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: settings.guildId } });
            if (teamSettings) {
                const teamInterfaces = [
                    { type: 'Duo', id: teamSettings.duoVcId },
                    { type: 'Trio', id: teamSettings.trioVcId },
                    { type: 'Squad', id: teamSettings.squadVcId }
                ];
                for (const iface of teamInterfaces) {
                    if (iface.id) {
                        const channel = guild.channels.cache.get(iface.id);
                        if (channel && channel.type === ChannelType.GuildVoice && channel.members.size > 0) {
                            const waitingMembers = channel.members.filter(m => !m.user.bot);
                            if (waitingMembers.size > 0) {
                                console.log(`[Ready] 🚀 Kickstarting ${waitingMembers.size} users waiting in ${iface.type} Interface...`);
                                for (const member of waitingMembers.values()) {
                                    handleJoin(client, member.voice).catch(err =>
                                        console.error(`[Ready] Failed to kickstart ${iface.type} for ${member.user.tag}:`, err)
                                    );
                                }
                            }
                        }
                    }
                }
            }
            for (const pvc of settings.privateChannels) {
                let channel = guild.channels.cache.get(pvc.channelId);
                if (!channel) {
                    try {
                        const fetched = await guild.channels.fetch(pvc.channelId);
                        if (fetched) channel = fetched as any;
                    } catch (error: any) {
                        const isDefinitive = error.status === 404 || error.code === 10003 || error.status === 403 || error.code === 50013;
                        if (!isDefinitive) {
                            console.error(`[Ready] ⚠️ Failed to fetch channel ${pvc.channelId} (Network/API Error). Skipping cleanup.`);
                            continue;
                        }
                    }
                }
                if (channel && channel.type === ChannelType.GuildVoice) {
                    const nonBotMembers = channel.members.filter(m => !m.user.bot);
                    if (nonBotMembers.size === 0) {
                        console.log(`[Ready] 🧹 Channel ${pvc.channelId} is empty on startup - deleting (Zombie Cleanup)`);
                        let deletedFromDiscord = false;
                        try {
                            if (channel.deletable) {
                                await channel.delete('PVC Cleanup: Zombie Channel');
                                deletedFromDiscord = true;
                            } else {
                                console.error(`[Ready] ❌ Cannot delete channel ${pvc.channelId} - Missing Permissions?`);
                            }
                        } catch (err: any) {
                            if (err.code === 10003 || err.status === 404) { 
                                deletedFromDiscord = true;
                            } else {
                                console.error(`[Ready] Failed to delete empty channel from Discord:`, err);
                            }
                        }
                        if (deletedFromDiscord) {
                            await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => { });
                            await prisma.voicePermission.deleteMany({ where: { channelId: pvc.channelId } }).catch(() => { });
                            cleanedCount++;
                            console.log(`[Ready] ✅ Successfully cleaned up zombie channel ${pvc.channelId}`);
                        } else {
                            console.log(`[Ready] ⚠️ Skipped DB deletion for ${pvc.channelId} because Discord deletion failed.`);
                        }
                        continue;
                    }
                    registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId, false);
                    if (!stateStore.getChannelState(pvc.channelId)) {
                        stateStore.registerChannel({
                            channelId: pvc.channelId,
                            guildId: pvc.guildId,
                            ownerId: pvc.ownerId,
                            isLocked: pvc.isLocked || false,
                            isHidden: pvc.isHidden || false,
                            userLimit: 0,
                            isTeamChannel: false,
                            operationPending: false,
                            lastModified: Date.now(),
                        });
                    }
                    registeredCount++;
                } else {
                    await prisma.privateVoiceChannel.delete({
                        where: { channelId: pvc.channelId },
                    }).catch(() => { });
                    cleanedCount++;
                }
            }
        }
        const teamChannels = await prisma.teamVoiceChannel.findMany();
        for (const tc of teamChannels) {
            const guild = client.guilds.cache.get(tc.guildId);
            if (!guild) continue;
            let channel = guild.channels.cache.get(tc.channelId);
            if (!channel) {
                try {
                    const fetched = await guild.channels.fetch(tc.channelId);
                    if (fetched) channel = fetched as any;
                } catch (error: any) {
                    const isDefinitive = error.status === 404 || error.code === 10003 || error.status === 403 || error.code === 50013;
                    if (!isDefinitive) {
                        console.error(`[Ready] ⚠️ Failed to fetch team channel ${tc.channelId} (Network/API Error). Skipping cleanup.`);
                        continue;
                    }
                }
            }
            if (channel && channel.type === ChannelType.GuildVoice) {
                const nonBotMembers = channel.members.filter(m => !m.user.bot);
                if (nonBotMembers.size === 0) {
                    console.log(`[Ready] 🧹 Team Channel ${tc.channelId} is empty on startup - deleting (Zombie Cleanup)`);
                    let deletedFromDiscord = false;
                    try {
                        if (channel.deletable) {
                            await channel.delete('Team PVC Cleanup: Zombie Channel');
                            deletedFromDiscord = true;
                        } else {
                            console.error(`[Ready] ❌ Cannot delete team channel ${tc.channelId} - Missing Permissions?`);
                        }
                    } catch (err: any) {
                        if (err.code === 10003 || err.status === 404) { 
                            deletedFromDiscord = true;
                        } else {
                            console.error(`[Ready] Failed to delete empty team channel from Discord:`, err);
                        }
                    }
                    if (deletedFromDiscord) {
                        await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => { });
                        await prisma.teamVoicePermission.deleteMany({ where: { channelId: tc.channelId } }).catch(() => { });
                        cleanedCount++;
                        console.log(`[Ready] ✅ Successfully cleaned up zombie team channel ${tc.channelId}`);
                    } else {
                        console.log(`[Ready] ⚠️ Skipped DB deletion for ${tc.channelId} because Discord deletion failed.`);
                    }
                    continue;
                }
                registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as TeamType, false);
                if (!stateStore.getChannelState(tc.channelId)) {
                    stateStore.registerChannel({
                        channelId: tc.channelId,
                        guildId: tc.guildId,
                        ownerId: tc.ownerId,
                        isLocked: tc.isLocked || false,
                        isHidden: tc.isHidden || false,
                        userLimit: 0,
                        isTeamChannel: true,
                        teamType: tc.teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                        operationPending: false,
                        lastModified: Date.now(),
                    });
                }
                registeredCount++;
            } else {
                await prisma.teamVoiceChannel.delete({
                    where: { channelId: tc.channelId },
                }).catch(() => { });
                cleanedCount++;
            }
        }
        console.log(`[Ready] ✅ Registered ${registeredCount} channels, cleaned ${cleanedCount} stale entries`);
        for (const settings of guildSettings) {
            const guild = client.guilds.cache.get(settings.guildId);
            if (!guild || !settings.interfaceVcId) continue;
            const interfaceVc = guild.channels.cache.get(settings.interfaceVcId);
            if (interfaceVc && interfaceVc.parent) {
                const categoryId = interfaceVc.parentId;
                const knownPvcIds = new Set(settings.privateChannels.map(p => p.channelId));
                knownPvcIds.add(settings.interfaceVcId);
                const teamSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: settings.guildId } });
                if (teamSettings) {
                    if (teamSettings.duoVcId) knownPvcIds.add(teamSettings.duoVcId);
                    if (teamSettings.trioVcId) knownPvcIds.add(teamSettings.trioVcId);
                    if (teamSettings.squadVcId) knownPvcIds.add(teamSettings.squadVcId);
                }
                const teamChannels = await prisma.teamVoiceChannel.findMany({ where: { guildId: settings.guildId } });
                teamChannels.forEach(tc => knownPvcIds.add(tc.channelId));
                const orphanChannels = guild.channels.cache.filter(ch =>
                    ch.type === ChannelType.GuildVoice &&
                    ch.parentId === categoryId &&
                    !knownPvcIds.has(ch.id)
                );
                if (orphanChannels.size > 0) {
                    console.log(`[Ready] 🔍 Found ${orphanChannels.size} orphan channels in category ${categoryId}`);
                    for (const [channelId, channel] of orphanChannels) {
                        if (channel.type !== ChannelType.GuildVoice) continue;
                        if (channel.members.size === 0) {
                            console.log(`[Ready] 🧹 Orphan Channel ${channelId} is empty - deleting (Zombie Cleanup)`);
                            try {
                                if (channel.deletable) {
                                    await channel.delete('PVC Cleanup: Orphaned Zombie Channel');
                                    console.log(`[Ready] ✅ Deleted orphan channel ${channelId}`);
                                } else {
                                    console.error(`[Ready] ❌ Cannot delete orphan ${channelId} - Missing Permissions?`);
                                }
                            } catch (err) {
                                console.error(`[Ready] Failed to delete orphan channel ${channelId}:`, err);
                            }
                        } else {
                            console.log(`[Ready] ⚠️ Orphan Channel ${channelId} has members - Attempting adoption...`);
                            let ownerId: string | null = null;
                            for (const [targetId, overwrite] of channel.permissionOverwrites.cache) {
                                if (targetId === guild.id || targetId === client.user?.id) continue;
                                if (overwrite.type === OverwriteType.Member && overwrite.allow.has(PermissionFlagsBits.MoveMembers)) {
                                    ownerId = targetId;
                                    break;
                                }
                            }
                            if (!ownerId) {
                                const nonBotMember = channel.members.find(m => !m.user.bot);
                                if (nonBotMember) ownerId = nonBotMember.id;
                            }
                            if (ownerId) {
                                try {
                                    const everyoneOverwrite = channel.permissionOverwrites.cache.get(guild.id);
                                    const isLocked = everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect) ?? false;
                                    const isHidden = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
                                    await prisma.privateVoiceChannel.create({
                                        data: {
                                            channelId: channelId,
                                            guildId: guild.id,
                                            ownerId: ownerId,
                                            isLocked: isLocked,
                                            isHidden: isHidden,
                                        },
                                    });
                                    registerChannel(channelId, guild.id, ownerId, false);
                                    if (!stateStore.getChannelState(channelId)) {
                                        stateStore.registerChannel({
                                            channelId: channelId,
                                            guildId: guild.id,
                                            ownerId: ownerId,
                                            isLocked: isLocked,
                                            isHidden: isHidden,
                                            userLimit: channel.userLimit || 0,
                                            isTeamChannel: false,
                                            operationPending: false,
                                            lastModified: Date.now(),
                                        });
                                    }
                                    console.log(`[Ready] ✅ Adopted orphan channel ${channelId} (Owner: ${ownerId})`);
                                    registeredCount++;
                                } catch (adoptErr) {
                                    console.error(`[Ready] Failed to adopt orphan channel ${channelId}:`, adoptErr);
                                }
                            } else {
                                console.log(`[Ready] ❌ Could not determine owner for orphan ${channelId} - skipping adoption`);
                            }
                        }
                    }
                }
            }
        }
        const ownerPermissions = await prisma.ownerPermission.findMany();
        if (ownerPermissions.length > 0) {
            console.log(`[Ready] 🔑 Loading ${ownerPermissions.length} permanent access grants...`);
            stateStore.loadPermanentAccess(ownerPermissions.map(p => ({
                guildId: p.guildId,
                ownerId: p.ownerId,
                targetId: p.targetId,
            })));
            console.log(`[Ready] ✅ Loaded permanent access grants into stateStore`);
        }
        startPeriodicSync(client, stateStore);
    } catch (error) {
        console.error('[Ready] Error loading PVC state:', error);
    }
}
async function startPeriodicSync(client: PVCClient, stateStore: any): Promise<void> {
    console.log('[Ready] Starting periodic sync check (every 5 minutes)...');
    setInterval(async () => {
        try {
            console.log('[PeriodicSync] Running sync check...');
            let synced = 0;
            let recovered = 0;
            const allPvcs = await prisma.privateVoiceChannel.findMany();
            for (const pvc of allPvcs) {
                const guild = client.guilds.cache.get(pvc.guildId);
                if (!guild) continue;
                let channel = guild.channels.cache.get(pvc.channelId);
                if (!channel) {
                    try {
                        const fetched = await guild.channels.fetch(pvc.channelId);
                        if (fetched) channel = fetched as any;
                    } catch (error: any) {
                        const isDefinitive = error.status === 404 || error.code === 10003 || error.status === 403 || error.code === 50013;
                        if (!isDefinitive) {
                            console.error(`[PeriodicSync] ⚠️ API error verifying channel ${pvc.channelId}, skipping checks`, error.message);
                            continue;
                        }
                    }
                }
                if (!channel || channel.type !== ChannelType.GuildVoice) {
                    await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => { });
                    continue;
                }
                const nonBotMembers = channel.members.filter(m => !m.user.bot);
                if (nonBotMembers.size === 0) {
                    console.log(`[PeriodicSync] 🧹 Channel ${pvc.channelId} found empty - deleting (Zombie Cleanup)`);
                    try {
                        const result = await vcnsBridge.deleteVC({
                            guild,
                            channelId: pvc.channelId,
                            isTeam: false,
                        });
                        if (result.success) {
                            await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => { });
                            await prisma.voicePermission.deleteMany({ where: { channelId: pvc.channelId } }).catch(() => { });
                            unregisterChannel(pvc.channelId);
                            invalidateChannelPermissions(pvc.channelId);
                        } else {
                            const chCheck = guild.channels.cache.get(pvc.channelId);
                            if (!chCheck) {
                                console.log(`[PeriodicSync] Channel ${pvc.channelId} missing after failed delete - cleaning DB`);
                                await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => { });
                                unregisterChannel(pvc.channelId);
                            } else {
                                console.error(`[PeriodicSync] Failed to delete channel ${pvc.channelId}: ${result.error}`);
                            }
                        }
                    } catch (err) {
                        console.error(`[PeriodicSync] Critical error during cleanup:`, err);
                    }
                    continue;
                }
                if (!stateStore.getChannelState(pvc.channelId)) {
                    stateStore.registerChannel({
                        channelId: pvc.channelId,
                        guildId: pvc.guildId,
                        ownerId: pvc.ownerId,
                        isLocked: pvc.isLocked || false,
                        isHidden: pvc.isHidden || false,
                        userLimit: 0,
                        isTeamChannel: false,
                        operationPending: false,
                        lastModified: Date.now(),
                    });
                    registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId, false);
                    recovered++;
                }
                synced++;
            }
            const allTeams = await prisma.teamVoiceChannel.findMany();
            for (const tc of allTeams) {
                const guild = client.guilds.cache.get(tc.guildId);
                if (!guild) continue;
                let channel = guild.channels.cache.get(tc.channelId);
                if (!channel) {
                    try {
                        const fetched = await guild.channels.fetch(tc.channelId);
                        if (fetched) channel = fetched as any;
                    } catch (error: any) {
                        const isDefinitive = error.status === 404 || error.code === 10003 || error.status === 403 || error.code === 50013;
                        if (!isDefinitive) {
                            console.error(`[PeriodicSync] ⚠️ API error verifying team channel ${tc.channelId}, skipping checks`, error.message);
                            continue;
                        }
                    }
                }
                if (!channel || channel.type !== ChannelType.GuildVoice) {
                    await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => { });
                    continue;
                }
                const nonBotMembers = channel.members.filter(m => !m.user.bot);
                if (nonBotMembers.size === 0) {
                    console.log(`[PeriodicSync] 🧹 Team Channel ${tc.channelId} found empty - deleting (Zombie Cleanup)`);
                    try {
                        const result = await vcnsBridge.deleteVC({
                            guild,
                            channelId: tc.channelId,
                            isTeam: true,
                        });
                        if (result.success) {
                            await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => { });
                            await prisma.teamVoicePermission.deleteMany({ where: { channelId: tc.channelId } }).catch(() => { });
                            unregisterTeamChannel(tc.channelId);
                        } else {
                            const chCheck = guild.channels.cache.get(tc.channelId);
                            if (!chCheck) {
                                await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => { });
                                unregisterTeamChannel(tc.channelId);
                            } else {
                                console.error(`[PeriodicSync] Failed to delete team channel ${tc.channelId}: ${result.error}`);
                            }
                        }
                    } catch (err) {
                        console.error(`[PeriodicSync] Critical error during team cleanup:`, err);
                    }
                    continue;
                }
                if (!stateStore.getChannelState(tc.channelId)) {
                    stateStore.registerChannel({
                        channelId: tc.channelId,
                        guildId: tc.guildId,
                        ownerId: tc.ownerId,
                        isLocked: tc.isLocked || false,
                        isHidden: tc.isHidden || false,
                        userLimit: 0,
                        isTeamChannel: true,
                        teamType: tc.teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                        operationPending: false,
                        lastModified: Date.now(),
                    });
                    registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as TeamType, false);
                    recovered++;
                }
                synced++;
            }
            if (recovered > 0) {
                console.log(`[PeriodicSync] ✅ Synced ${synced} channels, recovered ${recovered} missing channels`);
            } else {
                console.log(`[PeriodicSync] ✅ All ${synced} channels in sync`);
            }
        } catch (error) {
            console.error('[PeriodicSync] Error during sync:', error);
        }
    }, 5 * 60 * 1000);
    console.log('[Ready] 🔄 Starting automatic PVC refresh for all guilds...');
    try {
        const { performAutoRefresh } = await import('../utils/autoRefresh');
        await performAutoRefresh(client);
        console.log('[Ready] ✅ Auto-refresh completed for all guilds');
    } catch (refreshError) {
        console.error('[Ready] ⚠️ Auto-refresh encountered errors:', refreshError);
    }
}

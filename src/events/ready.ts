import { Events, ChannelType, type VoiceChannel } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel, loadAllTeamInterfaces, registerTeamChannel, type TeamType } from '../utils/voiceManager';
import { setRecordBotEditFn } from '../utils/discordApi';
import { recordBotEdit } from './channelUpdate';
export const name = Events.ClientReady;
export const once = true;
export async function execute(client: PVCClient): Promise<void> {
    setRecordBotEditFn(recordBotEdit);
    await loadAllTeamInterfaces();
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
function startPeriodicSync(client: PVCClient, stateStore: any): void {
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
}

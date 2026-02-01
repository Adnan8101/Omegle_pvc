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
                        channel = await guild.channels.fetch(pvc.channelId).catch(() => null) as any;
                    } catch {}
                }
                if (channel && channel.type === ChannelType.GuildVoice) {
                    registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
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
                    channel = await guild.channels.fetch(tc.channelId).catch(() => null) as any;
                } catch {}
            }
            if (channel && channel.type === ChannelType.GuildVoice) {
                registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as TeamType);
                registeredCount++;
            } else {
                await prisma.teamVoiceChannel.delete({
                    where: { channelId: tc.channelId },
                }).catch(() => { });
                cleanedCount++;
            }
        }
        console.log(`[Ready] ✅ Registered ${registeredCount} channels, cleaned ${cleanedCount} stale entries`);
        
        // Load permanent access grants into stateStore
        const { stateStore } = await import('../vcns/index');
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
    } catch (error) {
        console.error('[Ready] Error loading PVC state:', error);
    }
}

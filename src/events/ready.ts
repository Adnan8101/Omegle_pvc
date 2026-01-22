import { Events } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel, loadAllTeamInterfaces, registerTeamChannel, type TeamType } from '../utils/voiceManager';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: PVCClient): Promise<void> {
    console.log(`Bot is ready! Logged in as ${client.user?.tag}`);
    
    // Load all team interface channels from database
    await loadAllTeamInterfaces();
    
    try {
        const guildSettings = await prisma.guildSettings.findMany({
            include: { privateChannels: true },
        });

        for (const settings of guildSettings) {
            const guild = client.guilds.cache.get(settings.guildId);
            if (!guild) {
                continue;
            }

            if (settings.interfaceVcId) {
                const interfaceChannel = guild.channels.cache.get(settings.interfaceVcId);
                if (interfaceChannel) {
                    registerInterfaceChannel(settings.guildId, settings.interfaceVcId);
                }
            }

            for (const pvc of settings.privateChannels) {
                const channel = guild.channels.cache.get(pvc.channelId);
                if (channel) {
                    registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                } else {
                    await prisma.privateVoiceChannel.delete({
                        where: { channelId: pvc.channelId },
                    }).catch(() => { });
                }
            }
        }
        
        // Load all existing team channels into memory
        const teamChannels = await prisma.teamVoiceChannel.findMany();
        console.log(`[Ready] Loading ${teamChannels.length} team channels into memory`);
        
        for (const tc of teamChannels) {
            const guild = client.guilds.cache.get(tc.guildId);
            if (!guild) {
                continue;
            }
            
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel) {
                registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as TeamType);
                console.log(`[Ready] Registered team channel: ${tc.channelId} (${tc.teamType})`);
            } else {
                // Channel no longer exists, clean up
                await prisma.teamVoiceChannel.delete({
                    where: { channelId: tc.channelId },
                }).catch(() => { });
                console.log(`[Ready] Cleaned up stale team channel: ${tc.channelId}`);
            }
        }
        
        console.log(`[Ready] Initialization complete`);
    } catch (error) {
        console.error('[Ready] Error during initialization:', error);
    }
}

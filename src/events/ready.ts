import { Events } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel } from '../utils/voiceManager';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: PVCClient): Promise<void> {
    console.log(`[Ready] Bot logged in as ${client.user?.tag}`);
    
    try {
        const guildSettings = await prisma.guildSettings.findMany({
            include: { privateChannels: true },
        });

        console.log(`[Ready] Found ${guildSettings.length} guild settings to restore`);

        for (const settings of guildSettings) {
            const guild = client.guilds.cache.get(settings.guildId);
            if (!guild) {
                console.log(`[Ready] Guild ${settings.guildId} not in cache, skipping`);
                continue;
            }

            if (settings.interfaceVcId) {
                const interfaceChannel = guild.channels.cache.get(settings.interfaceVcId);
                if (interfaceChannel) {
                    registerInterfaceChannel(settings.guildId, settings.interfaceVcId);
                    console.log(`[Ready] Registered interface channel ${settings.interfaceVcId} for guild ${guild.name}`);
                } else {
                    console.log(`[Ready] Interface channel ${settings.interfaceVcId} not found in guild ${guild.name}`);
                }
            }

            for (const pvc of settings.privateChannels) {
                const channel = guild.channels.cache.get(pvc.channelId);
                if (channel) {
                    registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                } else {
                    await prisma.privateVoiceChannel.delete({
                        where: { channelId: pvc.channelId },
                    }).catch(() => {});
                }
            }
        }

        console.log(`[Ready] State restoration complete`);
    } catch (err) {
        console.error(`[Ready] Failed to restore state:`, err);
    }
}

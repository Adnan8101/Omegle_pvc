import { Events } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel } from '../utils/voiceManager';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: PVCClient): Promise<void> {

    // Load guild settings and sync voice channels
    try {
        const guildSettings = await prisma.guildSettings.findMany({
            include: { privateChannels: true },
        });

        for (const settings of guildSettings) {
            // Register interface channels
            if (settings.interfaceVcId) {
                registerInterfaceChannel(settings.guildId, settings.interfaceVcId);
            }

            // Register existing private channels
            for (const pvc of settings.privateChannels) {
                // Verify channel still exists
                const guild = client.guilds.cache.get(settings.guildId);
                if (guild) {
                    const channel = guild.channels.cache.get(pvc.channelId);
                    if (channel) {
                        registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                    } else {
                        // Channel was deleted while bot was offline
                        await prisma.privateVoiceChannel.delete({
                            where: { channelId: pvc.channelId },
                        });
                    }
                }
            }
        }

    } catch {
        // Silently handle errors during guild settings load
    }
}

import { Events } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { registerInterfaceChannel, registerChannel } from '../utils/voiceManager';

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: PVCClient): Promise<void> {
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
    } catch { }
}

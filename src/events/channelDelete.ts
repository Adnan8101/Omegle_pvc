import { Events, type DMChannel, type GuildChannel } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { unregisterChannel, unregisterInterfaceChannel, getChannelState, getInterfaceChannel } from '../utils/voiceManager';
import { invalidateChannelPermissions, invalidateGuildSettings } from '../utils/cache';

export const name = Events.ChannelDelete;
export const once = false;

export async function execute(client: PVCClient, channel: DMChannel | GuildChannel): Promise<void> {
    // Ignore DM channels
    if (!('guild' in channel)) return;

    const channelId = channel.id;
    const guildId = channel.guild.id;

    // Check if this was the interface channel
    const interfaceId = getInterfaceChannel(guildId);
    if (interfaceId === channelId) {
        // Interface channel was deleted - unregister it
        unregisterInterfaceChannel(guildId);

        // Also clean up guild settings in DB
        await prisma.guildSettings.update({
            where: { guildId },
            data: { interfaceVcId: null },
        }).catch(() => { });

        invalidateGuildSettings(guildId);
        return;
    }

    // Check if this was a PVC
    const channelState = getChannelState(channelId);
    if (channelState) {
        // PVC was deleted - clean up
        unregisterChannel(channelId);
        invalidateChannelPermissions(channelId);

        // Clean up from database
        await prisma.privateVoiceChannel.delete({
            where: { channelId },
        }).catch(() => { });
    }
}

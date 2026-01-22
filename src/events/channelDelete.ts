import { Events, type DMChannel, type GuildChannel } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { unregisterChannel, unregisterInterfaceChannel, getChannelState, getInterfaceChannel, unregisterTeamChannel, getTeamChannelState, unregisterTeamInterfaceChannel, isTeamInterfaceChannel, getTeamInterfaceType } from '../utils/voiceManager';
import { invalidateChannelPermissions, invalidateGuildSettings } from '../utils/cache';

export const name = Events.ChannelDelete;
export const once = false;

export async function execute(client: PVCClient, channel: DMChannel | GuildChannel): Promise<void> {
    // Ignore DM channels
    if (!('guild' in channel)) return;

    const channelId = channel.id;
    const guildId = channel.guild.id;

    // Check if this was the PVC interface channel
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

    // Check if this was a team interface channel
    if (isTeamInterfaceChannel(channelId)) {
        const teamType = getTeamInterfaceType(channelId);
        if (teamType) {
            unregisterTeamInterfaceChannel(guildId, teamType);
            
            // Clean up from DB
            const updateData: Record<string, null> = {};
            if (teamType === 'duo') updateData.duoVcId = null;
            if (teamType === 'trio') updateData.trioVcId = null;
            if (teamType === 'squad') updateData.squadVcId = null;
            
            await prisma.teamVoiceSettings.update({
                where: { guildId },
                data: updateData,
            }).catch(() => { });
        }
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
        return;
    }

    // Check if this was a team channel
    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {
        // Team channel was deleted - clean up
        unregisterTeamChannel(channelId);
        invalidateChannelPermissions(channelId);

        // Clean up from database
        await prisma.teamVoiceChannel.delete({
            where: { channelId },
        }).catch(() => { });
        
        // Also delete permissions
        await prisma.teamVoicePermission.deleteMany({
            where: { channelId },
        }).catch(() => { });
    }
}

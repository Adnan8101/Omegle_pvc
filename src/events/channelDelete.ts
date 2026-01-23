import { Events, type DMChannel, type GuildChannel } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { unregisterChannel, unregisterInterfaceChannel, getChannelState, getInterfaceChannel, unregisterTeamChannel, getTeamChannelState, unregisterTeamInterfaceChannel, isTeamInterfaceChannel, getTeamInterfaceType } from '../utils/voiceManager';
import { invalidateChannelPermissions, invalidateGuildSettings } from '../utils/cache';

export const name = Events.ChannelDelete;
export const once = false;

export async function execute(client: PVCClient, channel: DMChannel | GuildChannel): Promise<void> {

    if (!('guild' in channel)) return;

    const channelId = channel.id;
    const guildId = channel.guild.id;

    const interfaceId = getInterfaceChannel(guildId);
    if (interfaceId === channelId) {

        unregisterInterfaceChannel(guildId);

        await prisma.guildSettings.update({
            where: { guildId },
            data: { interfaceVcId: null },
        }).catch(() => { });

        invalidateGuildSettings(guildId);
        return;
    }

    if (isTeamInterfaceChannel(channelId)) {
        const teamType = getTeamInterfaceType(channelId);
        if (teamType) {
            unregisterTeamInterfaceChannel(guildId, teamType);

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

    const channelState = getChannelState(channelId);
    if (channelState) {

        unregisterChannel(channelId);
        invalidateChannelPermissions(channelId);

        await prisma.privateVoiceChannel.delete({
            where: { channelId },
        }).catch(() => { });
        return;
    }

    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {

        unregisterTeamChannel(channelId);
        invalidateChannelPermissions(channelId);

        await prisma.teamVoiceChannel.delete({
            where: { channelId },
        }).catch(() => { });

        await prisma.teamVoicePermission.deleteMany({
            where: { channelId },
        }).catch(() => { });
    }
}

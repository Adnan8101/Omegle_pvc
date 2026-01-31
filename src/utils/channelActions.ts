import { type Guild, type GuildMember, PermissionFlagsBits } from 'discord.js';
import prisma from './database';
import { vcnsBridge } from '../vcns/bridge';
import { transferOwnership as updateOwnershipMap, transferTeamOwnership, getTeamChannelState } from './voiceManager';
import { getOwnerPermissions as getCachedOwnerPerms, invalidateChannelPermissions } from './cache';
import { logAction, LogAction } from './logger';
import { recordBotEdit } from '../events/channelUpdate';
export async function transferChannelOwnership(
    guild: Guild,
    channelId: string,
    currentOwnerId: string,
    newOwnerId: string,
    executor: GuildMember | null,
    channelName: string
): Promise<void> {
    const teamState = getTeamChannelState(channelId);
    const isTeamChannel = Boolean(teamState);
    if (isTeamChannel) {
        transferTeamOwnership(channelId, newOwnerId);
    } else {
        updateOwnershipMap(channelId, newOwnerId);
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;
    recordBotEdit(channelId);
    const oldOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, currentOwnerId) : [];
    const newOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, newOwnerId) : [];
    await vcnsBridge.editPermission({
        guild,
        channelId,
        targetId: newOwnerId,
        permissions: {
            ViewChannel: true, Connect: true, Speak: true, Stream: true,
            SendMessages: true, EmbedLinks: true, AttachFiles: true,
            MuteMembers: true, DeafenMembers: true, ManageChannels: true,
        },
    });
    await vcnsBridge.removePermission({
        guild,
        channelId,
        targetId: currentOwnerId,
    }).catch(() => { });
    if (!isTeamChannel) {
        for (const friend of oldOwnerFriends) {
            if (friend.targetId !== newOwnerId && !newOwnerFriends.some(f => f.targetId === friend.targetId)) {
                await vcnsBridge.removePermission({
                    guild,
                    channelId,
                    targetId: friend.targetId,
                }).catch(() => { });
            }
        }
        for (const friend of newOwnerFriends) {
            await vcnsBridge.editPermission({
                guild,
                channelId,
                targetId: friend.targetId,
                permissions: {
                    ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, AttachFiles: true
                },
            });
        }
    }
    const newOwner = await guild.members.fetch(newOwnerId).catch(() => null);
    if (newOwner) {
        const newName = isTeamChannel
            ? `${newOwner.displayName}'s ${teamState?.teamType ? teamState.teamType.charAt(0).toUpperCase() + teamState.teamType.slice(1) : 'Team'}`
            : newOwner.displayName;
        await channel.setName(newName).catch(() => { });
    }
    if (isTeamChannel) {
        await prisma.teamVoiceChannel.update({
            where: { channelId },
            data: { ownerId: newOwnerId },
        });
    } else {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { ownerId: newOwnerId },
        });
    }
    invalidateChannelPermissions(channelId);
    if (executor) {
        const targetUser = await guild.members.fetch(newOwnerId).catch(() => null);
        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: executor.user,
            channelName: channelName,
            channelId: channelId,
            targetUser: targetUser?.user,
            details: `Ownership transferred`,
            isTeamChannel: isTeamChannel,
            teamType: teamState?.teamType,
        });
    }
}

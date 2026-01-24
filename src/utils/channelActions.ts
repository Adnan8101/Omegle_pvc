import { type Guild, type GuildMember, PermissionFlagsBits } from 'discord.js';
import prisma from './database';
import { executeWithRateLimit, Priority } from './rateLimit';
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

    // Record bot edit FIRST before any other operations to prevent self-punishment
    recordBotEdit(channelId);
    
    const oldOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, currentOwnerId) : [];
    const newOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, newOwnerId) : [];

    await Promise.all([
        executeWithRateLimit(`perms:${channelId}`, async () => {

            await channel.permissionOverwrites.edit(newOwnerId, {
                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                MuteMembers: true, DeafenMembers: true, ManageChannels: true,
            });

            await channel.permissionOverwrites.delete(currentOwnerId).catch(() => { });

            if (!isTeamChannel) {

                for (const friend of oldOwnerFriends) {

                    if (friend.targetId !== newOwnerId && !newOwnerFriends.some(f => f.targetId === friend.targetId)) {
                        await channel.permissionOverwrites.delete(friend.targetId).catch(() => { });
                    }
                }

                for (const friend of newOwnerFriends) {
                    await channel.permissionOverwrites.edit(friend.targetId, {
                        ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, AttachFiles: true
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
        }, Priority.HIGH),

        isTeamChannel
            ? prisma.teamVoiceChannel.update({
                where: { channelId },
                data: { ownerId: newOwnerId },
            })
            : prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { ownerId: newOwnerId },
            }),
    ]);

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

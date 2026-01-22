import { type Guild, type GuildMember, PermissionFlagsBits } from 'discord.js';
import prisma from './database';
import { executeWithRateLimit, Priority } from './rateLimit';
import { transferOwnership as updateOwnershipMap, transferTeamOwnership, getTeamChannelState } from './voiceManager';
import { getOwnerPermissions as getCachedOwnerPerms, invalidateChannelPermissions } from './cache';
import { logAction, LogAction } from './logger';

export async function transferChannelOwnership(
    guild: Guild,
    channelId: string,
    currentOwnerId: string,
    newOwnerId: string,
    executor: GuildMember | null, // null if system or implicit
    channelName: string
): Promise<void> {

    // Check if this is a team channel
    const teamState = getTeamChannelState(channelId);
    const isTeamChannel = Boolean(teamState);

    // Update in-memory map (use correct function based on channel type)
    if (isTeamChannel) {
        transferTeamOwnership(channelId, newOwnerId);
    } else {
        updateOwnershipMap(channelId, newOwnerId);
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;

    // Persistent History: Only applies to PVC, not team channels
    const oldOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, currentOwnerId) : [];
    const newOwnerFriends = !isTeamChannel ? await getCachedOwnerPerms(guild.id, newOwnerId) : [];

    await Promise.all([
        executeWithRateLimit(`perms:${channelId}`, async () => {
            // Grant Owner Perms to new owner
            await channel.permissionOverwrites.edit(newOwnerId, {
                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
            });

            // Revoke Owner Perms from old owner
            await channel.permissionOverwrites.delete(currentOwnerId).catch(() => { });

            // For PVC only: Remove Old Friends and Add New Friends
            if (!isTeamChannel) {
                // Remove Old Friends
                for (const friend of oldOwnerFriends) {
                    // Don't remove if they are the new owner or in new friend list
                    if (friend.targetId !== newOwnerId && !newOwnerFriends.some(f => f.targetId === friend.targetId)) {
                        await channel.permissionOverwrites.delete(friend.targetId).catch(() => { });
                    }
                }

                // Add New Friends
                for (const friend of newOwnerFriends) {
                    await channel.permissionOverwrites.edit(friend.targetId, {
                        ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, AttachFiles: true
                    });
                }
            }

            // Update Name (optional, nice to have)
            const newOwner = await guild.members.fetch(newOwnerId).catch(() => null);
            if (newOwner) {
                const newName = isTeamChannel 
                    ? `${newOwner.displayName}'s ${teamState?.teamType ? teamState.teamType.charAt(0).toUpperCase() + teamState.teamType.slice(1) : 'Team'}`
                    : newOwner.displayName;
                await channel.setName(newName).catch(() => { });
            }
        }, Priority.HIGH),

        // Update correct database table based on channel type
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

    // Force refresh cache
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

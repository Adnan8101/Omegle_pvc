import { type Guild, type GuildMember, PermissionFlagsBits } from 'discord.js';
import prisma from './database';
import { executeWithRateLimit, Priority } from './rateLimit';
import { transferOwnership as updateOwnershipMap } from './voiceManager';
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

    // Update in-memory map
    updateOwnershipMap(channelId, newOwnerId);

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;

    // Persistent History: Swap permissions
    // 1. Get Old Owner's friends and remove them
    const oldOwnerFriends = await getCachedOwnerPerms(guild.id, currentOwnerId);

    // 2. Get New Owner's friends and add them
    const newOwnerFriends = await getCachedOwnerPerms(guild.id, newOwnerId);

    await Promise.all([
        executeWithRateLimit(`perms:${channelId}`, async () => {
            // Grant Owner Perms to new owner
            await channel.permissionOverwrites.edit(newOwnerId, {
                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
            });

            // Revoke Owner Perms from old owner
            await channel.permissionOverwrites.delete(currentOwnerId).catch(() => { });

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
                    ViewChannel: true, Connect: true
                });
            }

            // Update Name (optional, nice to have)
            const newOwner = await guild.members.fetch(newOwnerId).catch(() => null);
            if (newOwner) {
                await channel.setName(newOwner.displayName).catch(() => { });
            }
        }, Priority.HIGH),

        prisma.privateVoiceChannel.update({
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
        });
    }
}

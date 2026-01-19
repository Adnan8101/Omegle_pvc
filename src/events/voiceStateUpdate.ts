import { ChannelType, Events, type VoiceState, EmbedBuilder } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import {
    getChannelState,
    isInterfaceChannel,
    registerChannel,
    unregisterChannel,
    getChannelByOwner,
    setInactivityTimer,
    clearInactivityTimer,
    addUserToJoinOrder,
    removeUserFromJoinOrder,
    getNextUserInOrder,
    transferOwnership,
    hasInactivityTimer,
    isOnCooldown,
    setCooldown,
} from '../utils/voiceManager';
import { getOwnerPermissions } from '../utils/permissions';
import { executeWithRateLimit, executeParallel, Priority } from '../utils/rateLimit';
import {
    getGuildSettings,
    getOwnerPermissions as getCachedOwnerPerms,
    getChannelPermissions,
    getWhitelist,
    batchUpsertPermissions,
} from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

export const name = Events.VoiceStateUpdate;
export const once = false;

export async function execute(
    client: PVCClient,
    oldState: VoiceState,
    newState: VoiceState
): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    if (newState.channelId && newState.channelId !== oldState.channelId) {
        // CRITICAL: Check access protection FIRST before any other handling
        // This covers: direct joins, drags, bot moves - ALL scenarios
        const wasKicked = await handleAccessProtection(client, newState);
        
        // Only continue if user wasn't kicked
        if (!wasKicked) {
            await handleJoin(client, newState);
        }
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
        await handleLeave(client, oldState);
    }
}

/**
 * CRITICAL ACCESS PROTECTION - Runs BEFORE any other handling
 * Handles ALL join scenarios: direct joins, drags, bot moves
 * Returns true if user was kicked (unauthorized), false if allowed
 */
async function handleAccessProtection(
    client: PVCClient,
    newState: VoiceState
): Promise<boolean> {
    const { channelId: newChannelId, guild, member } = newState;
    if (!newChannelId || !member) return false;

    const channelState = getChannelState(newChannelId);
    if (!channelState) return false; // Not a PVC - allow

    const channel = guild.channels.cache.get(newChannelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) return false;

    // Check if user is the owner - always allow
    if (member.id === channelState.ownerId) return false;

    // Check channel protection status
    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size > channel.userLimit;

    // If channel is not protected at all, allow
    if (!isLocked && !isHidden && !isFull) return false;

    // Fetch all permission data in parallel
    const memberRoleIds = member.roles.cache.map(r => r.id);
    const [channelPerms, settings, whitelist] = await Promise.all([
        getChannelPermissions(newChannelId),
        getGuildSettings(guild.id),
        getWhitelist(guild.id),
    ]);

    // Check if user is explicitly permitted
    const isUserPermitted = channelPerms.some(
        p => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return false;

    // Check if user has a permitted role
    const isRolePermitted = channelPerms.some(
        p => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return false;

    // Admin Strictness Logic:
    // - If strictness is OFF: Admins can freely join any locked/hidden PVC (default Discord behavior)
    // - If strictness is ON: Even admins are blocked UNLESS they're whitelisted
    
    const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');
    
    if (!settings?.adminStrictness) {
        // Strictness OFF - admins can bypass, regular users still blocked
        if (hasAdminPerm) return false;
    } else {
        // Strictness ON - check whitelist for admins
        const isWhitelisted = whitelist.some(
            w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
        );
        if (isWhitelisted) return false;
        // Even admins are blocked if strictness is ON and not whitelisted
    }

    // USER IS NOT AUTHORIZED - KICK THEM
    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
    console.log(`[AccessProtection] Kicking ${member.user.tag} from ${channel.name} (unauthorized access to ${reason} channel)`);

    try {
        // Disconnect immediately
        await member.voice.disconnect();

        const owner = guild.members.cache.get(channelState.ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('🚫 Access Denied')
            .setDescription(
                `You were removed from **${channel.name}** because the channel is **${reason}**.\n\n` +
                `Ask **${ownerName}** to give you access to join.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => {});

        // Log the unauthorized access attempt
        await logAction({
            action: LogAction.USER_REMOVED,
            guild: guild,
            user: member.user,
            channelName: channel.name,
            channelId: newChannelId,
            details: `Unauthorized access attempt blocked (channel is ${reason})`,
        });

        return true; // User was kicked
    } catch (err) {
        console.error(`[AccessProtection] Failed to kick ${member.id}:`, err);
        return false; // Failed to kick but tried
    }
}

async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    const isInterface = isInterfaceChannel(channelId);
    console.log(`[VoiceState] ${member.user.tag} joined ${channelId}, isInterface: ${isInterface}`);

    if (isInterface) {
        await createPrivateChannel(client, state);
        return;
    }

    const channelState = getChannelState(channelId);
    if (channelState) {
        const channel = guild.channels.cache.get(channelId);
        const wasInactive = hasInactivityTimer(channelId);
        
        // Clear inactivity timer when someone joins
        clearInactivityTimer(channelId);
        
        // If channel was inactive and this person is not the owner, transfer ownership
        if (wasInactive && member.id !== channelState.ownerId && channel && channel.type === ChannelType.GuildVoice) {
            console.log(`[Ownership] Channel was inactive, transferring to ${member.user.tag}`);
            
            // Clear previous join order and start fresh
            removeUserFromJoinOrder(channelId, channelState.ownerId);
            addUserToJoinOrder(channelId, member.id);
            
            // Transfer ownership
            transferOwnership(channelId, member.id);
            
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { ownerId: member.id },
            });
            
            // Update channel permissions for new owner
            const ownerPerms = getOwnerPermissions();
            await channel.permissionOverwrites.edit(member.id, {
                ViewChannel: true,
                Connect: true,
                Speak: true,
                Stream: true,
                MuteMembers: true,
                DeafenMembers: true,
                MoveMembers: true,
                ManageChannels: true,
            });
            
            // Rename voice channel to new owner (with rate limit handling)
            try {
                await executeWithRateLimit(
                    `rename:${channelId}`,
                    () => channel.setName(member.displayName),
                    Priority.LOW
                );
            } catch (err) {
                console.log(`[Ownership] Skipped rename due to rate limit`);
            }
            
            // Send claim notification to voice channel chat
            try {
                const embed = new EmbedBuilder()
                    .setColor(0xFFD700)
                    .setTitle('👑 Channel Claimed')
                    .setDescription(
                        `<@${member.id}> claimed this inactive channel and is now the owner!`
                    )
                    .setTimestamp();
                
                await channel.send({ embeds: [embed] });
            } catch (err) {
                console.log(`[Ownership] Failed to send claim message:`, err);
            }
            
            // Log the transfer
            await logAction({
                action: LogAction.CHANNEL_CLAIMED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `Claimed inactive voice channel`,
            });
        } else {
            // Normal join - just add to join order
            addUserToJoinOrder(channelId, member.id);
        }
        
        // Log user joined PVC
        if (channel) {
            await logAction({
                action: LogAction.USER_ADDED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} joined the voice channel`,
            });
        }
        
        // Note: Access protection already ran BEFORE handleJoin, so no need to call enforceAdminStrictness
    }
}

async function handleLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId) return;

    const channelState = getChannelState(channelId);
    if (!channelState) return;

    // Remove user from join order
    if (member) {
        removeUserFromJoinOrder(channelId, member.id);
    }

    // Log user left PVC
    if (member) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
            await logAction({
                action: LogAction.USER_REMOVED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} left the voice channel`,
            });
        }
    }

    // Check if channel is now empty
    const channel = guild.channels.cache.get(channelId);
    if (channel && channel.type === ChannelType.GuildVoice) {
        if (channel.members.size === 0) {
            // Channel is now empty - start inactivity timer
            await startInactivityTimer(client, channelId, guild.id, channelState.ownerId, channel.name);
        } else if (member && member.id === channelState.ownerId) {
            // Owner left but channel is not empty - transfer ownership
            await transferChannelOwnership(client, channelId, guild, channel);
        }
    }
}

async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    const { guild, member, channel: interfaceChannel } = state;
    if (!member || !interfaceChannel) return;

    // Anti-spam: Check cooldown
    if (isOnCooldown(member.id, 'CREATE_CHANNEL')) {
        console.log(`[PVC] User ${member.user.tag} on cooldown, skipping channel creation`);
        try {
            await member.voice.disconnect();
        } catch {}
        return;
    }

    const existingChannel = getChannelByOwner(guild.id, member.id);
    if (existingChannel) {
        const channel = guild.channels.cache.get(existingChannel);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const freshMember = await guild.members.fetch(member.id);
                if (freshMember.voice.channelId) {
                    await freshMember.voice.setChannel(channel);
                }
            } catch (err) {
                console.error(`[PVC] Failed to move ${member.id} to existing channel:`, err);
            }
            return;
        }
    }

    // Set cooldown for channel creation
    setCooldown(member.id, 'CREATE_CHANNEL');

    try {
        const ownerPerms = getOwnerPermissions();
        const newChannel = await executeWithRateLimit(
            `create:${guild.id}`,
            () => guild.channels.create({
                name: member.displayName,
                type: ChannelType.GuildVoice,
                parent: interfaceChannel.parent,
                permissionOverwrites: [
                    {
                        id: member.id,
                        allow: ownerPerms.allow,
                        deny: ownerPerms.deny,
                    },
                ],
            }),
            Priority.HIGH
        );

        registerChannel(newChannel.id, guild.id, member.id);
        
        // Initialize join order with owner as first member
        addUserToJoinOrder(newChannel.id, member.id);

        await prisma.privateVoiceChannel.create({
            data: {
                channelId: newChannel.id,
                guildId: guild.id,
                ownerId: member.id,
            },
        });

        const freshMember = await guild.members.fetch(member.id);
        if (freshMember.voice.channelId) {
            await freshMember.voice.setChannel(newChannel);
            console.log(`[PVC] Moved ${member.user.tag} to new channel ${newChannel.name}`);
            
            // Send welcome message to voice channel chat
            try {
                const welcomeEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎉 Welcome to Your PVC')
                    .setDescription(`<@${member.id}>, your private voice channel has been created!`)
                    .setTimestamp();
                
                await newChannel.send({ embeds: [welcomeEmbed] });
            } catch (err) {
                console.log(`[PVC] Failed to send welcome message:`, err);
            }
            
            // Log new channel creation
            await logAction({
                action: LogAction.CHANNEL_CREATED,
                guild: guild,
                user: member.user,
                channelName: newChannel.name,
                channelId: newChannel.id,
                details: `Private voice channel created`,
            });
        } else {
            console.log(`[PVC] User ${member.user.tag} left voice before move, cleaning up`);
            await newChannel.delete();
            unregisterChannel(newChannel.id);
            await prisma.privateVoiceChannel.delete({ where: { channelId: newChannel.id } }).catch(() => {});
            return;
        }

        const ownerPermissions = await getCachedOwnerPerms(guild.id, member.id);
        if (ownerPermissions.length > 0) {
            const validPermissions: typeof ownerPermissions = [];
            const invalidTargetIds: string[] = [];

            for (const perm of ownerPermissions) {
                const isValidTarget = perm.targetType === 'role'
                    ? guild.roles.cache.has(perm.targetId)
                    : guild.members.cache.has(perm.targetId) || await guild.members.fetch(perm.targetId).catch(() => null);

                if (isValidTarget) {
                    validPermissions.push(perm);
                } else {
                    invalidTargetIds.push(perm.targetId);
                    console.log(`[PVC] Skipping invalid ${perm.targetType} ${perm.targetId} - no longer exists`);
                }
            }

            if (invalidTargetIds.length > 0) {
                await prisma.ownerPermission.deleteMany({
                    where: {
                        guildId: guild.id,
                        ownerId: member.id,
                        targetId: { in: invalidTargetIds },
                    },
                }).catch(() => {});
            }

            if (validPermissions.length > 0) {
                const discordTasks = validPermissions.map(perm => ({
                    route: `perms:${newChannel.id}:${perm.targetId}`,
                    task: () => newChannel.permissionOverwrites.edit(perm.targetId, {
                        ViewChannel: true,
                        Connect: true,
                    }),
                    priority: Priority.NORMAL,
                }));

                await executeParallel(discordTasks);

                await batchUpsertPermissions(
                    newChannel.id,
                    validPermissions.map(p => ({
                        targetId: p.targetId,
                        targetType: p.targetType,
                        permission: 'permit',
                    }))
                );
            }
        }
    } catch (err) {
        console.error(`[PVC] Failed to create private channel for ${member.id}:`, err);
    }
}

async function transferChannelOwnership(
    client: PVCClient,
    channelId: string,
    guild: any,
    channel: any
): Promise<void> {
    try {
        const nextUserId = getNextUserInOrder(channelId);
        if (!nextUserId) {
            console.log(`[Ownership] No one in queue to transfer ownership for ${channelId}`);
            return;
        }

        const newOwner = guild.members.cache.get(nextUserId);
        if (!newOwner) {
            console.log(`[Ownership] Next user ${nextUserId} not found in guild`);
            return;
        }

        // Transfer ownership in memory and database
        transferOwnership(channelId, nextUserId);
        
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { ownerId: nextUserId },
        });

        // Update channel permissions for new owner
        const ownerPerms = getOwnerPermissions();
        await channel.permissionOverwrites.edit(nextUserId, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            Stream: true,
            MuteMembers: true,
            DeafenMembers: true,
            MoveMembers: true,
            ManageChannels: true,
        });

        // Rename voice channel to new owner's name (with rate limit handling)
        try {
            await executeWithRateLimit(
                `rename:${channelId}`,
                () => channel.setName(newOwner.displayName),
                Priority.LOW
            );
            console.log(`[Ownership] Renamed channel to ${newOwner.displayName}`);
        } catch (err) {
            console.log(`[Ownership] Skipped rename due to rate limit`);
        }

        console.log(`[Ownership] Transferred ownership of ${channel.name} to ${newOwner.user.tag}`);

        // Log the transfer
        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: newOwner.user,
            channelName: channel.name,
            channelId: channelId,
            details: `Ownership transferred to ${newOwner.user.username}`,
        });

        // Send notification to voice channel chat
        try {
            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('🔄 Ownership Transferred')
                .setDescription(
                    `<@${nextUserId}> is now the owner of this voice channel!`
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.log(`[Ownership] Failed to send transfer message:`, err);
        }
    } catch (err) {
        console.error(`[Ownership] Failed to transfer ownership:`, err);
    }
}

async function deletePrivateChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const { client } = await import('../client');
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.log(`[Delete] Guild ${guildId} not found, cleaning up state only`);
            unregisterChannel(channelId);
            await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});
            return;
        }

        const channel = guild.channels.cache.get(channelId);
        
        // Delete from Discord first, then cleanup state
        if (channel?.isVoiceBased()) {
            try {
                await executeWithRateLimit(`delete:${channelId}`, async () => { 
                    await channel.delete(); 
                }, Priority.NORMAL);
                console.log(`[Delete] Successfully deleted channel ${channelId}`);
            } catch (deleteErr) {
                console.error(`[Delete] Failed to delete Discord channel ${channelId}:`, deleteErr);
                // Continue with state cleanup even if Discord deletion fails
            }
        }

        // Now cleanup state
        unregisterChannel(channelId);
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});
        
    } catch (err) {
        console.error(`[Delete] Error in deletePrivateChannel for ${channelId}:`, err);
        // Still try to cleanup state
        unregisterChannel(channelId);
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});
    }
}

async function enforceAdminStrictness(
    client: PVCClient,
    state: VoiceState,
    ownerId: string
): Promise<void> {
    const { guild, member, channelId } = state;
    if (!member || !channelId) return;

    if (member.id === ownerId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) return;

    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
    const isFull = channel.userLimit > 0 && channel.members.size > channel.userLimit;

    if (!isLocked && !isHidden && !isFull) return;

    const settings = await getGuildSettings(guild.id);
    if (!settings?.adminStrictness) return;

    const memberRoleIds = member.roles.cache.map(r => r.id);
    const [channelPerms, whitelist] = await Promise.all([
        getChannelPermissions(channelId),
        getWhitelist(guild.id),
    ]);

    const isUserPermitted = channelPerms.some(
        p => p.targetId === member.id && p.permission === 'permit'
    );
    if (isUserPermitted) return;

    const isRolePermitted = channelPerms.some(
        p => memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit'
    );
    if (isRolePermitted) return;

    const isWhitelisted = whitelist.some(
        w => w.targetId === member.id || memberRoleIds.includes(w.targetId)
    );
    if (isWhitelisted) return;

    const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
    console.log(`[AdminStrictness] Disconnecting ${member.user.tag} from ${channel.name} (${reason})`);

    try {
        await member.voice.disconnect();

        const owner = guild.members.cache.get(ownerId);
        const ownerName = owner?.displayName || 'the owner';
        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('Access Denied')
            .setDescription(
                `You were disconnected from **${channel.name} PVC** because the channel is ${reason}.\n\n` +
                `Ask **${ownerName}** to give you access to join.`
            )
            .setTimestamp();
        member.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
        console.error(`[AdminStrictness] Failed to disconnect ${member.id}:`, err);
    }
}

async function startInactivityTimer(
    client: PVCClient,
    channelId: string,
    guildId: string,
    ownerId: string,
    channelName: string
): Promise<void> {
    console.log(`[Inactivity] Starting 3-minute timer for ${channelName} (${channelId})`);

    // Send DM to owner
    try {
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
            const owner = await guild.members.fetch(ownerId).catch(() => null);
            if (owner) {
                const embed = new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle('⚠️ Voice Channel Inactive')
                    .setDescription(
                        `Your voice channel **${channelName}** is currently empty.\n\n` +
                        `It will be automatically deleted after **3 minutes** of inactivity.\n\n` +
                        `Join the channel to prevent deletion.`
                    )
                    .setTimestamp();

                await owner.send({ embeds: [embed] }).catch((err) => {
                    console.log(`[Inactivity] Could not DM owner ${ownerId}:`, err.message);
                });
            }
        }
    } catch (err) {
        console.error(`[Inactivity] Error sending DM to owner:`, err);
    }

    // Set 3-minute timer
    setInactivityTimer(channelId, async () => {
        try {
            // First check if channel is still registered in our state
            const channelState = getChannelState(channelId);
            if (!channelState) {
                console.log(`[Inactivity] Channel ${channelId} no longer in state, skipping deletion`);
                return;
            }

            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.log(`[Inactivity] Guild ${guildId} not found, cleaning up state`);
                await deletePrivateChannel(channelId, guildId);
                return;
            }

            const channel = guild.channels.cache.get(channelId);
            if (!channel) {
                console.log(`[Inactivity] Channel ${channelId} not found in Discord, cleaning up state`);
                await deletePrivateChannel(channelId, guildId);
                return;
            }
            
            if (channel.type !== ChannelType.GuildVoice) {
                console.log(`[Inactivity] Channel ${channelId} is not a voice channel, skipping`);
                return;
            }

            // Double-check channel is still empty
            if (channel.members.size === 0) {
                console.log(`[Inactivity] Deleting inactive channel ${channelName} (${channelId})`);
                
                // Log channel deletion
                await logAction({
                    action: LogAction.CHANNEL_DELETED,
                    guild: guild,
                    channelName: channelName,
                    channelId: channelId,
                    details: `Channel deleted due to 3 minutes of inactivity`,
                });

                await deletePrivateChannel(channelId, guildId);
            } else {
                console.log(`[Inactivity] Channel ${channelName} has ${channel.members.size} members, canceling deletion`);
            }
        } catch (err) {
            console.error(`[Inactivity] Error in timer callback for ${channelId}:`, err);
            // Try to cleanup anyway
            try {
                await deletePrivateChannel(channelId, guildId);
            } catch {}
        }
    }, 3 * 60 * 1000); // 3 minutes
}

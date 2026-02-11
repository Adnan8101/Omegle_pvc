import { ChannelType, Events, type VoiceState, EmbedBuilder, AuditLogEvent, AttachmentBuilder, VoiceChannel } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import {
    getChannelState,
    isInterfaceChannel,
    registerChannel,
    unregisterChannel,
    getChannelByOwner,
    addUserToJoinOrder,
    removeUserFromJoinOrder,
    getNextUserInOrder,
    transferOwnership,
    isOnCooldown,
    setCooldown,
    hasTempPermission,
    unregisterInterfaceChannel,
    registerInterfaceChannel,
    isTeamInterfaceChannel,
    getTeamInterfaceType,
    registerTeamChannel,
    registerTeamInterfaceChannel,
    unregisterTeamChannel,
    getTeamChannelState,
    getTeamChannelByOwner,
    transferTeamOwnership,
    TEAM_USER_LIMITS,
    type TeamType,
    acquireCreationLock,
    releaseCreationLock,
} from '../utils/voiceManager';
import { getOwnerPermissions } from '../utils/permissions';
import { vcnsBridge } from '../vcns/bridge';
import { stateStore, ownershipMachine } from '../vcns/index';
import { accessProtectionHandler } from '../vcns/accessProtectionHandler';
import {
    getGuildSettings,
    getOwnerPermissions as getCachedOwnerPerms,
    getChannelPermissions,
    getWhitelist,
    batchUpsertPermissions,
    invalidateChannelPermissions,
} from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';
import { generateVcInterfaceEmbed, generateInterfaceImage, createInterfaceComponents } from '../utils/canvasGenerator';
import { isPvcPaused } from '../utils/pauseManager';
import { recordBotEdit } from './channelUpdate';
import { VoiceStateService } from '../services/voiceStateService';

export const name = Events.VoiceStateUpdate;

export async function execute(client: PVCClient, oldState: VoiceState, newState: VoiceState) {
    const user = oldState?.member?.user || newState?.member?.user;
    if (!user || user.bot) return;

    const leftChannelId = oldState?.channelId;
    const joinedChannelId = newState?.channelId;

    // Handle join events
    if (joinedChannelId && !leftChannelId) {
        await handleJoin(client, newState);
    }

    // Handle leave events
    if (leftChannelId && !joinedChannelId) {
        await handleLeave(client, oldState);
    }

    // Handle channel switches
    if (leftChannelId && joinedChannelId && leftChannelId !== joinedChannelId) {
        await handleLeave(client, oldState);
        await handleJoin(client, newState);
    }
}

export async function handleJoin(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;
    
    console.log(`[HandleJoin] User ${member.user.username} (${member.id}) joined channel ${channelId}`);
    
    // Check if this is an interface channel
    let isInterface = isInterfaceChannel(channelId);
    
    if (!isInterface) {
        const settings = await getGuildSettings(guild.id);
        if (settings?.interfaceVcId === channelId) {
            registerInterfaceChannel(guild.id, channelId);
            isInterface = true;
            console.log(`[VCNS-HANDLEJOIN] ✅ Registered ${channelId} as interface channel`);
        }
    }

    if (isInterface) {
        console.log(`[VCNS-HANDLEJOIN] 🎯 Channel IS an interface - checking PVC pause status`);
        if (isPvcPaused(guild.id)) {
            console.log(`[VCNS-HANDLEJOIN] ⏸️ PVC is PAUSED - disconnecting user`);
            try {
                await member.voice.disconnect();
                const pauseEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('⏸️ PVC System Paused')
                    .setDescription(
                        `The Private Voice Channel system in **${guild.name}** is currently paused.\n\n` +
                        'Channel creation is temporarily disabled.\n' +
                        'Please wait for an administrator to resume the system.'
                    )
                    .setTimestamp();
                await member.send({ embeds: [pauseEmbed] }).catch(() => { });
            } catch { }
            return;
        }
        console.log(`[VCNS-HANDLEJOIN] 🚀 Calling createPrivateChannel for ${member.user.tag}`);
        await createPrivateChannel(client, state);
        console.log(`[VCNS-HANDLEJOIN] ✅ createPrivateChannel completed for ${member.user.tag}`);
        return;
    }

    // Check for team channels
    let teamType = getTeamInterfaceType(channelId);
    if (!teamType) {
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
        });
        if (teamSettings) {
            if (teamSettings.duoVcId === channelId) {
                teamType = 'duo';
            } else if (teamSettings.trioVcId === channelId) {
                teamType = 'trio';
            } else if (teamSettings.squadVcId === channelId) {
                teamType = 'squad';
            }
        }
    }

    if (teamType) {
        console.log(`[VCNS-HANDLEJOIN] 🎯 Team interface channel ${channelId} - creating ${teamType} channel`);
        await createTeamChannel(client, state, teamType);
        return;
    }

    // Handle existing private voice channels
    const pvcChannelState = getChannelState(channelId);
    if (pvcChannelState) {
        const channel = guild.channels.cache.get(channelId);
        addUserToJoinOrder(channelId, member.id);
        
        // Cancel any pending ownership transfer since a new user has joined
        const hadPendingTransfer = ownershipMachine.cancelTransfer(channelId);
        if (hadPendingTransfer) {
            console.log(`[HandleJoin] ✅ Canceled pending ownership transfer for ${channelId} - new user ${member.user.tag} joined`);
        }
        
        // Use new access protection handler
        const result = await accessProtectionHandler.validateAndEnforceAccess(state);
        const shouldKick = !result.allowed;
        if (shouldKick) {
            console.log(`[HandleJoin] 🚫 User ${member.user.tag} was denied access to PVC ${channelId}`);
            return;
        }
        
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
        return;
    }

    // Handle existing team channels
    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {
        const channel = guild.channels.cache.get(channelId);
        addUserToJoinOrder(channelId, member.id);
        
        // Cancel any pending ownership transfer since a new user has joined
        const hadPendingTransfer = ownershipMachine.cancelTransfer(channelId);
        if (hadPendingTransfer) {
            console.log(`[HandleJoin] ✅ Canceled pending team channel ownership transfer for ${channelId} - new user ${member.user.tag} joined`);
        }
        
        // Use new access protection handler
        const result = await accessProtectionHandler.validateAndEnforceAccess(state);
        const shouldKick = !result.allowed;
        if (shouldKick) {
            console.log(`[HandleJoin] 🚫 User ${member.user.tag} was denied access to team channel ${channelId}`);
            return;
        }
        
        if (channel) {
            await logAction({
                action: LogAction.USER_ADDED,
                guild: guild,
                user: member.user,
                channelName: channel.name,
                channelId: channelId,
                details: `${member.user.username} joined the team channel`,
                isTeamChannel: true,
                teamType: teamChannelState.teamType,
            });
        }
    }
}

export async function handleLeave(client: PVCClient, state: VoiceState): Promise<void> {
    const { channelId, guild, member } = state;
    if (!channelId || !member) return;

    console.log(`[HandleLeave] User ${member.user.username} (${member.id}) left channel ${channelId}`);

    // Remove from join order
    removeUserFromJoinOrder(channelId, member.id);

    // Handle private voice channels
    const channelState = getChannelState(channelId);
    if (channelState) {
        await handlePrivateChannelLeave(client, state, channelState);
        return;
    }

    // Handle team voice channels
    const teamChannelState = getTeamChannelState(channelId);
    if (teamChannelState) {
        await handleTeamChannelLeave(client, state, teamChannelState);
        return;
    }
}

// Placeholder functions - will be properly implemented later
async function createPrivateChannel(client: PVCClient, state: VoiceState): Promise<void> {
    console.log(`[CreatePrivateChannel] Creating private channel for ${state.member?.user.tag}`);
    // Implementation will be restored from backup
}

async function createTeamChannel(client: PVCClient, state: VoiceState, teamType: TeamType): Promise<void> {
    console.log(`[CreateTeamChannel] Creating team channel (${teamType}) for ${state.member?.user.tag}`);
    // Implementation will be restored from backup
}

async function handlePrivateChannelLeave(client: PVCClient, state: VoiceState, channelState: any): Promise<void> {
    const { channelId, guild, member } = state;
    if (!member || !channelId) return;
    
    if (member.id === channelState.ownerId) {
        console.log(`[HandleLeave] 👑 Owner ${member.user.tag} left channel ${channelId} - initiating delayed transfer`);
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (channel) {
            await ownershipMachine.initiateTransfer({
                channelId,
                guild,
                channel,
                client,
                oldOwnerId: member.id,
                isTeamChannel: false
            });
        }
    }
    
    await checkAndDeleteEmptyChannel(client, channelId, guild);
}

async function handleTeamChannelLeave(client: PVCClient, state: VoiceState, channelState: any): Promise<void> {
    const { channelId, guild, member } = state;
    if (!member || !channelId) return;
    
    if (member.id === channelState.ownerId) {
        console.log(`[HandleLeave] 👑 Team channel owner ${member.user.tag} left channel ${channelId} - initiating delayed transfer`);
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (channel) {
            await ownershipMachine.initiateTransfer({
                channelId,
                guild,
                channel,
                client,
                oldOwnerId: member.id,
                isTeamChannel: true
            });
        }
    }
    
    await checkAndDeleteEmptyChannel(client, channelId, guild);
}

async function checkAndDeleteEmptyChannel(client: PVCClient, channelId: string, guild: any): Promise<void> {
    const channel = guild.channels.cache.get(channelId) as VoiceChannel;
    if (channel && channel.members.size === 0) {
        console.log(`[HandleLeave] 🗑️ Channel ${channelId} is empty - scheduling for deletion`);
        setTimeout(async () => {
            const updatedChannel = guild.channels.cache.get(channelId) as VoiceChannel;
            if (updatedChannel && updatedChannel.members.size === 0) {
                try {
                    await updatedChannel.delete();
                    unregisterChannel(channelId);
                    unregisterTeamChannel(channelId);
                    console.log(`[HandleLeave] ✅ Deleted empty channel ${channelId}`);
                } catch (error) {
                    console.error(`[HandleLeave] ❌ Failed to delete channel ${channelId}:`, error);
                }
            }
        }, 1000);
    }
}

export async function deletePrivateChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const channel = await prisma.privateVoiceChannel.findUnique({
            where: { channelId }
        });
        
        if (channel) {
            await prisma.privateVoiceChannel.delete({
                where: { channelId }
            });
            unregisterChannel(channelId);
            console.log(`[DeletePrivateChannel] ✅ Deleted private channel ${channelId} from database`);
        }
    } catch (error) {
        console.error(`[DeletePrivateChannel] ❌ Error deleting private channel ${channelId}:`, error);
    }
}

export async function deleteTeamChannel(channelId: string, guildId: string): Promise<void> {
    try {
        const channel = await prisma.teamVoiceChannel.findUnique({
            where: { channelId }
        });
        
        if (channel) {
            await prisma.teamVoiceChannel.delete({
                where: { channelId }
            });
            unregisterTeamChannel(channelId);
            console.log(`[DeleteTeamChannel] ✅ Deleted team channel ${channelId} from database`);
        }
    } catch (error) {
        console.error(`[DeleteTeamChannel] ❌ Error deleting team channel ${channelId}:`, error);
    }
}

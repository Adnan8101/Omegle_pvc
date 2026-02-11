import { stateStore } from './index';
import { actionExecutor } from './actionExecutor';
import { getChannelState, getTeamChannelState, getNextUserInOrder } from '../utils/voiceManager';
import { logAction, LogAction } from '../utils/logger';
import type { Guild, VoiceChannel, GuildMember } from 'discord.js';
import type { PVCClient } from '../client';
export enum OwnershipTransferState {
    IDLE = 'IDLE',
    OWNER_LEFT = 'OWNER_LEFT',
    PENDING_TRANSFER = 'PENDING_TRANSFER',
    CANCELLED = 'CANCELLED',
    TRANSFERRED = 'TRANSFERRED',
    DELETED = 'DELETED'
}
export interface OwnershipTransferContext {
    channelId: string;
    guild: Guild;
    channel: VoiceChannel;
    client: PVCClient;
    oldOwnerId: string;
    isTeamChannel: boolean;
}
export interface TransferCandidate {
    userId: string;
    member: GuildMember;
    source: 'JOIN_ORDER' | 'FALLBACK';
}
export class OwnershipTransferMachine {
    private transfers: Map<string, {
        state: OwnershipTransferState;
        context: OwnershipTransferContext;
        candidate?: TransferCandidate;
        timeout?: NodeJS.Timeout;
        startTime: number;
    }> = new Map();
    public async initiateTransfer(context: OwnershipTransferContext): Promise<void> {
        const { channelId, guild, channel, oldOwnerId } = context;
        this.cancelTransfer(channelId);
        console.log(`[OwnershipMachine] 🔄 Initiating transfer for channel ${channelId}, owner ${oldOwnerId} left`);
        const isValid = await this.validateTransferContext(context);
        if (!isValid) {
            console.log(`[OwnershipMachine] ❌ Transfer context invalid, aborting`);
            return;
        }
        const candidate = await this.findTransferCandidate(context);
        if (!candidate) {
            console.log(`[OwnershipMachine] ❌ No transfer candidate found, scheduling deletion`);
            await this.scheduleChannelDeletion(context);
            return;
        }
        const transferData = {
            state: OwnershipTransferState.PENDING_TRANSFER,
            context,
            candidate,
            startTime: Date.now(),
            timeout: setTimeout(() => {
                this.executeTransfer(channelId);
            }, 3000)
        };
        this.transfers.set(channelId, transferData);
        console.log(`[OwnershipMachine] ⏰ Scheduled transfer to ${candidate.member.user.tag} in 3 seconds`);
        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: candidate.member.user,
            channelName: channel.name,
            channelId: channelId,
            details: `Transfer scheduled to ${candidate.member.user.username} (3s delay)`,
            isTeamChannel: context.isTeamChannel,
        });
    }
    public cancelTransfer(channelId: string): boolean {
        const transfer = this.transfers.get(channelId);
        if (!transfer) {
            return false;
        }
        console.log(`[OwnershipMachine] ❌ Canceling transfer for channel ${channelId}`);
        if (transfer.timeout) {
            clearTimeout(transfer.timeout);
        }
        transfer.state = OwnershipTransferState.CANCELLED;
        this.transfers.delete(channelId);
        return true;
    }
    public hasPendingTransfer(channelId: string): boolean {
        const transfer = this.transfers.get(channelId);
        return transfer?.state === OwnershipTransferState.PENDING_TRANSFER;
    }
    private async executeTransfer(channelId: string): Promise<void> {
        const transfer = this.transfers.get(channelId);
        if (!transfer || transfer.state !== OwnershipTransferState.PENDING_TRANSFER) {
            console.log(`[OwnershipMachine] ⚠️ Transfer execution called but no pending transfer for ${channelId}`);
            return;
        }
        const { context, candidate } = transfer;
        if (!candidate) {
            console.log(`[OwnershipMachine] ❌ No candidate for transfer execution`);
            this.transfers.delete(channelId);
            return;
        }
        try {
            console.log(`[OwnershipMachine] ⚡ Executing transfer for ${channelId} to ${candidate.member.user.tag}`);
            const stillValid = await this.validateExecutionContext(context, candidate);
            if (!stillValid) {
                console.log(`[OwnershipMachine] ❌ Transfer context no longer valid, finding new candidate`);
                await this.findAlternativeCandidate(context);
                return;
            }
            await this.performOwnershipTransfer(context, candidate);
            transfer.state = OwnershipTransferState.TRANSFERRED;
            console.log(`[OwnershipMachine] ✅ Transfer completed successfully`);
        } catch (error) {
            console.error(`[OwnershipMachine] ❌ Transfer execution failed:`, error);
        } finally {
            this.transfers.delete(channelId);
        }
    }
    private async validateTransferContext(context: OwnershipTransferContext): Promise<boolean> {
        const { channelId, channel, client } = context;
        const currentChannel = client.channels.cache.get(channelId);
        if (!currentChannel) {
            console.log(`[OwnershipMachine] ❌ Channel ${channelId} no longer exists`);
            return false;
        }
        const nonBotMembers = channel.members.filter(m => !m.user.bot);
        if (nonBotMembers.size === 0) {
            console.log(`[OwnershipMachine] ❌ No non-bot members in channel ${channelId}`);
            return false;
        }
        return true;
    }
    private async findTransferCandidate(context: OwnershipTransferContext): Promise<TransferCandidate | null> {
        const { channelId, channel, guild, oldOwnerId } = context;
        const nextUserId = getNextUserInOrder(channelId);
        if (nextUserId) {
            const member = guild.members.cache.get(nextUserId);
            if (member && channel.members.has(nextUserId)) {
                console.log(`[OwnershipMachine] ✅ Found candidate from join order: ${member.user.tag}`);
                return {
                    userId: nextUserId,
                    member,
                    source: 'JOIN_ORDER'
                };
            }
        }
        const availableMember = channel.members.find(m => 
            m.id !== oldOwnerId && 
            !m.user.bot &&
            guild.members.cache.has(m.id)
        );
        if (availableMember) {
            console.log(`[OwnershipMachine] ✅ Found fallback candidate: ${availableMember.user.tag}`);
            return {
                userId: availableMember.id,
                member: availableMember,
                source: 'FALLBACK'
            };
        }
        return null;
    }
    private async validateExecutionContext(context: OwnershipTransferContext, candidate: TransferCandidate): Promise<boolean> {
        const { channelId, channel, client } = context;
        const currentChannel = client.channels.cache.get(channelId) as VoiceChannel;
        if (!currentChannel) {
            return false;
        }
        if (!currentChannel.members.has(candidate.userId)) {
            console.log(`[OwnershipMachine] ❌ Candidate ${candidate.member.user.tag} no longer in channel`);
            return false;
        }
        const nonBotMembers = currentChannel.members.filter(m => !m.user.bot);
        if (nonBotMembers.size === 0) {
            return false;
        }
        return true;
    }
    private async findAlternativeCandidate(context: OwnershipTransferContext): Promise<void> {
        const { channelId, client } = context;
        const currentChannel = client.channels.cache.get(channelId) as VoiceChannel;
        if (!currentChannel) {
            await this.scheduleChannelDeletion(context);
            return;
        }
        const newCandidate = await this.findTransferCandidate({
            ...context,
            channel: currentChannel
        });
        if (!newCandidate) {
            console.log(`[OwnershipMachine] ❌ No alternative candidate found, deleting channel`);
            await this.scheduleChannelDeletion(context);
            return;
        }
        await this.performOwnershipTransfer(context, newCandidate);
    }
    private async performOwnershipTransfer(context: OwnershipTransferContext, candidate: TransferCandidate): Promise<void> {
        const { channelId, guild, channel, isTeamChannel, oldOwnerId } = context;
        const { userId: newOwnerId, member: newOwner } = candidate;
        console.log(`[OwnershipMachine] 🎬 Performing ownership transfer: ${oldOwnerId} → ${newOwnerId}`);
        if (isTeamChannel) {
            const { transferTeamOwnership } = await import('../utils/voiceManager');
            transferTeamOwnership(channelId, newOwnerId);
            stateStore.transferOwnership(channelId, newOwnerId);
            const prisma = (await import('../utils/database')).default;
            await prisma.teamVoiceChannel.update({
                where: { channelId },
                data: { ownerId: newOwnerId },
            });
        } else {
            const { transferOwnership } = await import('../utils/voiceManager');
            transferOwnership(channelId, newOwnerId);
            stateStore.transferOwnership(channelId, newOwnerId);
            const prisma = (await import('../utils/database')).default;
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { ownerId: newOwnerId },
            });
        }
        await this.executeDiscordTransfer(context, candidate);
        await logAction({
            action: LogAction.CHANNEL_TRANSFERRED,
            guild: guild,
            user: newOwner.user,
            channelName: channel.name,
            channelId: channelId,
            details: `Ownership transferred to ${newOwner.user.username} (delayed transfer)`,
            isTeamChannel: isTeamChannel,
        });
    }
    private async executeDiscordTransfer(context: OwnershipTransferContext, candidate: TransferCandidate): Promise<void> {
        const { channelId, guild, oldOwnerId, isTeamChannel } = context;
        const { userId: newOwnerId, member: newOwner } = candidate;
        if (oldOwnerId) {
            await actionExecutor.executePermissionChange({
                guild,
                channelId,
                targetId: oldOwnerId,
                permissions: {},
                remove: true,
                reason: 'Ownership transferred - removing old owner permissions',
            });
        }
        await actionExecutor.executePermissionChange({
            guild,
            channelId,
            targetId: newOwnerId,
            permissions: {
                ViewChannel: true,
                Connect: true,
                Speak: true,
                Stream: true,
                SendMessages: true,
                EmbedLinks: true,
                AttachFiles: true,
                MuteMembers: true,
                DeafenMembers: true,
                ManageChannels: true,
            },
            reason: 'Ownership transferred - granting new owner permissions',
        });
        const newName = isTeamChannel
            ? `${newOwner.displayName}'s Team` 
            : newOwner.displayName;
        await actionExecutor.executeChannelRename({
            guild,
            channelId,
            newName,
            reason: `Ownership transferred to ${newOwner.user.username}`,
        });
    }
    private async scheduleChannelDeletion(context: OwnershipTransferContext): Promise<void> {
        const { channelId, guild, isTeamChannel } = context;
        console.log(`[OwnershipMachine] 🗑️ Scheduling channel deletion for ${channelId} (no transfer candidates)`);
        setTimeout(async () => {
            try {
                if (isTeamChannel) {
                    const deleteTeamChannel = (await import('../events/voiceStateUpdate')).deleteTeamChannel;
                    await deleteTeamChannel(channelId, guild.id);
                } else {
                    const deletePrivateChannel = (await import('../events/voiceStateUpdate')).deletePrivateChannel; 
                    await deletePrivateChannel(channelId, guild.id);
                }
            } catch (error) {
                console.error(`[OwnershipMachine] ❌ Error during scheduled deletion:`, error);
            }
        }, 3000);
    }
    public cleanup(): void {
        const now = Date.now();
        const staleTimeout = 30000; 
        for (const [channelId, transfer] of this.transfers) {
            if (now - transfer.startTime > staleTimeout) {
                console.log(`[OwnershipMachine] 🧹 Cleaning up stale transfer for ${channelId}`);
                this.cancelTransfer(channelId);
            }
        }
    }
}
export const ownershipMachine = new OwnershipTransferMachine();
setInterval(() => {
    ownershipMachine.cleanup();
}, 5 * 60 * 1000);
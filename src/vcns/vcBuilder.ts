import {
    ChannelType,
    type Guild,
    type VoiceChannel,
    PermissionFlagsBits,
    type OverwriteResolvable,
} from 'discord.js';
import { client } from '../client';
import { stateStore } from './stateStore';
import { rateGovernor } from './rateGovernor';
import { lockManager } from './lockManager';
import { IntentAction, VCNS_CONFIG } from './types';
import prisma from '../utils/database';
import { recordBotEdit } from '../events/channelUpdate';
import { vcCreateLockKey } from './resourceKeys';
export interface VCBuildOptions {
    guildId: string;
    categoryId: string;
    ownerId: string;
    name: string;
    isTeamChannel: boolean;
    teamType?: 'DUO' | 'TRIO' | 'SQUAD';
    userLimit?: number;
    bitrate?: number;
    customPermissions?: OverwriteResolvable[];
    skipDbWrite?: boolean;
    skipLock?: boolean;
    lockHolder?: string; // CRITICAL FIX #3: Allow caller to specify lock holder
}
export interface VCBuildResult {
    success: boolean;
    channelId?: string;
    error?: string;
    retryable?: boolean;
    rateLimitHit?: boolean;
    rateLimitRetryAfter?: number;
}
export async function buildVC(options: VCBuildOptions): Promise<VCBuildResult> {
    const { guildId, categoryId, ownerId, name, isTeamChannel, teamType, userLimit, bitrate, customPermissions, skipDbWrite, skipLock, lockHolder } = options;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return { success: false, error: 'Guild not found', retryable: false };
    }
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
        return { success: false, error: 'Category not found', retryable: false };
    }
    const lockKey = vcCreateLockKey(guildId, ownerId);
    // CRITICAL FIX #3: Use provided lockHolder or fallback (for immediate path compatibility)
    const effectiveLockHolder = lockHolder || `vcBuilder:${ownerId}`;
    const needsLock = !skipLock;
    
    if (needsLock) {
        if (!lockManager.acquire(lockKey, effectiveLockHolder, VCNS_CONFIG.VC_CREATE_LOCK_DURATION_MS, 'VC creation')) {
            return { success: false, error: 'Creation lock failed - operation in progress', retryable: true };
        }
    }
    
    try {
        const existingChannel = stateStore.getChannelByOwner(guildId, ownerId);
        if (existingChannel) {
            if (needsLock) lockManager.release(lockKey, effectiveLockHolder);
            return { success: false, error: 'User already owns a channel', retryable: false };
        }
        const permissionOverwrites: OverwriteResolvable[] = customPermissions || buildDefaultPermissions(guild, ownerId);
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildVoice,
            parent: categoryId,
            userLimit: userLimit ?? 0,
            bitrate: bitrate ?? VCNS_CONFIG.DEFAULT_BITRATE,
            permissionOverwrites,
        }) as VoiceChannel;
        recordBotEdit(channel.id);
        stateStore.registerChannel({
            channelId: channel.id,
            guildId,
            ownerId,
            isLocked: true,
            isHidden: false,
            isTeamChannel,
            teamType,
            operationPending: false,
            lastModified: Date.now(),
        });
        rateGovernor.recordAction(IntentAction.VC_CREATE, 30);
        rateGovernor.recordSuccess(`channel:${guildId}`);
        if (!skipDbWrite) {
            await writeToDatabase(channel.id, guildId, ownerId, isTeamChannel, teamType);
        }
        return {
            success: true,
            channelId: channel.id,
        };
    } catch (error: any) {
        const result = handleError(error, guildId);
        return result;
    } finally {
        if (needsLock) {
            lockManager.release(lockKey, effectiveLockHolder);
        }
    }
}
function buildDefaultPermissions(guild: Guild, ownerId: string): OverwriteResolvable[] {
    return [
        {
            id: guild.id,
            deny: [PermissionFlagsBits.Connect],
        },
        {
            id: ownerId,
            allow: [
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.Stream,
                PermissionFlagsBits.MoveMembers,
            ],
        },
        {
            id: client.user!.id,
            allow: [
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.MoveMembers,
            ],
        },
    ];
}
async function writeToDatabase(
    channelId: string,
    guildId: string,
    ownerId: string,
    isTeamChannel: boolean,
    teamType?: 'DUO' | 'TRIO' | 'SQUAD',
): Promise<void> {
    try {
        if (isTeamChannel) {
            await prisma.teamVoiceChannel.create({
                data: {
                    channelId,
                    guildId,
                    ownerId,
                    teamType: teamType!,
                    isLocked: true,
                    isHidden: false,
                },
            });
        } else {
            await prisma.privateVoiceChannel.create({
                data: {
                    channelId,
                    guildId,
                    ownerId,
                    isLocked: true,
                    isHidden: false,
                },
            });
        }
    } catch (error: any) {
        // CRITICAL FIX #4: Stop swallowing DB errors - log them for debugging
        console.error(`[VCBuilder] Database write failed for channel ${channelId}:`, {
            error: error.message,
            channelId,
            guildId,
            ownerId,
            isTeamChannel,
            teamType
        });
        // DB write failure doesn't block VC creation, but must be visible
    }
}
function handleError(error: any, guildId: string): VCBuildResult {
    if (error?.status === 429 || error?.code === 429) {
        const retryAfter = (error.retry_after || 1) * 1000;
        const isGlobal = error.message?.includes('global') || false;
        rateGovernor.recordRateLimitHit(`channel:${guildId}`, retryAfter, isGlobal);
        return {
            success: false,
            error: 'Rate limited',
            retryable: true,
            rateLimitHit: true,
            rateLimitRetryAfter: retryAfter,
        };
    }
    const retryableCodes = [10003, 50013];
    const isRetryable = (error?.status >= 500 && error?.status < 600) || retryableCodes.includes(error?.code);
    return {
        success: false,
        error: error.message || 'Unknown error',
        retryable: isRetryable,
    };
}

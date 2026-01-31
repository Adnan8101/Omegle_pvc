import {
    ChannelType,
    type VoiceChannel,
    type Guild,
    PermissionFlagsBits,
    OverwriteType,
    type PermissionOverwrites,
} from 'discord.js';
import { client } from '../client';
import prisma from '../utils/database';
import {
    Intent,
    IntentAction,
    IntentStatus,
    WorkerResult,
    VCCreatePayload,
    VCDeletePayload,
    PermissionPayload,
    UserActionPayload,
    LogPayload,
    VCNS_CONFIG,
} from './types';
import { stateStore } from './stateStore';
import { rateGovernor } from './rateGovernor';
import { intentQueue } from './intentQueue';
import { lockManager } from './lockManager';
import { recordBotEdit } from '../events/channelUpdate';
import { buildVC } from './vcBuilder';
import { ownerTransferLockKey } from './resourceKeys';

// CRITICAL: User cooldown and flood protection
const USER_COOLDOWNS = new Map<string, number>(); // guildId:userId -> lastActionTime
const USER_COOLDOWN_MS = 3000; // 3 seconds between VC actions per user
const QUEUE_SIZE_LIMIT = 50; // Max intents in queue before rejection
const GUILD_QUEUE_LIMIT = 10; // Max intents per guild before rejection

function isUserOnCooldown(guildId: string, userId: string): boolean {
    const key = `${guildId}:${userId}`;
    const lastAction = USER_COOLDOWNS.get(key);
    if (!lastAction) return false;
    return Date.now() - lastAction < USER_COOLDOWN_MS;
}

function setUserCooldown(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    USER_COOLDOWNS.set(key, Date.now());
    // Cleanup old cooldowns every 100 entries
    if (USER_COOLDOWNS.size > 1000) {
        const cutoff = Date.now() - USER_COOLDOWN_MS * 2;
        for (const [k, time] of USER_COOLDOWNS) {
            if (time < cutoff) USER_COOLDOWNS.delete(k);
        }
    }
}

function shouldAdmitIntent(intent: Intent<unknown>): { admit: boolean; reason?: string } {
    // CRITICAL: Admission control - reject before queueing
    
    // Check overall queue size
    const currentQueueSize = intentQueue.size?.() || 0;
    if (currentQueueSize > QUEUE_SIZE_LIMIT) {
        return { admit: false, reason: 'System overloaded - queue full' };
    }
    
    // Check emergency mode for VC creation
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    if (isEmergencyMode && intent.action === IntentAction.VC_CREATE) {
        return { admit: false, reason: 'System overloaded - VC creation suspended' };
    }
    
    // Check user cooldown for VC creation
    if (intent.action === IntentAction.VC_CREATE) {
        const payload = intent.payload as VCCreatePayload;
        if (isUserOnCooldown(intent.guildId, payload.ownerId)) {
            return { admit: false, reason: 'Please wait before creating another VC' };
        }
    }
    
    return { admit: true };
}
interface PermissionMergeOptions {
    allow?: Record<string, boolean>;
    deny?: Record<string, boolean>;
    neutral?: string[]; 
}
function mergePermissionOverwrites(
    existing: PermissionOverwrites | undefined,
    changes: PermissionMergeOptions,
): { allow: bigint; deny: bigint } {
    let allowBits = existing?.allow.bitfield ?? BigInt(0);
    let denyBits = existing?.deny.bitfield ?? BigInt(0);
    const flagMap: Record<string, bigint> = {
        Connect: PermissionFlagsBits.Connect,
        ViewChannel: PermissionFlagsBits.ViewChannel,
        Speak: PermissionFlagsBits.Speak,
        Stream: PermissionFlagsBits.Stream,
        MoveMembers: PermissionFlagsBits.MoveMembers,
        MuteMembers: PermissionFlagsBits.MuteMembers,
        DeafenMembers: PermissionFlagsBits.DeafenMembers,
        UseVAD: PermissionFlagsBits.UseVAD,
        PrioritySpeaker: PermissionFlagsBits.PrioritySpeaker,
    };
    if (changes.allow) {
        for (const [perm, value] of Object.entries(changes.allow)) {
            const bit = flagMap[perm];
            if (bit !== undefined && value) {
                allowBits |= bit;
                denyBits &= ~bit; 
            }
        }
    }
    if (changes.deny) {
        for (const [perm, value] of Object.entries(changes.deny)) {
            const bit = flagMap[perm];
            if (bit !== undefined && value) {
                denyBits |= bit;
                allowBits &= ~bit; 
            }
        }
    }
    if (changes.neutral) {
        for (const perm of changes.neutral) {
            const bit = flagMap[perm];
            if (bit !== undefined) {
                allowBits &= ~bit;
                denyBits &= ~bit;
            }
        }
    }
    return { allow: allowBits, deny: denyBits };
}
interface OwnerTransferPayload {
    channelId: string;
    newOwnerId: string;
}
function success(intent: Intent<unknown>, executionTimeMs: number, data?: Record<string, unknown>): WorkerResult {
    return {
        success: true,
        intentId: intent.id,
        action: intent.action,
        executionTimeMs,
        retryable: false,
        rateLimitHit: false,
        data,
    };
}
function failure(
    intent: Intent<unknown>,
    executionTimeMs: number,
    error: string,
    retryable: boolean = false,
    rateLimitHit: boolean = false,
    rateLimitRetryAfter?: number,
): WorkerResult {
    return {
        success: false,
        intentId: intent.id,
        action: intent.action,
        executionTimeMs,
        error,
        retryable,
        rateLimitHit,
        rateLimitRetryAfter,
    };
}
function isRateLimitError(error: any): { isRateLimit: boolean; retryAfter?: number; isGlobal?: boolean } {
    if (error?.status === 429 || error?.code === 429) {
        const retryAfter = (error.retry_after || 1) * 1000;
        const isGlobal = error.message?.includes('global') || false;
        return { isRateLimit: true, retryAfter, isGlobal };
    }
    return { isRateLimit: false };
}
function isRetryableError(error: any): boolean {
    if (error?.status >= 500 && error?.status < 600) {
        return true;
    }
    const retryableCodes = [
        10003, 
        50013, 
    ];
    return retryableCodes.includes(error?.code);
}
async function executeVCCreate(intent: Intent<VCCreatePayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    
    // Early validation
    if (Date.now() > intent.expiresAt) {
        return failure(intent, Date.now() - startTime, 'Intent expired during execution', false);
    }
    
    // Validate required payload fields
    if (!payload.guildId || !payload.categoryId || !payload.ownerId) {
        return failure(intent, Date.now() - startTime, 'Invalid VC creation payload - missing required fields', false);
    }
    
    // CRITICAL: Admission control check (should have been done before queueing, but double-check)
    const admission = shouldAdmitIntent(intent);
    if (!admission.admit) {
        return failure(intent, Date.now() - startTime, admission.reason || 'Request rejected', false);
    }
    
    // CRITICAL: Duplicate VC prevention - check if user already owns a VC
    const existingChannelId = stateStore.getChannelByOwner(payload.guildId, payload.ownerId);
    if (existingChannelId) {
        console.warn(`[Workers] VC creation blocked - user already owns VC:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            existingChannelId: existingChannelId
        });
        return failure(intent, Date.now() - startTime, 'User already owns a voice channel', false);
    }
    
    // CRITICAL: User cooldown check
    if (isUserOnCooldown(payload.guildId, payload.ownerId)) {
        return failure(intent, Date.now() - startTime, 'Please wait before creating another VC', false);
    }
    
    // CRITICAL: Backpressure protection - reject during high pressure
    if (rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode()) {
        console.warn(`[Workers] VC creation rejected - emergency mode active:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            guildId: payload.guildId
        });
        return failure(intent, Date.now() - startTime, 'System overloaded - please try again later', false);
    }
    
    // CRITICAL: Fail fast on repeated attempts to prevent retry storm
    if (intent.attempts > 2) {
        console.warn(`[Workers] VC creation rejected - too many attempts:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            attempts: intent.attempts
        });
        return failure(intent, Date.now() - startTime, 'VC creation failed after multiple attempts', false);
    }
    
    // Set cooldown before attempting creation
    setUserCooldown(payload.guildId, payload.ownerId);
    
    console.info(`[Workers] Starting VC creation:`, {
        intentId: intent.id,
        guildId: payload.guildId,
        ownerId: payload.ownerId,
        isTeamChannel: payload.isTeamChannel,
        attempt: intent.attempts
    });
    
    const result = await buildVC({
        guildId: payload.guildId,
        categoryId: payload.categoryId,
        ownerId: payload.ownerId,
        name: payload.name,
        isTeamChannel: payload.isTeamChannel,
        teamType: payload.teamType,
        userLimit: payload.userLimit,
        bitrate: payload.bitrate,
        skipDbWrite: false,
        skipLock: true, // Intent system already holds the lock
        lockHolder: intent.id, // CRITICAL FIX #3: Use intent.id as lock holder
    });
    
    const execTime = Date.now() - startTime;
    if (result.success) {
        console.info(`[Workers] VC creation successful:`, {
            intentId: intent.id,
            channelId: result.channelId,
            executionTimeMs: execTime
        });
        return success(intent, execTime, { channelId: result.channelId });
    }
    
    // Log VC creation failure with context
    console.error(`[Workers] VC creation failed:`, {
        intentId: intent.id,
        guildId: payload.guildId,
        ownerId: payload.ownerId,
        error: result.error,
        retryable: result.retryable,
        executionTimeMs: execTime
    });
    
    return failure(
        intent,
        execTime,
        result.error || 'Unknown error',
        result.retryable ?? false,
        result.rateLimitHit ?? false,
        result.rateLimitRetryAfter,
    );
}
async function executeVCDelete(intent: Intent<VCDeletePayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    try {
        const channelState = stateStore.getChannelState(payload.channelId);
        if (!channelState) {
            return success(intent, Date.now() - startTime);
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            stateStore.unregisterChannel(payload.channelId);
            return success(intent, Date.now() - startTime);
        }
        const channel = guild.channels.cache.get(payload.channelId);
        if (!channel) {
            stateStore.unregisterChannel(payload.channelId);
            try {
                await prisma.privateVoiceChannel.delete({
                    where: { channelId: payload.channelId },
                });
            } catch (err: any) {
                // DB cleanup failure after channel already missing - log but don't fail intent
                console.error(`[Workers] CRITICAL: DB cleanup failed for missing private channel ${payload.channelId}:`, {
                    error: err.message,
                    intentId: intent.id,
                    channelId: payload.channelId
                });
            }
            try {
                await prisma.teamVoiceChannel.delete({
                    where: { channelId: payload.channelId },
                });
            } catch (err: any) {
                // DB cleanup failure after channel already missing - log but don't fail intent
                console.error(`[Workers] CRITICAL: DB cleanup failed for missing team channel ${payload.channelId}:`, {
                    error: err.message,
                    intentId: intent.id,
                    channelId: payload.channelId
                });
            }
            return success(intent, Date.now() - startTime);
        }
        recordBotEdit(payload.channelId);
        await channel.delete(payload.reason || 'PVC cleanup');
        stateStore.unregisterChannel(payload.channelId);
        try {
            await prisma.privateVoiceChannel.delete({
                where: { channelId: payload.channelId },
            });
        } catch (err: any) {
            // CRITICAL: DB cleanup failed after successful Discord deletion - data inconsistency
            console.error(`[Workers] CRITICAL: DB cleanup failed after Discord deletion for private channel ${payload.channelId}:`, {
                error: err.message,
                intentId: intent.id,
                channelId: payload.channelId,
                guildId: intent.guildId
            });
            // TODO: Add to reconciliation queue when implemented
        }
        try {
            await prisma.teamVoiceChannel.delete({
                where: { channelId: payload.channelId },
            });
        } catch (err: any) {
            // CRITICAL: DB cleanup failed after successful Discord deletion - data inconsistency
            console.error(`[Workers] CRITICAL: DB cleanup failed after Discord deletion for team channel ${payload.channelId}:`, {
                error: err.message,
                intentId: intent.id,
                channelId: payload.channelId,
                guildId: intent.guildId
            });
            // TODO: Add to reconciliation queue when implemented
        }
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `channel:${intent.guildId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        if (error?.code === 10003) {
            stateStore.unregisterChannel(payload.channelId);
            return success(intent, execTime);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executePermission(intent: Intent<PermissionPayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    
    // CRITICAL: Emergency mode - limit permission operations during severe overload
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    
    if (isEmergencyMode && currentQueueSize > QUEUE_SIZE_LIMIT * 1.5) {
        return failure(intent, Date.now() - startTime, 'System overloaded - permission operation deferred', true);
    }
    
    try {
        const channelState = stateStore.getChannelState(payload.channelId);
        if (!channelState) {
            return failure(intent, Date.now() - startTime, 'Channel not found in state');
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const channel = guild.channels.cache.get(payload.channelId) as VoiceChannel | undefined;
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return failure(intent, Date.now() - startTime, 'Channel not found or not voice');
        }
        recordBotEdit(payload.channelId);
        const existingOverwrite = channel.permissionOverwrites.cache.get(payload.targetId);
        if (payload.permission === 'permit') {
            const merged = mergePermissionOverwrites(existingOverwrite, {
                allow: { Connect: true, ViewChannel: true, Speak: true },
            });
            await channel.permissionOverwrites.set([
                ...channel.permissionOverwrites.cache
                    .filter(o => o.id !== payload.targetId)
                    .values(),
                {
                    id: payload.targetId,
                    type: payload.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                    allow: merged.allow,
                    deny: merged.deny,
                },
            ]);
        } else if (payload.permission === 'ban') {
            const merged = mergePermissionOverwrites(existingOverwrite, {
                deny: { Connect: true, ViewChannel: true },
            });
            await channel.permissionOverwrites.set([
                ...channel.permissionOverwrites.cache
                    .filter(o => o.id !== payload.targetId)
                    .values(),
                {
                    id: payload.targetId,
                    type: payload.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                    allow: merged.allow,
                    deny: merged.deny,
                },
            ]);
        } else {
            if (existingOverwrite) {
                const merged = mergePermissionOverwrites(existingOverwrite, {
                    neutral: ['Connect', 'ViewChannel', 'Speak'],
                });
                if (merged.allow === BigInt(0) && merged.deny === BigInt(0)) {
                    await channel.permissionOverwrites.delete(payload.targetId);
                } else {
                    await channel.permissionOverwrites.set([
                        ...channel.permissionOverwrites.cache
                            .filter(o => o.id !== payload.targetId)
                            .values(),
                        {
                            id: payload.targetId,
                            type: existingOverwrite.type,
                            allow: merged.allow,
                            deny: merged.deny,
                        },
                    ]);
                }
            }
        }
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `perms:${payload.channelId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executeUserKick(intent: Intent<UserActionPayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    try {
        const guild = client.guilds.cache.get(intent.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const member = await guild.members.fetch(payload.userId).catch(() => null);
        if (!member) {
            return success(intent, Date.now() - startTime); 
        }
        if (!member.voice.channelId) {
            return success(intent, Date.now() - startTime); 
        }
        await member.voice.disconnect(payload.reason || 'Kicked from voice channel');
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `kick:${intent.guildId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executeUserMove(intent: Intent<UserActionPayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    try {
        if (!payload.targetChannelId) {
            return failure(intent, Date.now() - startTime, 'No target channel specified');
        }
        const guild = client.guilds.cache.get(intent.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const member = await guild.members.fetch(payload.userId).catch(() => null);
        if (!member) {
            return success(intent, Date.now() - startTime);
        }
        if (!member.voice.channelId) {
            return success(intent, Date.now() - startTime);
        }
        await member.voice.setChannel(payload.targetChannelId);
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `move:${intent.guildId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executeVCLockToggle(
    intent: Intent<{ channelId: string; isLocked: boolean }>,
): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    
    // CRITICAL: Emergency mode - prioritize lock/unlock operations but with limits
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    
    if (isEmergencyMode && currentQueueSize > QUEUE_SIZE_LIMIT * 2) {
        return failure(intent, Date.now() - startTime, 'System severely overloaded - operation rejected', true);
    }
    
    try {
        const channelState = stateStore.getChannelState(payload.channelId);
        if (!channelState) {
            return failure(intent, Date.now() - startTime, 'Channel not in state');
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const channel = guild.channels.cache.get(payload.channelId) as VoiceChannel | undefined;
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return failure(intent, Date.now() - startTime, 'Channel not found');
        }
        recordBotEdit(payload.channelId);
        const existingOverwrite = channel.permissionOverwrites.cache.get(guild.id);
        const merged = mergePermissionOverwrites(existingOverwrite, 
            payload.isLocked 
                ? { deny: { Connect: true } }
                : { neutral: ['Connect'] }
        );
        await channel.permissionOverwrites.set([
            ...channel.permissionOverwrites.cache
                .filter(o => o.id !== guild.id)
                .values(),
            {
                id: guild.id,
                type: OverwriteType.Role,
                allow: merged.allow,
                deny: merged.deny,
            },
        ]);
        stateStore.updateChannelState(payload.channelId, { isLocked: payload.isLocked });
        
        // Critical section: DB persistence after Discord + StateStore changes
        try {
            if (channelState.isTeamChannel) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { isLocked: payload.isLocked },
                });
            } else {
                await prisma.privateVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { isLocked: payload.isLocked },
                });
            }
        } catch (dbError: any) {
            // CRITICAL: Discord + StateStore updated but DB failed - inconsistent state
            console.error(`[Workers] CRITICAL: Lock toggle DB update failed after Discord/StateStore changes:`, {
                error: dbError.message,
                intentId: intent.id,
                channelId: payload.channelId,
                isLocked: payload.isLocked,
                channelType: channelState.isTeamChannel ? 'team' : 'private'
            });
            // TODO: Add to reconciliation queue when implemented
        }
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `lock:${payload.channelId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executeVCHideToggle(
    intent: Intent<{ channelId: string; isHidden: boolean }>,
): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    
    // CRITICAL: Emergency mode - limit hide operations during overload
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    
    if (isEmergencyMode && currentQueueSize > QUEUE_SIZE_LIMIT * 2) {
        return failure(intent, Date.now() - startTime, 'System severely overloaded - operation rejected', true);
    }
    
    try {
        const channelState = stateStore.getChannelState(payload.channelId);
        if (!channelState) {
            return failure(intent, Date.now() - startTime, 'Channel not in state');
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const channel = guild.channels.cache.get(payload.channelId) as VoiceChannel | undefined;
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return failure(intent, Date.now() - startTime, 'Channel not found');
        }
        recordBotEdit(payload.channelId);
        const existingOverwrite = channel.permissionOverwrites.cache.get(guild.id);
        const merged = mergePermissionOverwrites(existingOverwrite,
            payload.isHidden
                ? { deny: { ViewChannel: true } }
                : { neutral: ['ViewChannel'] }
        );
        await channel.permissionOverwrites.set([
            ...channel.permissionOverwrites.cache
                .filter(o => o.id !== guild.id)
                .values(),
            {
                id: guild.id,
                type: OverwriteType.Role,
                allow: merged.allow,
                deny: merged.deny,
            },
        ]);
        stateStore.updateChannelState(payload.channelId, { isHidden: payload.isHidden });
        
        // Critical section: DB persistence after Discord + StateStore changes  
        try {
            if (channelState.isTeamChannel) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { isHidden: payload.isHidden },
                });
            } else {
                await prisma.privateVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { isHidden: payload.isHidden },
                });
            }
        } catch (dbError: any) {
            // CRITICAL: Discord + StateStore updated but DB failed - inconsistent state
            console.error(`[Workers] CRITICAL: Hide toggle DB update failed after Discord/StateStore changes:`, {
                error: dbError.message,
                intentId: intent.id,
                channelId: payload.channelId,
                isHidden: payload.isHidden,
                channelType: channelState.isTeamChannel ? 'team' : 'private'
            });
            // TODO: Add to reconciliation queue when implemented
        }
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `hide:${payload.channelId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    }
}
async function executeOwnerTransfer(intent: Intent<OwnerTransferPayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    if (Date.now() > intent.expiresAt) {
        return failure(intent, Date.now() - startTime, 'Intent expired during execution', false);
    }
    const lockKey = ownerTransferLockKey(payload.channelId);
    const lockHolder = intent.id; 
    if (!lockManager.acquire(lockKey, lockHolder, VCNS_CONFIG.VC_CREATE_LOCK_DURATION_MS, 'Owner transfer')) {
        return failure(intent, Date.now() - startTime, 'Transfer lock failed - operation in progress', true);
    }
    try {
        const channelState = stateStore.getChannelState(payload.channelId);
        if (!channelState) {
            return failure(intent, Date.now() - startTime, 'Channel not found in state');
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            return failure(intent, Date.now() - startTime, 'Guild not found');
        }
        const channel = guild.channels.cache.get(payload.channelId) as VoiceChannel | undefined;
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return failure(intent, Date.now() - startTime, 'Channel not found');
        }
        const transferResult = stateStore.transferOwnership(payload.channelId, payload.newOwnerId);
        if (!transferResult.success) {
            return failure(intent, Date.now() - startTime, transferResult.error || 'Transfer failed');
        }
        const previousOwnerId = transferResult.previousOwnerId!;
        recordBotEdit(payload.channelId);
        const previousOwnerOverwrite = channel.permissionOverwrites.cache.get(previousOwnerId);
        const previousOwnerNonOwnerPerms = previousOwnerOverwrite ? {
            allow: previousOwnerOverwrite.allow.bitfield & ~(
                PermissionFlagsBits.Connect |
                PermissionFlagsBits.ViewChannel |
                PermissionFlagsBits.Speak |
                PermissionFlagsBits.Stream |
                PermissionFlagsBits.MoveMembers
            ),
            deny: previousOwnerOverwrite.deny.bitfield,
        } : null;
        const newOwnerExisting = channel.permissionOverwrites.cache.get(payload.newOwnerId);
        const newOwnerMerged = mergePermissionOverwrites(newOwnerExisting, {
            allow: {
                Connect: true,
                ViewChannel: true,
                Speak: true,
                Stream: true,
                MoveMembers: true,
            },
        });
        await channel.permissionOverwrites.set([
            ...channel.permissionOverwrites.cache
                .filter(o => o.id !== payload.newOwnerId && o.id !== previousOwnerId)
                .values(),
            {
                id: payload.newOwnerId,
                type: OverwriteType.Member,
                allow: newOwnerMerged.allow,
                deny: newOwnerMerged.deny,
            },
            ...(previousOwnerNonOwnerPerms && (previousOwnerNonOwnerPerms.allow !== BigInt(0) || previousOwnerNonOwnerPerms.deny !== BigInt(0))
                ? [{
                    id: previousOwnerId,
                    type: OverwriteType.Member as const,
                    allow: previousOwnerNonOwnerPerms.allow,
                    deny: previousOwnerNonOwnerPerms.deny,
                }]
                : []
            ),
        ]);
        if (channelState.isTeamChannel) {
            try {
                await prisma.teamVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { ownerId: payload.newOwnerId },
                });
            } catch (err: any) {
                // CRITICAL: Owner transfer succeeded in Discord/StateStore but failed in DB
                console.error(`[Workers] CRITICAL: Owner transfer DB update failed for team channel ${payload.channelId}:`, {
                    error: err.message,
                    intentId: intent.id,
                    channelId: payload.channelId,
                    newOwnerId: payload.newOwnerId,
                    previousOwnerId: previousOwnerId
                });
                // TODO: Implement rollback - Discord permissions need to be reverted
                // TODO: Add to reconciliation queue when implemented
            }
        } else {
            try {
                await prisma.privateVoiceChannel.update({
                    where: { channelId: payload.channelId },
                    data: { ownerId: payload.newOwnerId },
                });
            } catch (err: any) {
                // CRITICAL: Owner transfer succeeded in Discord/StateStore but failed in DB
                console.error(`[Workers] CRITICAL: Owner transfer DB update failed for private channel ${payload.channelId}:`, {
                    error: err.message,
                    intentId: intent.id,
                    channelId: payload.channelId,
                    newOwnerId: payload.newOwnerId,
                    previousOwnerId: previousOwnerId
                });
                // TODO: Implement rollback - Discord permissions need to be reverted
                // TODO: Add to reconciliation queue when implemented
            }
        }
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        // CRITICAL: If we reach here, Discord permissions were changed but something failed
        // This leaves the system in an inconsistent state requiring manual recovery
        console.error(`[Workers] CRITICAL: Owner transfer failed after Discord changes applied:`, {
            error: error.message,
            intentId: intent.id,
            channelId: payload.channelId,
            newOwnerId: payload.newOwnerId,
            phase: 'post-discord-permission-update'
        });
        // TODO: Implement compensation - revert Discord permissions to previous state
        
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(
                `transfer:${payload.channelId}`,
                rateLimit.retryAfter!,
                rateLimit.isGlobal!,
            );
            return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
        }
        return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
    } finally {
        lockManager.release(lockKey, lockHolder);
    }
}
export async function executeIntent(intent: Intent<unknown>): Promise<WorkerResult> {
    const startTime = Date.now();
    let result: WorkerResult;
    
    // CRITICAL FIX #1: Increment attempts when worker actually starts execution
    // This ensures crashes/errors during scheduling don't consume retries
    intent.attempts++;
    
    // TODO: Phase 1 - Persist attempt increment for crash safety
    // await persistIntentState(intent);
    
    console.info(`[Workers] Executing intent:`, {
        intentId: intent.id,
        action: intent.action,
        attempts: intent.attempts,
        maxAttempts: intent.maxAttempts,
        expiresAt: new Date(intent.expiresAt).toISOString()
    });
    
    try {
        switch (intent.action) {
            case IntentAction.VC_CREATE:
                result = await executeVCCreate(intent as Intent<VCCreatePayload>);
                break;
            case IntentAction.VC_DELETE:
                result = await executeVCDelete(intent as Intent<VCDeletePayload>);
                break;
            case IntentAction.VC_LOCK:
            case IntentAction.VC_UNLOCK:
                result = await executeVCLockToggle(
                    intent as Intent<{ channelId: string; isLocked: boolean }>,
                );
                break;
            case IntentAction.VC_HIDE:
            case IntentAction.VC_UNHIDE:
                result = await executeVCHideToggle(
                    intent as Intent<{ channelId: string; isHidden: boolean }>,
                );
                break;
            case IntentAction.PERM_GRANT:
            case IntentAction.PERM_REVOKE:
            case IntentAction.PERM_BAN:
            case IntentAction.PERM_UNBAN:
                result = await executePermission(intent as Intent<PermissionPayload>);
                break;
            case IntentAction.USER_KICK:
            case IntentAction.USER_DISCONNECT:
                result = await executeUserKick(intent as Intent<UserActionPayload>);
                break;
            case IntentAction.USER_MOVE:
                result = await executeUserMove(intent as Intent<UserActionPayload>);
                break;
            case IntentAction.OWNER_TRANSFER:
                result = await executeOwnerTransfer(intent as Intent<OwnerTransferPayload>);
                break;
            default:
                result = failure(
                    intent,
                    Date.now() - startTime,
                    `Unknown action: ${intent.action}`,
                );
        }
    } catch (error: any) {
        // CRITICAL: Unhandled worker error - should never reach here
        console.error(`[Workers] CRITICAL: Unhandled worker error:`, {
            intentId: intent.id,
            action: intent.action,
            error: error.message,
            stack: error.stack,
            attempts: intent.attempts
        });
        result = failure(intent, Date.now() - startTime, error.message || 'Worker error');
    }
    
    // Log execution result
    if (result.success) {
        console.info(`[Workers] Intent execution successful:`, {
            intentId: intent.id,
            action: intent.action,
            executionTimeMs: result.executionTimeMs
        });
    } else {
        console.error(`[Workers] Intent execution failed:`, {
            intentId: intent.id,
            action: intent.action,
            error: result.error,
            retryable: result.retryable,
            rateLimitHit: result.rateLimitHit,
            executionTimeMs: result.executionTimeMs
        });
    }
    
    intentQueue.complete(intent.id);
    return result;
}
export interface RetryInfo {
    willRetry: boolean;
    delayMs?: number;
    attempt?: number;
    rateLimitHit?: boolean;
    retryExhausted?: boolean;
}
export function handleWorkerFailure(intent: Intent<unknown>, result: WorkerResult): RetryInfo {
    // CRITICAL: Reduce retry attempts during emergency mode to prevent retry storms
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const maxAttemptsAdjusted = isEmergencyMode ? 
        Math.min(intent.maxAttempts, 2) : intent.maxAttempts;
    
    const isRetryEligible = result.retryable && intent.attempts < maxAttemptsAdjusted;
    
    // CRITICAL: Don't retry VC_CREATE operations during emergency mode
    if (isEmergencyMode && intent.action === IntentAction.VC_CREATE) {
        intent.status = IntentStatus.FAILED;
        intent.error = 'System overloaded - VC creation retry blocked';
        intentQueue.complete(intent.id);
        
        console.error(`[Workers] VC_CREATE retry blocked during emergency mode:`, {
            intentId: intent.id,
            attempts: intent.attempts,
            originalError: result.error
        });
        
        return { willRetry: false, retryExhausted: false };
    }
    
    if (isRetryEligible) {
        let delay: number;
        if (result.rateLimitHit && result.rateLimitRetryAfter) {
            delay = result.rateLimitRetryAfter;
            console.warn(`[Workers] Rate limit retry scheduled:`, {
                intentId: intent.id,
                action: intent.action,
                delayMs: delay,
                attempt: intent.attempts + 1,
                retryAfterMs: result.rateLimitRetryAfter
            });
        } else {
            delay = Math.min(
                VCNS_CONFIG.RETRY_BASE_DELAY_MS * Math.pow(2, intent.attempts),
                VCNS_CONFIG.RETRY_MAX_DELAY_MS,
            );
            console.warn(`[Workers] Exponential backoff retry scheduled:`, {
                intentId: intent.id,
                action: intent.action,
                delayMs: delay,
                attempt: intent.attempts + 1,
                baseDelayMs: VCNS_CONFIG.RETRY_BASE_DELAY_MS
            });
        }
        
        const now = Date.now();
        if (now + delay > intent.expiresAt) {
            intent.status = IntentStatus.FAILED;
            intent.error = result.error || 'Retry would exceed TTL';
            intentQueue.complete(intent.id);
            
            console.error(`[Workers] Intent retry cancelled - would exceed TTL:`, {
                intentId: intent.id,
                action: intent.action,
                expiresAt: new Date(intent.expiresAt).toISOString(),
                delayMs: delay,
                error: result.error
            });
            
            return { willRetry: false, retryExhausted: true };
        }
        
        // CRITICAL FIX #7: Record retry as pressure contributor
        rateGovernor.recordRetry(intent.action, intent.cost);
        
        // CRITICAL FIX #5: Persistent retry scheduling instead of volatile setTimeout
        intent.status = IntentStatus.RETRY_SCHEDULED;
        intent.nextRetryAt = now + delay;
        
        // TODO: Phase 1 - Persist retry schedule for crash safety
        // await persistIntentRetrySchedule(intent);
        
        // Immediately requeue with retry timestamp - scheduler will handle timing
        intentQueue.requeue(intent);
        
        console.info(`[Workers] Intent retry scheduled:`, {
            intentId: intent.id,
            action: intent.action,
            nextRetryAt: new Date(intent.nextRetryAt).toISOString(),
            attempt: intent.attempts + 1,
            maxAttempts: intent.maxAttempts
        });
        
        return {
            willRetry: true,
            delayMs: delay,
            attempt: intent.attempts + 1,
            rateLimitHit: result.rateLimitHit,
        };
    } else {
        intent.status = IntentStatus.FAILED;
        intent.error = result.error;
        intentQueue.complete(intent.id);
        const exhausted = result.retryable && intent.attempts >= intent.maxAttempts;
        
        console.error(`[Workers] Intent permanently failed:`, {
            intentId: intent.id,
            action: intent.action,
            attempts: intent.attempts,
            maxAttempts: intent.maxAttempts,
            retryable: result.retryable,
            retryExhausted: exhausted,
            finalError: result.error
        });
        
        return { willRetry: false, retryExhausted: exhausted };
    }
}

// CRITICAL: Export admission control for use in event handlers
export { shouldAdmitIntent, setUserCooldown, isUserOnCooldown };

// CRITICAL: Pre-queue admission control - call this BEFORE creating intents
export function checkAdmissionBeforeQueue(
    action: IntentAction,
    guildId: string,
    userId?: string
): { allow: boolean; reason?: string } {
    // Check overall system pressure
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    
    // Reject all VC_CREATE during emergency mode
    if (isEmergencyMode && action === IntentAction.VC_CREATE) {
        return { allow: false, reason: 'System overloaded - VC creation suspended' };
    }
    
    // Reject when queue is full
    if (currentQueueSize > QUEUE_SIZE_LIMIT) {
        return { allow: false, reason: 'System overloaded - please try again later' };
    }
    
    // User cooldown check for VC creation
    if (action === IntentAction.VC_CREATE && userId) {
        if (isUserOnCooldown(guildId, userId)) {
            return { allow: false, reason: 'Please wait before creating another VC' };
        }
        
        // Check if user already owns a VC (prevents duplicate scenarios)
        const existingChannelId = stateStore.getChannelByOwner(guildId, userId);
        if (existingChannelId) {
            return { allow: false, reason: 'User already owns a voice channel' };
        }
    }
    
    // Additional emergency protections
    if (isEmergencyMode) {
        // Allow critical operations but with stricter limits
        const criticalActions = [IntentAction.VC_DELETE, IntentAction.VC_UNLOCK];
        if (!criticalActions.includes(action) && currentQueueSize > QUEUE_SIZE_LIMIT / 2) {
            return { allow: false, reason: 'System overloaded - non-critical operations suspended' };
        }
    }
    
    return { allow: true };
}

// CRITICAL: Circuit breaker for system protection
export function isSystemOverloaded(): boolean {
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    const systemPressure = rateGovernor.getPressure?.() || 0;
    
    // System is overloaded if any condition is met
    return (
        isEmergencyMode ||
        currentQueueSize > QUEUE_SIZE_LIMIT ||
        systemPressure > 0.9  // 90% pressure threshold
    );
}

// CRITICAL: Emergency queue cleanup - call during severe overload
export function emergencyQueueCleanup(): { cleaned: number; preserved: number } {
    console.warn('[Workers] EMERGENCY: Performing queue cleanup due to severe overload');
    
    // This would need to be implemented in the intentQueue
    // For now, just return stats that would help with monitoring
    const currentSize = intentQueue.size?.() || 0;
    
    // Priority: Keep DELETE, UNLOCK, and high-priority operations
    // Drop: VC_CREATE, HIDE/SHOW, low-priority permissions
    
    return {
        cleaned: 0, // Would be implemented in intentQueue.emergencyCleanup()
        preserved: currentSize
    };
}

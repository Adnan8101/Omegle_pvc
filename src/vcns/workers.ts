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
const USER_COOLDOWNS = new Map<string, number>(); 
const USER_COOLDOWN_MS = 3000; 
const QUEUE_SIZE_LIMIT = 50; 
const GUILD_QUEUE_LIMIT = 10; 
function isUserOnCooldown(guildId: string, userId: string): boolean {
    const key = `${guildId}:${userId}`;
    const lastAction = USER_COOLDOWNS.get(key);
    if (!lastAction) return false;
    return Date.now() - lastAction < USER_COOLDOWN_MS;
}
function setUserCooldown(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    USER_COOLDOWNS.set(key, Date.now());
    if (USER_COOLDOWNS.size > 1000) {
        const cutoff = Date.now() - USER_COOLDOWN_MS * 2;
        for (const [k, time] of USER_COOLDOWNS) {
            if (time < cutoff) USER_COOLDOWNS.delete(k);
        }
    }
}
function shouldAdmitIntent(intent: Intent<unknown>): { admit: boolean; reason?: string } {
    const currentQueueSize = intentQueue.size?.() || 0;
    if (currentQueueSize > QUEUE_SIZE_LIMIT) {
        return { admit: false, reason: 'System overloaded - queue full' };
    }
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    if (isEmergencyMode && intent.action === IntentAction.VC_CREATE) {
        return { admit: false, reason: 'System overloaded - VC creation suspended' };
    }
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
function handleError(intent: Intent<unknown>, startTime: number, error: any, resourceKey: string): WorkerResult {
    const execTime = Date.now() - startTime;
    const rateLimit = isRateLimitError(error);
    if (rateLimit.isRateLimit) {
        rateGovernor.recordRateLimitHit(resourceKey, rateLimit.retryAfter!, rateLimit.isGlobal!);
        return failure(intent, execTime, 'Rate limited', true, true, rateLimit.retryAfter);
    }
    return failure(intent, execTime, error.message || 'Unknown error', isRetryableError(error));
}
async function deleteChannelFromDb(channelId: string): Promise<void> {
    await prisma.privateVoiceChannel.deleteMany({
        where: { channelId },
    });
    await prisma.teamVoiceChannel.deleteMany({
        where: { channelId },
    });
    await prisma.voicePermission.deleteMany({
        where: { channelId },
    });
    await prisma.teamVoicePermission.deleteMany({
        where: { channelId },
    });
}
async function updateChannelDbField(channelId: string, isTeamChannel: boolean, data: any): Promise<void> {
    try {
        if (isTeamChannel) {
            await prisma.teamVoiceChannel.update({
                where: { channelId },
                data,
            });
        } else {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data,
            });
        }
    } catch (dbError: any) {
        console.error(`[Workers] CRITICAL: DB update failed after Discord/StateStore changes:`, {
            error: dbError.message,
            channelId,
            data,
            channelType: isTeamChannel ? 'team' : 'private'
        });
    }
}
async function executeVCCreate(intent: Intent<VCCreatePayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
    if (Date.now() > intent.expiresAt) {
        return failure(intent, Date.now() - startTime, 'Intent expired during execution', false);
    }
    if (!payload.guildId || !payload.categoryId || !payload.ownerId) {
        return failure(intent, Date.now() - startTime, 'Invalid VC creation payload - missing required fields', false);
    }
    const admission = shouldAdmitIntent(intent);
    if (!admission.admit) {
        return failure(intent, Date.now() - startTime, admission.reason || 'Request rejected', false);
    }
    const existingChannelId = stateStore.getChannelByOwner(payload.guildId, payload.ownerId);
    if (existingChannelId) {
        console.warn(`[Workers] VC creation blocked - user already owns VC:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            existingChannelId: existingChannelId
        });
        return failure(intent, Date.now() - startTime, 'User already owns a voice channel', false);
    }
    if (isUserOnCooldown(payload.guildId, payload.ownerId)) {
        return failure(intent, Date.now() - startTime, 'Please wait before creating another VC', false);
    }
    if (rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode()) {
        console.warn(`[Workers] VC creation rejected - emergency mode active:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            guildId: payload.guildId
        });
        return failure(intent, Date.now() - startTime, 'System overloaded - please try again later', false);
    }
    if (intent.attempts > 2) {
        console.warn(`[Workers] VC creation rejected - too many attempts:`, {
            intentId: intent.id,
            ownerId: payload.ownerId,
            attempts: intent.attempts
        });
        return failure(intent, Date.now() - startTime, 'VC creation failed after multiple attempts', false);
    }
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
        skipLock: true, 
        lockHolder: intent.id, 
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
            stateStore.unregisterChannel(payload.channelId);
            await deleteChannelFromDb(payload.channelId);
            return success(intent, Date.now() - startTime);
        }
        const guild = client.guilds.cache.get(channelState.guildId);
        if (!guild) {
            stateStore.unregisterChannel(payload.channelId);
            await deleteChannelFromDb(payload.channelId);
            return success(intent, Date.now() - startTime);
        }
        const channel = guild.channels.cache.get(payload.channelId);
        if (!channel) {
            stateStore.unregisterChannel(payload.channelId);
            await deleteChannelFromDb(payload.channelId);
            return success(intent, Date.now() - startTime);
        }
        recordBotEdit(payload.channelId);
        await channel.delete(payload.reason || 'PVC cleanup');
        stateStore.unregisterChannel(payload.channelId);
        await deleteChannelFromDb(payload.channelId);
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        return handleError(intent, startTime, error, `channel:${intent.guildId}`);
    }
}
async function executePermission(intent: Intent<PermissionPayload>): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
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
        return handleError(intent, startTime, error, `perms:${payload.channelId}`);
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
        return handleError(intent, startTime, error, `kick:${intent.guildId}`);
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
        return handleError(intent, startTime, error, `move:${intent.guildId}`);
    }
}
async function executeVCLockToggle(
    intent: Intent<{ channelId: string; isLocked: boolean }>,
): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
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
        await updateChannelDbField(payload.channelId, channelState.isTeamChannel, { isLocked: payload.isLocked });
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        return handleError(intent, startTime, error, `lock:${payload.channelId}`);
    }
}
async function executeVCHideToggle(
    intent: Intent<{ channelId: string; isHidden: boolean }>,
): Promise<WorkerResult> {
    const startTime = Date.now();
    const payload = intent.payload;
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
        await updateChannelDbField(payload.channelId, channelState.isTeamChannel, { isHidden: payload.isHidden });
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        return handleError(intent, startTime, error, `hide:${payload.channelId}`);
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
        await updateChannelDbField(payload.channelId, channelState.isTeamChannel, { ownerId: payload.newOwnerId });
        rateGovernor.recordAction(intent.action, intent.cost);
        return success(intent, Date.now() - startTime);
    } catch (error: any) {
        console.error(`[Workers] CRITICAL: Owner transfer failed after Discord changes applied:`, {
            error: error.message,
            intentId: intent.id,
            channelId: payload.channelId,
            newOwnerId: payload.newOwnerId,
            phase: 'post-discord-permission-update'
        });
        const execTime = Date.now() - startTime;
        const rateLimit = isRateLimitError(error);
        if (rateLimit.isRateLimit) {
            rateGovernor.recordRateLimitHit(`transfer:${payload.channelId}`, rateLimit.retryAfter!, rateLimit.isGlobal!);
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
    intent.attempts++;
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
        console.error(`[Workers] CRITICAL: Unhandled worker error:`, {
            intentId: intent.id,
            action: intent.action,
            error: error.message,
            stack: error.stack,
            attempts: intent.attempts
        });
        result = failure(intent, Date.now() - startTime, error.message || 'Worker error');
    }
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
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const maxAttemptsAdjusted = isEmergencyMode ? 
        Math.min(intent.maxAttempts, 2) : intent.maxAttempts;
    const isRetryEligible = result.retryable && intent.attempts < maxAttemptsAdjusted;
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
        rateGovernor.recordRetry(intent.action, intent.cost);
        intent.status = IntentStatus.RETRY_SCHEDULED;
        intent.nextRetryAt = now + delay;
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
export { shouldAdmitIntent, setUserCooldown, isUserOnCooldown };
export function checkAdmissionBeforeQueue(
    action: IntentAction,
    guildId: string,
    userId?: string
): { allow: boolean; reason?: string } {
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    if (isEmergencyMode && action === IntentAction.VC_CREATE) {
        return { allow: false, reason: 'System overloaded - VC creation suspended' };
    }
    if (currentQueueSize > QUEUE_SIZE_LIMIT) {
        return { allow: false, reason: 'System overloaded - please try again later' };
    }
    if (action === IntentAction.VC_CREATE && userId) {
        if (isUserOnCooldown(guildId, userId)) {
            return { allow: false, reason: 'Please wait before creating another VC' };
        }
        const existingChannelId = stateStore.getChannelByOwner(guildId, userId);
        if (existingChannelId) {
            return { allow: false, reason: 'User already owns a voice channel' };
        }
    }
    if (isEmergencyMode) {
        const criticalActions = [IntentAction.VC_DELETE, IntentAction.VC_UNLOCK];
        if (!criticalActions.includes(action) && currentQueueSize > QUEUE_SIZE_LIMIT / 2) {
            return { allow: false, reason: 'System overloaded - non-critical operations suspended' };
        }
    }
    return { allow: true };
}
export function isSystemOverloaded(): boolean {
    const isEmergencyMode = rateGovernor.isInEmergencyMode && rateGovernor.isInEmergencyMode();
    const currentQueueSize = intentQueue.size?.() || 0;
    const systemPressure = rateGovernor.getPressure?.() || 0;
    return (
        isEmergencyMode ||
        currentQueueSize > QUEUE_SIZE_LIMIT ||
        systemPressure > 0.9  
    );
}
export function emergencyQueueCleanup(): { cleaned: number; preserved: number } {
    console.warn('[Workers] EMERGENCY: Performing queue cleanup due to severe overload');
    const currentSize = intentQueue.size?.() || 0;
    return {
        cleaned: 0, 
        preserved: currentSize
    };
}

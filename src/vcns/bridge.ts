import {
    ChannelType,
    type VoiceChannel,
    type Guild,
    type GuildMember,
    PermissionFlagsBits,
} from 'discord.js';
import { vcns, IntentFactory, stateStore, rateGovernor, waitForIntent, type VCNSStats } from './index';
import {
    Intent,
    IntentPriority,
    IntentStatus,
    IntentAction,
    VCCreatePayload,
} from './types';
import { buildVC } from './vcBuilder';
const guildKickTracking = new Map<string, { count: number, resetTime: number }>();
const MASS_KICK_THRESHOLD = 10; 
const TRACKING_WINDOW = 5000; 
function shouldForceQueue(guildId: string): boolean {
    const now = Date.now();
    const tracking = guildKickTracking.get(guildId) || { count: 0, resetTime: now + TRACKING_WINDOW };
    if (now > tracking.resetTime) {
        tracking.count = 0;
        tracking.resetTime = now + TRACKING_WINDOW;
    }
    tracking.count++;
    guildKickTracking.set(guildId, tracking);
    return tracking.count > MASS_KICK_THRESHOLD;
}
interface BridgeResult<T = void> {
    success: boolean;
    queued: boolean;
    intentId?: string;
    eta?: string;
    error?: string;
    data?: T;
    channelId?: string;  
}
export function mapPriority(oldPriority: number): IntentPriority {
    switch (oldPriority) {
        case -1: return IntentPriority.IMMEDIATE;
        case 0: return IntentPriority.CRITICAL;
        case 1: return IntentPriority.HIGH;
        case 2: return IntentPriority.NORMAL;
        case 3: return IntentPriority.LOW;
        default: return IntentPriority.NORMAL;
    }
}
export class VCNSBridge {
    public async createVC(
        guildOrOptions: Guild | {
            guild: Guild;
            ownerId: string;
            channelName: string;
            parentId?: string;
            permissionOverwrites?: any[];
            isTeam?: boolean;
            teamType?: 'duo' | 'trio' | 'squad';
            userLimit?: number;
            bitrate?: number;
        },
        categoryId?: string,
        ownerId?: string,
        name?: string,
        options: {
            isTeamChannel?: boolean;
            teamType?: 'duo' | 'trio' | 'squad';
            userLimit?: number;
            bitrate?: number;
        } = {},
    ): Promise<BridgeResult<string>> {
        if (!vcns.isActive()) {
            return {
                success: false,
                queued: false,
                error: 'VCNS not active',
            };
        }
        let guild: Guild;
        let targetOwnerId: string;
        let targetCategoryId: string;
        let channelName: string;
        let isTeam = false;
        let userLimit: number | undefined;
        let bitrate: number | undefined;
        let teamType: 'duo' | 'trio' | 'squad' | undefined;
        if (typeof guildOrOptions === 'object' && 'ownerId' in guildOrOptions && 'channelName' in guildOrOptions) {
            guild = guildOrOptions.guild;
            targetOwnerId = guildOrOptions.ownerId;
            targetCategoryId = guildOrOptions.parentId || '';
            channelName = guildOrOptions.channelName;
            isTeam = guildOrOptions.isTeam ?? false;
            userLimit = guildOrOptions.userLimit;
            bitrate = guildOrOptions.bitrate;
            teamType = guildOrOptions.teamType;
        } else {
            guild = guildOrOptions as Guild;
            targetOwnerId = ownerId!;
            targetCategoryId = categoryId!;
            channelName = name!;
            isTeam = options.isTeamChannel ?? false;
            userLimit = options.userLimit;
            bitrate = options.bitrate;
            teamType = options.teamType;
        }
        if (vcns.userOwnsChannel(guild.id, targetOwnerId)) {
            // Memory thinks user owns a channel, verify in database
            const existingChannelId = vcns.getChannelByOwner(guild.id, targetOwnerId);
            console.log(`[Bridge] ⚠️ Memory says user ${targetOwnerId} owns channel ${existingChannelId}, verifying in DB...`);
            
            // Import prisma to check database
            const { default: prisma } = await import('../utils/database');
            const dbChannel = await prisma.privateVoiceChannel.findUnique({
                where: { channelId: existingChannelId || undefined },
            }).catch(() => null);
            
            if (!dbChannel && existingChannelId) {
                // Channel exists in memory but not in DB - clean it up
                console.log(`[Bridge] 🧹 Channel ${existingChannelId} not in DB, cleaning up memory...`);
                const { unregisterChannel } = await import('../utils/voiceManager');
                unregisterChannel(existingChannelId);
                console.log(`[Bridge] ✅ Memory cleaned up, allowing new channel creation`);
                // Continue with creation
            } else if (dbChannel) {
                // Channel exists in both memory and DB - reject
                console.log(`[Bridge] ❌ User truly owns a channel - rejecting creation`);
                return {
                    success: false,
                    queued: false,
                    error: 'User already owns a channel',
                };
            }
        }
        const payload: VCCreatePayload = {
            guildId: guild.id,
            categoryId: targetCategoryId,
            ownerId: targetOwnerId,
            name: channelName,
            isTeamChannel: isTeam,
            teamType: teamType ? teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD' : undefined,
            userLimit,
            bitrate,
        };
        console.log(`[Bridge] 📤 Submitting VC create intent for user ${targetOwnerId}`);
        const result = vcns.requestVCCreate(payload, targetOwnerId);
        console.log(`[Bridge] 📥 Intent submitted - queued: ${result.queued}, intentId: ${result.intentId}`);
        if (!result.queued) {
            console.log(`[Bridge] ❌ Intent was NOT queued - returning failure`);
            return {
                success: false,
                queued: false,
                intentId: result.intentId,
                error: 'Failed to queue creation',
            };
        }
        console.log(`[Bridge] ⏳ Waiting for intent ${result.intentId} to complete (30s timeout)...`);
        try {
            const workerResult = await waitForIntent(result.intentId, 30000);
            console.log(`[Bridge] ✅ Intent completed - success: ${workerResult.success}, channelId: ${workerResult.data?.channelId}`);
            if (workerResult.success && workerResult.data?.channelId) {
                return {
                    success: true,
                    queued: true,
                    intentId: result.intentId,
                    channelId: workerResult.data.channelId as string,
                };
            } else {
                return {
                    success: false,
                    queued: true,
                    intentId: result.intentId,
                    error: workerResult.error || 'VC creation failed',
                };
            }
        } catch (err: any) {
            return {
                success: false,
                queued: true,
                intentId: result.intentId,
                error: err.message || 'Intent timeout',
            };
        }
    }
    public async createVCImmediate(
        guild: Guild,
        categoryId: string,
        ownerId: string,
        name: string,
        options: {
            isTeamChannel?: boolean;
            teamType?: 'DUO' | 'TRIO' | 'SQUAD';
            userLimit?: number;
            bitrate?: number;
        } = {},
    ): Promise<BridgeResult<string>> {
        const systemState = stateStore.getSystemState();
        if (!systemState.circuitBreakerOpen && vcns.isActive()) {
            return {
                success: false,
                queued: false,
                error: 'Immediate path not allowed while system is healthy - use createVC()',
            };
        }
        const result = await buildVC({
            guildId: guild.id,
            categoryId,
            ownerId,
            name,
            isTeamChannel: options.isTeamChannel ?? false,
            teamType: options.teamType,
            userLimit: options.userLimit,
            bitrate: options.bitrate,
            skipDbWrite: false,
        });
        return {
            success: result.success,
            queued: false,
            channelId: result.channelId,
            error: result.error,
        };
    }
    public async deleteVC(
        guildIdOrOptions: string | {
            guild: Guild;
            channelId: string;
            isTeam?: boolean;
        },
        channelId?: string,
        reason?: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        let guild: Guild | undefined;
        let guildId: string;
        let targetChannelId: string;
        if (typeof guildIdOrOptions === 'object') {
            guild = guildIdOrOptions.guild;
            guildId = guild.id;
            targetChannelId = guildIdOrOptions.channelId;
        } else {
            guildId = guildIdOrOptions;
            targetChannelId = channelId!;
        }
        const systemState = stateStore.getSystemState();
        const isHealthy = !systemState.circuitBreakerOpen && vcns.isActive();
        if (isHealthy) {
            console.log(`[Bridge] 📤 Submitting VC delete intent for channel ${targetChannelId}`);
            const result = vcns.requestVCDelete(guildId, targetChannelId, reason);
            if (result.queued && result.intentId) {
                try {
                    const outcome = await waitForIntent(result.intentId, 30000);
                    stateStore.unregisterChannel(targetChannelId);
                    return {
                        success: outcome.success,
                        queued: true,
                        intentId: result.intentId,
                        error: outcome.error,
                    };
                } catch (error: any) {
                    console.error(`[Bridge] Delete intent timeout for ${targetChannelId}:`, error.message);
                    return { success: false, queued: true, intentId: result.intentId, error: error.message };
                }
            }
            return { success: false, queued: false, error: 'Failed to queue delete intent' };
        }
        console.warn(`[Bridge] ⚠️ System degraded - using fallback delete for ${targetChannelId}`);
        try {
            if (guild) {
                let channel = guild.channels.cache.get(targetChannelId);
                if (!channel) {
                    try {
                        channel = await guild.channels.fetch(targetChannelId) as any;
                    } catch {
                        console.log(`[Bridge] Channel ${targetChannelId} not found in Discord (already deleted)`);
                    }
                }
                if (channel) {
                    await this.executeFallback(
                        `vc:delete:${guildId}`,
                        async () => channel!.delete(reason),
                        IntentPriority.HIGH,
                        false, 
                    );
                    rateGovernor.recordAction(IntentAction.VC_DELETE, 25);
                }
            }
            stateStore.unregisterChannel(targetChannelId);
            return { success: true, queued: false };
        } catch (error: any) {
            console.error(`[Bridge] Failed to delete VC ${targetChannelId}:`, error.message);
            return { success: false, queued: false, error: error.message };
        }
    }
    public async setVCLock(
        guildId: string,
        channelId: string,
        locked: boolean,
        userId: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        const result = vcns.requestVCLock(guildId, channelId, locked, userId);
        return {
            success: result.queued,
            queued: result.queued,
            intentId: result.intentId,
            eta: result.eta,
        };
    }
    public async setVCHidden(
        guildId: string,
        channelId: string,
        hidden: boolean,
        userId: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        const result = vcns.requestVCHide(guildId, channelId, hidden, userId);
        return {
            success: result.queued,
            queued: result.queued,
            intentId: result.intentId,
            eta: result.eta,
        };
    }
    public async kickUser(
        guildIdOrOptions: string | {
            guild: Guild;
            channelId: string;
            userId: string;
            reason?: string;
            isImmediate?: boolean;
        },
        userId?: string,
        channelId?: string,
        reason?: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        let guildId: string;
        let targetUserId: string;
        let targetChannelId: string;
        let kickReason: string | undefined;
        let isImmediate = false;
        if (typeof guildIdOrOptions === 'object') {
            guildId = guildIdOrOptions.guild.id;
            targetUserId = guildIdOrOptions.userId;
            targetChannelId = guildIdOrOptions.channelId;
            kickReason = guildIdOrOptions.reason;
            isImmediate = guildIdOrOptions.isImmediate ?? false;
            if (isImmediate && shouldForceQueue(guildId)) {
                console.warn(
                    `[VCNS Bridge] 🚨 Mass kick detected (>${MASS_KICK_THRESHOLD}/5s) in guild ${guildId}. ` +
                    `Forcing queue routing for user ${targetUserId} to prevent API rate limits.`
                );
                isImmediate = false; 
            }
            if (isImmediate) {
                console.log(`[VCNS Bridge] ⚡ IMMEDIATE kick for user ${targetUserId} in guild ${guildId} (reason: ${kickReason})`);
                try {
                    const member = await guildIdOrOptions.guild.members.fetch(targetUserId);
                    if (member.voice.channelId) {
                        await member.voice.disconnect(kickReason);
                        rateGovernor.recordAction(IntentAction.USER_KICK, 20);
                        console.log(`[VCNS Bridge] ✅ IMMEDIATE kick successful for ${member.user.tag} (${targetUserId})`);
                    }
                    return { success: true, queued: false };
                } catch (error: any) {
                    return { success: false, queued: false, error: error.message };
                }
            }
        } else {
            guildId = guildIdOrOptions;
            targetUserId = userId!;
            targetChannelId = channelId!;
            kickReason = reason;
        }
        console.log(`[VCNS Bridge] 🔄 Queueing kick intent for user ${targetUserId} in guild ${guildId} (reason: ${kickReason})`);
        const result = vcns.requestUserKick(guildId, targetUserId, targetChannelId, kickReason);
        console.log(`[VCNS Bridge] ${result.queued ? '✅' : '❌'} Kick intent ${result.queued ? 'queued successfully' : 'failed to queue'} - ID: ${result.intentId}, ETA: ${result.eta}`);
        return {
            success: result.queued,
            queued: result.queued,
            intentId: result.intentId,
            eta: result.eta,
        };
    }
    public async kickUserImmediate(
        member: GuildMember,
        reason: string,
    ): Promise<boolean> {
        const systemState = stateStore.getSystemState();
        const isHealthy = !systemState.circuitBreakerOpen && vcns.isActive();
        if (isHealthy) {
            throw new Error(
                `[VCNS Bridge] kickUserImmediate forbidden while system healthy. ` +
                `Use kickUser() intent system. User: ${member.id}, Reason: ${reason}`
            );
        }
        try {
            await member.voice.disconnect(reason);
            rateGovernor.recordAction(IntentAction.USER_KICK, 20);
            return true;
        } catch {
            return false;
        }
    }
    public async grantPermission(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        userId: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        const result = vcns.requestPermissionGrant(
            guildId,
            channelId,
            targetId,
            targetType,
            userId,
        );
        return {
            success: result.queued,
            queued: result.queued,
            intentId: result.intentId,
            eta: result.eta,
        };
    }
    public async banPermission(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        userId: string,
    ): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        const result = vcns.requestPermissionBan(
            guildId,
            channelId,
            targetId,
            targetType,
            userId,
        );
        return {
            success: result.queued,
            queued: result.queued,
            intentId: result.intentId,
            eta: result.eta,
        };
    }
    public async editPermission(options: {
        guild: Guild;
        channelId: string;
        targetId: string;
        permissions: Record<string, boolean | null>;
        allowWhenHealthy?: boolean; 
    }): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        try {
            const channel = options.guild.channels.cache.get(options.channelId);
            if (!channel || !channel.isVoiceBased()) {
                return { success: false, queued: false, error: 'Channel not found' };
            }
            await this.executeFallback(
                `permission:${options.channelId}`,
                async () => {
                    await channel.permissionOverwrites.edit(options.targetId, options.permissions);
                },
                IntentPriority.NORMAL,
                options.allowWhenHealthy || false, 
            );
            return { success: true, queued: false };
        } catch (error: any) {
            return { success: false, queued: false, error: error.message };
        }
    }
    public async removePermission(options: {
        guild: Guild;
        channelId: string;
        targetId: string;
        allowWhenHealthy?: boolean; 
    }): Promise<BridgeResult> {
        if (!vcns.isActive()) {
            return { success: false, queued: false, error: 'VCNS not active' };
        }
        try {
            const channel = options.guild.channels.cache.get(options.channelId);
            if (!channel || !channel.isVoiceBased()) {
                return { success: false, queued: false, error: 'Channel not found' };
            }
            await this.executeFallback(
                `permission:${options.channelId}`,
                async () => {
                    await channel.permissionOverwrites.delete(options.targetId);
                },
                IntentPriority.NORMAL,
                options.allowWhenHealthy || false, 
            );
            return { success: true, queued: false };
        } catch (error: any) {
            return { success: false, queued: false, error: error.message };
        }
    }
    public isManaged(channelId: string): boolean {
        return vcns.isChannelManaged(channelId);
    }
    public getChannelState(channelId: string) {
        return vcns.getChannelState(channelId);
    }
    public getChannelByOwner(guildId: string, ownerId: string): string | null {
        return vcns.getChannelByOwner(guildId, ownerId);
    }
    public isGuildPaused(guildId: string): boolean {
        return vcns.isGuildPaused(guildId);
    }
    public getStats(): VCNSStats {
        return vcns.getStats();
    }
    public async executeFallback<T>(
        route: string,
        action: () => Promise<T>,
        priority: IntentPriority = IntentPriority.NORMAL,
        allowWhenHealthy: boolean = false, 
    ): Promise<T> {
        const systemState = stateStore.getSystemState();
        const isHealthy = !systemState.circuitBreakerOpen && vcns.isActive();
        if (isHealthy && !allowWhenHealthy) {
            throw new Error(
                `[VCNS Bridge] executeFallback(${route}) forbidden while system healthy. ` +
                `Use intent system or set allowWhenHealthy=true for enforcement paths.`
            );
        }
        if (isHealthy && allowWhenHealthy) {
            console.warn(`[VCNS Bridge] executeFallback(${route}) bypass - allowed for enforcement`);
        }
        const check = rateGovernor.canProceed(IntentAction.ENFORCE_STATE, priority);
        if (!check.allowed && priority > IntentPriority.IMMEDIATE) {
            await this.sleep(check.delayMs);
        } else if (check.delayMs > 0) {
            await this.sleep(check.delayMs);
        }
        try {
            const result = await action();
            rateGovernor.recordAction(IntentAction.ENFORCE_STATE, 10);
            return result;
        } catch (error: any) {
            if (error?.status === 429 || error?.code === 429) {
                const retryAfter = (error.retry_after || 1) * 1000;
                rateGovernor.recordRateLimitHit(route, retryAfter, false);
            }
            throw error;
        }
    }
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
export const vcnsBridge = new VCNSBridge();
export async function executeWithVCNS<T>(
    route: string,
    task: () => Promise<T>,
    priority: IntentPriority = IntentPriority.NORMAL,
): Promise<T> {
    return vcnsBridge.executeFallback(route, task, priority);
}

import { EventEmitter } from 'events';
import {
    Intent,
    IntentStatus,
    IntentPriority,
    WorkerResult,
    VCCreatePayload,
    VCNS_CONFIG,
} from './types';
import { stateStore } from './stateStore';
import { intentQueue } from './intentQueue';
import { rateGovernor } from './rateGovernor';
import { decisionEngine } from './decisionEngine';
import { scheduler } from './scheduler';
import { IntentFactory } from './intentFactory';
import { registerChannel, registerTeamChannel } from '../utils/voiceManager';
import { executeIntent, handleWorkerFailure } from './workers';
import prisma from '../utils/database';
export interface VCNSStats {
    uptime: number;
    intentsProcessed: number;
    intentsFailed: number;
    intentsDropped: number;
    currentQueueSize: number;
    currentPressure: number;
    isDefenseMode: boolean;
    isEmergencyMode: boolean;
}
interface VCNSEvents {
    started: () => void;
    stopped: () => void;
    intentQueued: (intent: Intent<unknown>) => void;
    intentCompleted: (intent: Intent<unknown>, result: WorkerResult) => void;
    intentFailed: (intent: Intent<unknown>, error: string) => void;
    intentRetryScheduled: (intent: Intent<unknown>, delayMs: number, attempt: number) => void;
    intentRetryExhausted: (intent: Intent<unknown>) => void;
    intentRateLimited: (intent: Intent<unknown>, retryAfterMs: number) => void;
    stateLoaded: (channelCount: number) => void;
}
type IntentCallback = (result: WorkerResult) => void;
const pendingCallbacks = new Map<string, IntentCallback>();
export function waitForIntent(intentId: string, timeoutMs: number = 30000): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingCallbacks.delete(intentId);
            reject(new Error('Intent timeout'));
        }, timeoutMs);
        pendingCallbacks.set(intentId, (result) => {
            clearTimeout(timeout);
            pendingCallbacks.delete(intentId);
            resolve(result);
        });
    });
}
class VCNSController extends EventEmitter {
    private startedAt: number = 0;
    private isRunning: boolean = false;
    private intentsProcessed: number = 0;
    private intentsFailed: number = 0;
    private intentsDropped: number = 0;
    constructor() {
        super();
        this.setupEventListeners();
    }
    public async start(): Promise<void> {
        if (this.isRunning) {
            console.log('[VCNS] Already running');
            return;
        }
        console.log('[VCNS] Starting...');
        this.startedAt = Date.now();
        try {
            await this.loadStateFromDatabase();
            scheduler.start(this.handleIntentExecution.bind(this));
            this.isRunning = true;
            console.log('[VCNS] Started successfully');
            this.emit('started');
        } catch (error) {
            console.error('[VCNS] Failed to start:', error);
            throw error;
        }
    }
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }
        console.log('[VCNS] Stopping...');
        scheduler.stop();
        const timeout = 10000; 
        const checkInterval = 100;
        let waited = 0;
        while (stateStore.getSystemState().activeWorkers > 0 && waited < timeout) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            waited += checkInterval;
        }
        intentQueue.stop();
        rateGovernor.stop();
        stateStore.stop();
        this.isRunning = false;
        console.log('[VCNS] Stopped');
        this.emit('stopped');
    }
    public isActive(): boolean {
        return this.isRunning;
    }
    private async loadStateFromDatabase(): Promise<void> {
        console.log('[VCNS] Loading state from database...');
        let channelCount = 0;
        try {
            const pvcs = await prisma.privateVoiceChannel.findMany({
                select: {
                    channelId: true,
                    guildId: true,
                    ownerId: true,
                    isLocked: true,
                    isHidden: true,
                },
            });
            for (const pvc of pvcs) {
                stateStore.loadChannelFromDB(
                    pvc.channelId,
                    pvc.guildId,
                    pvc.ownerId,
                    pvc.isLocked,
                    pvc.isHidden,
                    false, 
                );
                registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                channelCount++;
            }
            const teamChannels = await prisma.teamVoiceChannel.findMany({
                select: {
                    channelId: true,
                    guildId: true,
                    ownerId: true,
                    isLocked: true,
                    isHidden: true,
                    teamType: true,
                },
            });
            for (const team of teamChannels) {
                stateStore.loadChannelFromDB(
                    team.channelId,
                    team.guildId,
                    team.ownerId,
                    team.isLocked,
                    team.isHidden,
                    true, 
                    team.teamType as 'DUO' | 'TRIO' | 'SQUAD',
                );
                registerTeamChannel(team.channelId, team.guildId, team.ownerId, team.teamType.toLowerCase() as 'duo' | 'trio' | 'squad');
                channelCount++;
            }
            const globalBlocks = await prisma.globalVCBlock.findMany({
                select: {
                    guildId: true,
                    userId: true,
                    reason: true,
                },
            });
            stateStore.loadGlobalBlocks(globalBlocks);
            console.log(`[VCNS] Loaded ${globalBlocks.length} global blocks into cache`);
            const permanentAccess = await prisma.ownerPermission.findMany({
                select: {
                    guildId: true,
                    ownerId: true,
                    targetId: true,
                },
            });
            stateStore.loadPermanentAccess(permanentAccess);
            console.log(`[VCNS] Loaded ${permanentAccess.length} permanent access grants into cache`);
            const pausedGuilds = await prisma.guildSettings.findMany({
                where: {  },
                select: { guildId: true },
            });
            console.log(`[VCNS] Loaded ${channelCount} channels from database`);
            this.emit('stateLoaded', channelCount);
        } catch (error) {
            console.error('[VCNS] Error loading state from database:', error);
        }
    }
    private async handleIntentExecution(intent: Intent<unknown>): Promise<void> {
        const result = await executeIntent(intent);
        if (result.success) {
            intent.status = IntentStatus.COMPLETED;
            this.intentsProcessed++;
            this.emit('intentCompleted', intent, result);
            const callback = pendingCallbacks.get(intent.id);
            if (callback) {
                callback(result);
            }
        } else {
            const retryInfo = handleWorkerFailure(intent, result);
            if (retryInfo.willRetry) {
                if (retryInfo.rateLimitHit) {
                    this.emit('intentRateLimited', intent, retryInfo.delayMs!);
                }
                this.emit('intentRetryScheduled', intent, retryInfo.delayMs!, retryInfo.attempt!);
            } else if (retryInfo.retryExhausted) {
                this.emit('intentRetryExhausted', intent);
                const callback = pendingCallbacks.get(intent.id);
                if (callback) {
                    callback(result);
                }
            }
            if (intent.status === IntentStatus.FAILED) {
                this.intentsFailed++;
                this.emit('intentFailed', intent, result.error || 'Unknown error');
                const callback = pendingCallbacks.get(intent.id);
                if (callback) {
                    callback(result);
                }
            }
        }
    }
    public submit(intent: Intent<unknown>): { 
        intentId: string; 
        queued: boolean; 
        estimatedWaitMs: number;
        eta: string;
    } {
        if (!this.isRunning) {
            return {
                intentId: intent.id,
                queued: false,
                estimatedWaitMs: 0,
                eta: 'System not ready',
            };
        }
        if (rateGovernor.isInEmergencyMode() && intent.priority > IntentPriority.CRITICAL) {
            return {
                intentId: intent.id,
                queued: false,
                estimatedWaitMs: 0,
                eta: 'System under load - try again shortly',
            };
        }
        const queued = intentQueue.enqueue(intent);
        if (queued) {
            const estimatedWait = decisionEngine.calculateETA(intent);
            const eta = decisionEngine.formatETA(estimatedWait);
            intent.meta.estimatedWait = estimatedWait;
            this.emit('intentQueued', intent);
            return {
                intentId: intent.id,
                queued: true,
                estimatedWaitMs: estimatedWait,
                eta,
            };
        } else {
            this.intentsDropped++;
            return {
                intentId: intent.id,
                queued: false,
                estimatedWaitMs: 0,
                eta: 'Unable to queue',
            };
        }
    }
    public requestVCCreate(
        payload: VCCreatePayload,
        userId: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createVCCreate(
            payload,
            IntentFactory.userSource(userId, 'VC creation request'),
        );
        return this.submit(intent);
    }
    public requestVCDelete(
        guildId: string,
        channelId: string,
        reason?: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createVCDelete(
            guildId,
            channelId,
            reason,
            IntentFactory.systemSource('Channel cleanup'),
        );
        return this.submit(intent);
    }
    public requestVCLock(
        guildId: string,
        channelId: string,
        lock: boolean,
        userId: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createVCLock(
            guildId,
            channelId,
            lock,
            IntentFactory.userSource(userId, 'Button interaction'),
        );
        return this.submit(intent);
    }
    public requestVCHide(
        guildId: string,
        channelId: string,
        hide: boolean,
        userId: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createVCHide(
            guildId,
            channelId,
            hide,
            IntentFactory.userSource(userId, 'Button interaction'),
        );
        return this.submit(intent);
    }
    public requestPermissionGrant(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        userId: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createPermissionGrant(
            guildId,
            channelId,
            targetId,
            targetType,
            IntentFactory.userSource(userId, 'Permission change'),
        );
        return this.submit(intent);
    }
    public requestPermissionBan(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        userId: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createPermissionBan(
            guildId,
            channelId,
            targetId,
            targetType,
            IntentFactory.userSource(userId, 'Permission change'),
        );
        return this.submit(intent);
    }
    public requestUserKick(
        guildId: string,
        userId: string,
        channelId: string,
        reason?: string,
    ): ReturnType<typeof this.submit> {
        const intent = IntentFactory.createUserKick(
            guildId,
            userId,
            channelId,
            reason,
            IntentFactory.systemSource('Access protection'),
        );
        return this.submit(intent);
    }
    public getStats(): VCNSStats {
        return {
            uptime: this.isRunning ? Date.now() - this.startedAt : 0,
            intentsProcessed: this.intentsProcessed,
            intentsFailed: this.intentsFailed,
            intentsDropped: this.intentsDropped,
            currentQueueSize: intentQueue.size(),
            currentPressure: rateGovernor.getPressure(),
            isDefenseMode: stateStore.getSystemState().defenseMode,
            isEmergencyMode: rateGovernor.isInEmergencyMode(),
        };
    }
    public userOwnsChannel(guildId: string, userId: string): boolean {
        return stateStore.isChannelOwner(guildId, userId);
    }
    public getChannelByOwner(guildId: string, userId: string): string | null {
        return stateStore.getChannelByOwner(guildId, userId);
    }
    public isChannelManaged(channelId: string): boolean {
        return stateStore.getChannelState(channelId) !== null;
    }
    public getChannelState(channelId: string) {
        return stateStore.getChannelState(channelId);
    }
    public isGuildPaused(guildId: string): boolean {
        return stateStore.isGuildPaused(guildId);
    }
    public pauseGuild(guildId: string): void {
        stateStore.pauseGuild(guildId);
    }
    public resumeGuild(guildId: string): void {
        stateStore.resumeGuild(guildId);
    }
    private setupEventListeners(): void {
        intentQueue.on('intentDropped', (intent, reason) => {
            this.intentsDropped++;
            console.log(`[VCNS] Intent ${intent.id} dropped: ${reason}`);
        });
        rateGovernor.on('pressureChanged', (pressure) => {
            if (pressure >= VCNS_CONFIG.RATE_CRITICAL_THRESHOLD) {
                console.warn(`[VCNS] CRITICAL pressure: ${pressure}%`);
            } else if (pressure >= VCNS_CONFIG.RATE_PRESSURE_THRESHOLD) {
                console.warn(`[VCNS] High pressure: ${pressure}%`);
            }
        });
        rateGovernor.on('emergencyModeActivated', () => {
            console.warn('[VCNS] Emergency mode ACTIVATED');
        });
        rateGovernor.on('emergencyModeDeactivated', () => {
            console.log('[VCNS] Emergency mode deactivated');
        });
    }
}
export const vcns = new VCNSController();
export { stateStore } from './stateStore';
export { intentQueue } from './intentQueue';
export { rateGovernor } from './rateGovernor';
export { decisionEngine } from './decisionEngine';
export { scheduler } from './scheduler';
export { lockManager } from './lockManager';
export { IntentFactory } from './intentFactory';
export { vcnsBridge, executeWithVCNS } from './bridge';
export { buildVC, type VCBuildOptions, type VCBuildResult } from './vcBuilder';
export * from './resourceKeys';
export * from './types';

import { EventEmitter } from 'events';
import {
    Intent,
    IntentStatus,
    Decision,
    DecisionReason,
    VCNS_CONFIG,
} from './types';
import { intentQueue } from './intentQueue';
import { decisionEngine } from './decisionEngine';
import { stateStore } from './stateStore';
import { rateGovernor } from './rateGovernor';
interface ScheduledIntent {
    intent: Intent<unknown>;
    decision: Decision;
    scheduledAt: number;
    executeAt: number;
}
interface SchedulerStats {
    scheduled: number;
    executed: number;
    rejected: number;
    delayed: number;
    avgScheduleTime: number;
}
interface SchedulerEvents {
    intentScheduled: (intent: Intent<unknown>, executeAt: number) => void;
    intentRejected: (intent: Intent<unknown>, reason: DecisionReason) => void;
    intentReady: (intent: Intent<unknown>) => void;
    cycleComplete: (stats: SchedulerStats) => void;
}
export class Scheduler extends EventEmitter {
    private scheduled: Map<string, ScheduledIntent> = new Map();
    private running = false;
    private loopInterval: NodeJS.Timeout | null = null;
    private stats: SchedulerStats = {
        scheduled: 0,
        executed: 0,
        rejected: 0,
        delayed: 0,
        avgScheduleTime: 0,
    };
    private scheduleTimesMs: number[] = [];
    private readonly MAX_SCHEDULE_TIMES = 100;
    private executeCallback: ((intent: Intent<unknown>) => Promise<void>) | null = null;
    constructor() {
        super();
    }
    public start(executeCallback: (intent: Intent<unknown>) => Promise<void>): void {
        if (this.running) {
            return;
        }
        this.executeCallback = executeCallback;
        this.running = true;
        this.startLoop();
        console.log('[Scheduler] Started');
    }
    public stop(): void {
        this.running = false;
        if (this.loopInterval) {
            clearInterval(this.loopInterval);
            this.loopInterval = null;
        }
        console.log('[Scheduler] Stopped');
    }
    public isRunning(): boolean {
        return this.running;
    }
    private startLoop(): void {
        this.loopInterval = setInterval(() => {
            this.cycle();
        }, 50);
    }
    private cycle(): void {
        if (!this.running) return;
        const cycleStart = Date.now();
        this.processReadyIntents();
        this.pullFromQueue();
        this.cleanupExpired();
        const cycleTime = Date.now() - cycleStart;
        this.recordScheduleTime(cycleTime);
    }
    private processReadyIntents(): void {
        const now = Date.now();
        const ready: ScheduledIntent[] = [];
        for (const [intentId, scheduled] of this.scheduled) {
            if (now >= scheduled.executeAt) {
                ready.push(scheduled);
            }
        }
        ready.sort((a, b) => {
            if (a.intent.priority !== b.intent.priority) {
                return a.intent.priority - b.intent.priority;
            }
            return a.scheduledAt - b.scheduledAt;
        });
        const systemState = stateStore.getSystemState();
        const maxToProcess = VCNS_CONFIG.MAX_CONCURRENT_WORKERS - systemState.activeWorkers;
        for (let i = 0; i < Math.min(ready.length, maxToProcess); i++) {
            const scheduled = ready[i];
            this.scheduled.delete(scheduled.intent.id);
            this.dispatchToWorker(scheduled.intent);
        }
    }
    private pullFromQueue(): void {
        const systemState = stateStore.getSystemState();
        const scheduledCount = this.scheduled.size;
        const maxScheduled = VCNS_CONFIG.MAX_CONCURRENT_WORKERS * 3; 
        if (scheduledCount >= maxScheduled) {
            return;
        }
        if (rateGovernor.isInEmergencyMode()) {
            return;
        }
        const toPull = Math.min(
            maxScheduled - scheduledCount,
            5, 
        );
        for (let i = 0; i < toPull; i++) {
            const intent = intentQueue.dequeue();
            if (!intent) {
                break; 
            }
            
            // CRITICAL FIX #5: Handle RETRY_SCHEDULED intents
            if (intent.status === IntentStatus.RETRY_SCHEDULED && intent.nextRetryAt) {
                const now = Date.now();
                if (now < intent.nextRetryAt) {
                    // Not yet ready for retry - schedule for later
                    const executeAt = intent.nextRetryAt;
                    const scheduled: ScheduledIntent = {
                        intent,
                        decision: { execute: true, notify: false }, // Retry already decided
                        scheduledAt: now,
                        executeAt,
                    };
                    this.scheduled.set(intent.id, scheduled);
                    intent.status = IntentStatus.SCHEDULED;
                    continue;
                }
                // Ready for retry now - reset status and proceed
                intent.status = IntentStatus.PENDING;
                intent.nextRetryAt = undefined;
            }
            
            this.scheduleIntent(intent);
        }
        stateStore.setQueueDepth(intentQueue.size());
    }
    private scheduleIntent(intent: Intent<unknown>): void {
        const decision = decisionEngine.decide(intent);
        if (!decision.execute) {
            intent.status = IntentStatus.DROPPED;
            intent.error = decision.reason;
            this.stats.rejected++;
            this.emit('intentRejected', intent, decision.reason);
            intentQueue.complete(intent.id);
            return;
        }
        const now = Date.now();
        const executeAt = now + (decision.delayMs || 0);
        const scheduled: ScheduledIntent = {
            intent,
            decision,
            scheduledAt: now,
            executeAt,
        };
        this.scheduled.set(intent.id, scheduled);
        intent.status = IntentStatus.SCHEDULED;
        if (decision.delayMs && decision.delayMs > 0) {
            this.stats.delayed++;
        }
        this.stats.scheduled++;
        this.emit('intentScheduled', intent, executeAt);
    }
    private dispatchToWorker(intent: Intent<unknown>): void {
        if (!this.executeCallback) {
            console.error('[Scheduler] No execute callback registered');
            return;
        }
        if (Date.now() > intent.expiresAt) {
            intent.status = IntentStatus.EXPIRED;
            intentQueue.complete(intent.id);
            this.stats.rejected++;
            this.emit('intentRejected', intent, DecisionReason.EXPIRED);
            return;
        }
        intent.status = IntentStatus.EXECUTING;
        stateStore.setActiveWorkers(stateStore.getSystemState().activeWorkers + 1);
        this.emit('intentReady', intent);
        this.stats.executed++;
        this.executeCallback(intent)
            .catch((error) => {
                console.error(`[Scheduler] Worker error for ${intent.id}:`, error);
            })
            .finally(() => {
                const current = stateStore.getSystemState().activeWorkers;
                stateStore.setActiveWorkers(Math.max(0, current - 1));
            });
    }
    private cleanupExpired(): void {
        const now = Date.now();
        for (const [intentId, scheduled] of this.scheduled) {
            if (now > scheduled.intent.expiresAt) {
                this.scheduled.delete(intentId);
                scheduled.intent.status = IntentStatus.EXPIRED;
                intentQueue.complete(intentId);
            }
        }
    }
    private recordScheduleTime(ms: number): void {
        this.scheduleTimesMs.push(ms);
        if (this.scheduleTimesMs.length > this.MAX_SCHEDULE_TIMES) {
            this.scheduleTimesMs.shift();
        }
        this.stats.avgScheduleTime = 
            this.scheduleTimesMs.reduce((a, b) => a + b, 0) / this.scheduleTimesMs.length;
    }
    public getStats(): SchedulerStats {
        return { ...this.stats };
    }
    public getScheduledCount(): number {
        return this.scheduled.size;
    }
    public getTotalPending(): number {
        return intentQueue.size() + this.scheduled.size;
    }
    public cancel(intentId: string): boolean {
        const scheduled = this.scheduled.get(intentId);
        if (scheduled) {
            this.scheduled.delete(intentId);
            scheduled.intent.status = IntentStatus.CANCELLED;
            intentQueue.complete(intentId);
            return true;
        }
        return false;
    }
    public expedite(intentId: string): boolean {
        const scheduled = this.scheduled.get(intentId);
        if (scheduled) {
            scheduled.executeAt = Date.now(); 
            return true;
        }
        return false;
    }
    public getETA(intentId: string): number | null {
        const scheduled = this.scheduled.get(intentId);
        if (scheduled) {
            return Math.max(0, scheduled.executeAt - Date.now());
        }
        if (intentQueue.has(intentId)) {
            return intentQueue.estimateWaitTime(1); 
        }
        return null;
    }
    public clearAll(): void {
        for (const [intentId, scheduled] of this.scheduled) {
            scheduled.intent.status = IntentStatus.CANCELLED;
            intentQueue.complete(intentId);
        }
        this.scheduled.clear();
    }
}
export const scheduler = new Scheduler();

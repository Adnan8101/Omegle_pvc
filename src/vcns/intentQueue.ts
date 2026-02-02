import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    Intent,
    IntentPriority,
    IntentStatus,
    IntentAction,
    VCNS_CONFIG,
} from './types';
import { hashPayload, intentDeduplicationKey } from './resourceKeys';
import { lockManager } from './lockManager';
import { rateGovernor } from './rateGovernor';
interface QueuedIntent {
    intent: Intent<unknown>;
    enqueuedAt: number;
}
interface QueueStats {
    totalSize: number;
    byPriority: Record<IntentPriority, number>;
    byGuild: Map<string, number>;
    byAction: Map<IntentAction, number>;
    oldestIntentAge: number;
    droppedCount: number;
    expiredCount: number;
}
export interface IntentQueueEvents {
    intentEnqueued: (intent: Intent<unknown>) => void;
    intentDequeued: (intent: Intent<unknown>) => void;
    intentDropped: (intent: Intent<unknown>, reason: string) => void;
    intentExpired: (intent: Intent<unknown>) => void;
    queuePressureHigh: (pressure: number) => void;
    queuePressureCritical: (pressure: number) => void;
}
export class IntentQueue extends EventEmitter {
    private queue: QueuedIntent[] = [];
    private guildCounts: Map<string, number> = new Map();
    private droppedCount = 0;
    private expiredCount = 0;
    private cleanupInterval: NodeJS.Timeout | null = null;
    constructor() {
        super();
        this.startCleanupLoop();
    }
    public enqueue(intent: Intent<unknown>): boolean {
        if (rateGovernor.isInEmergencyMode() && intent.priority !== IntentPriority.IMMEDIATE) {
            intent.status = IntentStatus.DROPPED;
            this.emit('intentDropped', intent, 'emergency_mode');
            return false;
        }
        if (this.queue.length >= VCNS_CONFIG.MAX_QUEUE_SIZE) {
            if (intent.priority !== IntentPriority.DROPPABLE) {
                const dropped = this.dropLowestPriority();
                if (!dropped) {
                    this.emit('intentDropped', intent, 'queue_full');
                    return false;
                }
            } else {
                this.emit('intentDropped', intent, 'queue_full_droppable');
                return false;
            }
        }
        const guildCount = this.guildCounts.get(intent.guildId) || 0;
        if (guildCount >= VCNS_CONFIG.MAX_QUEUE_SIZE_PER_GUILD) {
            if (intent.priority > IntentPriority.CRITICAL) {
                this.emit('intentDropped', intent, 'guild_queue_full');
                return false;
            }
        }
        if (this.isDuplicate(intent)) {
            intent.status = IntentStatus.DROPPED;
            this.emit('intentDropped', intent, 'duplicate');
            return false;
        }
        const currentHolder = lockManager.getHolder(intent.resourceId);
        if (currentHolder && currentHolder !== intent.id) {
        }
        this.queue.push({
            intent,
            enqueuedAt: Date.now(),
        });
        this.guildCounts.set(intent.guildId, guildCount + 1);
        this.sortQueue();
        this.emit('intentEnqueued', intent);
        this.checkPressure();
        return true;
    }
    public dequeue(): Intent<unknown> | null {
        if (this.queue.length === 0) {
            return null;
        }
        console.log(`[IntentQueue] 🔍 Dequeue called - queue size: ${this.queue.length}`);
        for (let i = 0; i < this.queue.length; i++) {
            const queued = this.queue[i];
            const intent = queued.intent;
            console.log(`[IntentQueue] 📋 Checking intent ${intent.id} (${intent.action}) - resourceId: ${intent.resourceId}`);
            if (Date.now() > intent.expiresAt) {
                console.log(`[IntentQueue] ⏰ Intent ${intent.id} EXPIRED`);
                this.queue.splice(i, 1);
                this.decrementGuildCount(intent.guildId);
                intent.status = IntentStatus.EXPIRED;
                this.expiredCount++;
                this.emit('intentExpired', intent);
                i--;
                continue;
            }
            const currentHolder = lockManager.getHolder(intent.resourceId);
            console.log(`[IntentQueue] 🔐 Lock check for ${intent.resourceId}: holder=${currentHolder}, intentId=${intent.id}`);
            if (currentHolder && currentHolder !== intent.id) {
                console.log(`[IntentQueue] ⏭️ Skipping intent ${intent.id} - resource locked by ${currentHolder}`);
                continue;
            }
            this.queue.splice(i, 1);
            this.decrementGuildCount(intent.guildId);
            const lockDuration = VCNS_CONFIG.INTENT_DEFAULT_TTL_MS;
            lockManager.acquire(intent.resourceId, intent.id, lockDuration, `intent:${intent.action}`);
            intent.status = IntentStatus.SCHEDULED;
            console.log(`[IntentQueue] ✅ Dequeued intent ${intent.id} successfully`);
            this.emit('intentDequeued', intent);
            return intent;
        }
        return null;
    }
    public peek(): Intent<unknown> | null {
        if (this.queue.length === 0) {
            return null;
        }
        this.cleanExpired();
        return this.queue[0]?.intent || null;
    }
    public complete(intentId: string): void {
        lockManager.releaseByHolder(intentId);
    }
    public requeue(intent: Intent<unknown>): boolean {
        this.complete(intent.id);
        if (Date.now() > intent.expiresAt) {
            intent.status = IntentStatus.EXPIRED;
            this.expiredCount++;
            this.emit('intentExpired', intent);
            return false;
        }
        if (intent.attempts >= intent.maxAttempts) {
            intent.status = IntentStatus.FAILED;
            return false;
        }
        if (intent.status === IntentStatus.FAILED ||
            intent.status === IntentStatus.DROPPED ||
            intent.status === IntentStatus.CANCELLED) {
            return false;
        }
        intent.status = IntentStatus.PENDING;
        return this.enqueue(intent);
    }
    public size(): number {
        return this.queue.length;
    }
    public guildSize(guildId: string): number {
        return this.guildCounts.get(guildId) || 0;
    }
    public estimateWaitTime(priority: IntentPriority): number {
        let count = 0;
        let totalCost = 0;
        for (const queued of this.queue) {
            if (queued.intent.priority <= priority) {
                count++;
                totalCost += queued.intent.cost;
            }
        }
        return totalCost * 100 + count * VCNS_CONFIG.MIN_DELAY_BETWEEN_ACTIONS_MS;
    }
    public has(intentId: string): boolean {
        return this.queue.some(q => q.intent.id === intentId);
    }
    public getStats(): QueueStats {
        const byPriority: Record<IntentPriority, number> = {
            [IntentPriority.IMMEDIATE]: 0,
            [IntentPriority.CRITICAL]: 0,
            [IntentPriority.HIGH]: 0,
            [IntentPriority.NORMAL]: 0,
            [IntentPriority.LOW]: 0,
            [IntentPriority.DROPPABLE]: 0,
        };
        const byGuild = new Map<string, number>();
        const byAction = new Map<IntentAction, number>();
        let oldestAge = 0;
        const now = Date.now();
        for (const queued of this.queue) {
            const intent = queued.intent;
            byPriority[intent.priority]++;
            const guildCount = byGuild.get(intent.guildId) || 0;
            byGuild.set(intent.guildId, guildCount + 1);
            const actionCount = byAction.get(intent.action) || 0;
            byAction.set(intent.action, actionCount + 1);
            const age = now - queued.enqueuedAt;
            if (age > oldestAge) {
                oldestAge = age;
            }
        }
        return {
            totalSize: this.queue.length,
            byPriority,
            byGuild,
            byAction,
            oldestIntentAge: oldestAge,
            droppedCount: this.droppedCount,
            expiredCount: this.expiredCount,
        };
    }
    private sortQueue(): void {
        const maxGuildCount = Math.max(1, ...this.guildCounts.values());
        this.queue.sort((a, b) => {
            if (a.intent.priority !== b.intent.priority) {
                return a.intent.priority - b.intent.priority;
            }
            const aGuildCount = this.guildCounts.get(a.intent.guildId) || 1;
            const bGuildCount = this.guildCounts.get(b.intent.guildId) || 1;
            const aWeight = aGuildCount / maxGuildCount;
            const bWeight = bGuildCount / maxGuildCount;
            if (Math.abs(aWeight - bWeight) > 0.1) {
                return aWeight - bWeight;
            }
            return a.enqueuedAt - b.enqueuedAt;
        });
    }
    private isDuplicate(intent: Intent<unknown>): boolean {
        const now = Date.now();
        const payloadHash = hashPayload(intent.payload);
        const dedupKey = intentDeduplicationKey(intent.action, intent.resourceId, payloadHash);
        return this.queue.some(q => {
            if (q.intent.id === intent.id) {
                return false;
            }
            if (intent.parentId && q.intent.id === intent.parentId) {
                return false;
            }
            const existingHash = hashPayload(q.intent.payload);
            const existingKey = intentDeduplicationKey(q.intent.action, q.intent.resourceId, existingHash);
            if (dedupKey !== existingKey) {
                return false;
            }
            const age = now - q.enqueuedAt;
            if (age > VCNS_CONFIG.DEDUP_WINDOW_MS) {
                return false;
            }
            return q.intent.status === IntentStatus.PENDING ||
                q.intent.status === IntentStatus.SCHEDULED;
        });
    }
    private dropLowestPriority(): boolean {
        const priorities = [IntentPriority.DROPPABLE, IntentPriority.LOW];
        for (const priority of priorities) {
            for (let i = this.queue.length - 1; i >= 0; i--) {
                if (this.queue[i].intent.priority === priority) {
                    const dropped = this.queue.splice(i, 1)[0];
                    this.decrementGuildCount(dropped.intent.guildId);
                    dropped.intent.status = IntentStatus.DROPPED;
                    this.droppedCount++;
                    this.emit('intentDropped', dropped.intent, 'pressure');
                    return true;
                }
            }
        }
        return false;
    }
    private decrementGuildCount(guildId: string): void {
        const count = this.guildCounts.get(guildId) || 0;
        if (count <= 1) {
            this.guildCounts.delete(guildId);
        } else {
            this.guildCounts.set(guildId, count - 1);
        }
    }
    private cleanExpired(): void {
        const now = Date.now();
        const toRemove: number[] = [];
        for (let i = 0; i < this.queue.length; i++) {
            if (now > this.queue[i].intent.expiresAt) {
                toRemove.push(i);
            }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) {
            const idx = toRemove[i];
            const removed = this.queue.splice(idx, 1)[0];
            this.decrementGuildCount(removed.intent.guildId);
            removed.intent.status = IntentStatus.EXPIRED;
            this.expiredCount++;
            this.emit('intentExpired', removed.intent);
        }
    }
    private checkPressure(): void {
        const pressure = (this.queue.length / VCNS_CONFIG.MAX_QUEUE_SIZE) * 100;
        if (pressure >= VCNS_CONFIG.RATE_CRITICAL_THRESHOLD) {
            this.emit('queuePressureCritical', pressure);
        } else if (pressure >= VCNS_CONFIG.RATE_PRESSURE_THRESHOLD) {
            this.emit('queuePressureHigh', pressure);
        }
    }
    private startCleanupLoop(): void {
        if (this.cleanupInterval) {
            return;
        }
        this.cleanupInterval = setInterval(() => {
            this.cleanExpired();
        }, VCNS_CONFIG.STATE_CLEANUP_INTERVAL_MS);
    }
    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
    public async saveToFile(filePath: string): Promise<void> {
        try {
            const data = JSON.stringify(this.queue, null, 2);
            await fs.writeFile(filePath, data, 'utf-8');
            console.log(`[IntentQueue] Saved ${this.queue.length} intents to ${filePath}`);
        } catch (error: any) {
            console.error(`[IntentQueue] Failed to save queue to file: ${error.message}`);
        }
    }
    public async loadFromFile(filePath: string): Promise<void> {
        try {
            try {
                await fs.access(filePath);
            } catch {
                console.log(`[IntentQueue] No queue dump found at ${filePath}, starting empty.`);
                return;
            }
            const data = await fs.readFile(filePath, 'utf-8');
            if (!data) return;
            const loaded: QueuedIntent[] = JSON.parse(data);
            if (!Array.isArray(loaded)) return;
            console.log(`[IntentQueue] Loading ${loaded.length} intents from ${filePath}...`);
            let loadedCount = 0;
            for (const item of loaded) {
                if (!item || !item.intent || !item.intent.id || !item.intent.action) {
                    continue;
                }
                if (item.intent.status === IntentStatus.EXECUTING ||
                    item.intent.status === IntentStatus.SCHEDULED) {
                    item.intent.status = IntentStatus.PENDING;
                }
                if (Date.now() > item.intent.expiresAt) {
                    continue;
                }
                this.queue.push(item);
                const guildCount = this.guildCounts.get(item.intent.guildId) || 0;
                this.guildCounts.set(item.intent.guildId, guildCount + 1);
                loadedCount++;
            }
            this.sortQueue();
            console.log(`[IntentQueue] Successfully restored ${loadedCount} intents.`);
            await fs.unlink(filePath).catch(() => { });
        } catch (error: any) {
            console.error(`[IntentQueue] Failed to load queue from file: ${error.message}`);
            const backupPath = `${filePath}.corrupt-${Date.now()}`;
            await fs.rename(filePath, backupPath).catch(() => { });
            console.warn(`[IntentQueue] Moved corrupt dump to ${backupPath}`);
        }
    }
}
export const intentQueue = new IntentQueue();

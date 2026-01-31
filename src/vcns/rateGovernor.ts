import { EventEmitter } from 'events';
import { stateStore } from './stateStore';
import { IntentAction, VCNS_CONFIG, IntentPriority } from './types';
interface RateBucket {
    name: string;
    remaining: number;
    limit: number;
    resetAt: number;
    lastRequest: number;
    consecutiveErrors: number;
}
interface CostEntry {
    timestamp: number;
    cost: number;
    action: IntentAction;
    isRetry?: boolean; 
}
interface RateGovernorEvents {
    pressureChanged: (pressure: number) => void;
    bucketExhausted: (bucketName: string) => void;
    globalRateLimitHit: () => void;
    slowdownActivated: (delayMs: number) => void;
    emergencyModeActivated: () => void;
    emergencyModeDeactivated: () => void;
}
export class RateGovernor extends EventEmitter {
    private buckets: Map<string, RateBucket> = new Map();
    private recentCosts: CostEntry[] = [];
    private globallyRateLimited = false;
    private globalRetryAfter = 0;
    private emergencyMode = false;
    private emergencyModeUntil = 0;
    private currentPressure = 0;
    private baseDelay = VCNS_CONFIG.MIN_DELAY_BETWEEN_ACTIONS_MS;
    private currentDelay = VCNS_CONFIG.MIN_DELAY_BETWEEN_ACTIONS_MS;
    private lastActionTime = 0;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private readonly COST_WINDOW_MS = 60000;
    private readonly MAX_COST_PER_WINDOW = 300;
    constructor() {
        super();
        this.startCleanupLoop();
    }
    public canProceed(action: IntentAction, priority: IntentPriority): { 
        allowed: boolean; 
        delayMs: number; 
        reason?: string;
    } {
        if (this.emergencyMode && priority > IntentPriority.IMMEDIATE) {
            return {
                allowed: false,
                delayMs: Math.max(0, this.emergencyModeUntil - Date.now()),
                reason: 'emergency_mode',
            };
        }
        if (this.globallyRateLimited && priority > IntentPriority.IMMEDIATE) {
            return {
                allowed: false,
                delayMs: this.globalRetryAfter,
                reason: 'global_rate_limit',
            };
        }
        const now = Date.now();
        const timeSinceLastAction = now - this.lastActionTime;
        const requiredDelay = this.calculateRequiredDelay(action, priority);
        if (timeSinceLastAction < requiredDelay) {
            return {
                allowed: true,
                delayMs: requiredDelay - timeSinceLastAction,
            };
        }
        return {
            allowed: true,
            delayMs: 0,
        };
    }
    public recordAction(action: IntentAction, cost: number, isRetry: boolean = false): void {
        const now = Date.now();
        const effectiveCost = isRetry ? Math.ceil(cost * 0.5) : cost;
        this.recentCosts.push({
            timestamp: now,
            cost: effectiveCost,
            action,
            isRetry,
        });
        this.lastActionTime = now;
        this.recalculatePressure();
    }
    public recordRetry(action: IntentAction, cost: number): void {
        this.recordAction(action, cost, true);
    }
    public recordRateLimitHit(
        route: string,
        retryAfterMs: number,
        isGlobal: boolean,
    ): void {
        if (isGlobal) {
            this.globallyRateLimited = true;
            this.globalRetryAfter = retryAfterMs;
            this.emit('globalRateLimitHit');
            setTimeout(() => {
                this.globallyRateLimited = false;
                this.globalRetryAfter = 0;
            }, retryAfterMs);
        }
        const bucket = this.getOrCreateBucket(route);
        bucket.remaining = 0;
        bucket.resetAt = Date.now() + retryAfterMs;
        bucket.consecutiveErrors++;
        if (bucket.consecutiveErrors >= 5) {
            this.activateEmergencyMode(VCNS_CONFIG.DEFENSE_MODE_DURATION_MS);
        }
        this.emit('bucketExhausted', route);
        this.recalculatePressure();
    }
    public recordSuccess(route: string): void {
        const bucket = this.buckets.get(route);
        if (bucket) {
            bucket.consecutiveErrors = 0;
            bucket.lastRequest = Date.now();
        }
    }
    public getPressure(): number {
        return this.currentPressure;
    }
    public isUnderPressure(): boolean {
        return this.currentPressure >= VCNS_CONFIG.RATE_PRESSURE_THRESHOLD;
    }
    public isInCriticalPressure(): boolean {
        return this.currentPressure >= VCNS_CONFIG.RATE_CRITICAL_THRESHOLD;
    }
    public isInEmergencyMode(): boolean {
        return this.emergencyMode;
    }
    public isGloballyRateLimited(): boolean {
        return this.globallyRateLimited;
    }
    private calculateRequiredDelay(action: IntentAction, priority: IntentPriority): number {
        if (priority === IntentPriority.IMMEDIATE) {
            return 0;
        }
        let delay = this.baseDelay;
        if (action === IntentAction.VC_CREATE) {
            delay = Math.max(delay, VCNS_CONFIG.VC_CREATE_MIN_DELAY_MS);
        }
        if (this.currentPressure >= VCNS_CONFIG.RATE_PRESSURE_THRESHOLD) {
            const pressureFactor = this.currentPressure / 100;
            delay = delay * (1 + pressureFactor * 2); 
        }
        const priorityMultiplier = 1 + (priority * 0.2); 
        delay = delay * priorityMultiplier;
        if (this.emergencyMode) {
            delay = delay * 3;
        }
        delay = delay + (Math.random() * 100);
        return Math.min(delay, VCNS_CONFIG.RETRY_MAX_DELAY_MS);
    }
    public getMinDelayForAction(action: IntentAction): number {
        switch (action) {
            case IntentAction.VC_CREATE:
                return VCNS_CONFIG.VC_CREATE_MIN_DELAY_MS;
            case IntentAction.VC_DELETE:
                return 200;
            case IntentAction.PERM_GRANT:
            case IntentAction.PERM_REVOKE:
            case IntentAction.PERM_BAN:
                return 150;
            default:
                return this.baseDelay;
        }
    }
    private recalculatePressure(): void {
        const now = Date.now();
        const windowStart = now - this.COST_WINDOW_MS;
        this.recentCosts = this.recentCosts.filter(c => c.timestamp > windowStart);
        const totalCost = this.recentCosts.reduce((sum, c) => sum + c.cost, 0);
        const newPressure = Math.min(100, (totalCost / this.MAX_COST_PER_WINDOW) * 100);
        if (newPressure !== this.currentPressure) {
            this.currentPressure = newPressure;
            stateStore.setRatePressure(newPressure);
            this.emit('pressureChanged', newPressure);
            this.adjustDelay();
        }
    }
    private adjustDelay(): void {
        if (this.currentPressure >= VCNS_CONFIG.RATE_CRITICAL_THRESHOLD) {
            this.currentDelay = this.baseDelay * 3;
            this.emit('slowdownActivated', this.currentDelay);
        } else if (this.currentPressure >= VCNS_CONFIG.RATE_PRESSURE_THRESHOLD) {
            this.currentDelay = this.baseDelay * 2;
            this.emit('slowdownActivated', this.currentDelay);
        } else {
            this.currentDelay = this.baseDelay;
        }
    }
    public activateEmergencyMode(durationMs: number): void {
        if (!this.emergencyMode) {
            this.emergencyMode = true;
            this.emergencyModeUntil = Date.now() + durationMs;
            stateStore.activateDefenseMode();
            this.emit('emergencyModeActivated');
            setTimeout(() => {
                this.deactivateEmergencyMode();
            }, durationMs);
        }
    }
    public deactivateEmergencyMode(): void {
        if (this.emergencyMode) {
            this.emergencyMode = false;
            this.emergencyModeUntil = 0;
            stateStore.deactivateDefenseMode();
            this.emit('emergencyModeDeactivated');
        }
    }
    private getOrCreateBucket(route: string): RateBucket {
        let bucket = this.buckets.get(route);
        if (!bucket) {
            bucket = {
                name: route,
                remaining: 50, 
                limit: 50,
                resetAt: 0,
                lastRequest: 0,
                consecutiveErrors: 0,
            };
            this.buckets.set(route, bucket);
        }
        return bucket;
    }
    public updateBucketFromHeaders(
        route: string,
        remaining: number,
        limit: number,
        resetAfterMs: number,
    ): void {
        const bucket = this.getOrCreateBucket(route);
        bucket.remaining = remaining;
        bucket.limit = limit;
        bucket.resetAt = Date.now() + resetAfterMs;
        bucket.lastRequest = Date.now();
        if (remaining < limit * 0.2) {
            this.recalculatePressure();
        }
    }
    public getBucketStats(): Map<string, { remaining: number; limit: number; errors: number }> {
        const stats = new Map<string, { remaining: number; limit: number; errors: number }>();
        for (const [route, bucket] of this.buckets) {
            stats.set(route, {
                remaining: bucket.remaining,
                limit: bucket.limit,
                errors: bucket.consecutiveErrors,
            });
        }
        return stats;
    }
    private startCleanupLoop(): void {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            const windowStart = now - this.COST_WINDOW_MS;
            this.recentCosts = this.recentCosts.filter(c => c.timestamp > windowStart);
            for (const [route, bucket] of this.buckets) {
                if (now - bucket.lastRequest > 300000) { 
                    this.buckets.delete(route);
                }
            }
            this.recalculatePressure();
        }, 30000); 
    }
    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
    public reset(): void {
        this.buckets.clear();
        this.recentCosts = [];
        this.globallyRateLimited = false;
        this.globalRetryAfter = 0;
        this.emergencyMode = false;
        this.emergencyModeUntil = 0;
        this.currentPressure = 0;
        this.currentDelay = this.baseDelay;
        this.lastActionTime = 0;
    }
}
export const rateGovernor = new RateGovernor();

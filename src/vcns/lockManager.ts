import { VCNS_CONFIG } from './types';
interface LockInfo {
    holder: string;
    lockedAt: number;
    expiresAt: number;
    reason?: string;
}
class LockManager {
    private locks = new Map<string, LockInfo>();
    private cleanupInterval: NodeJS.Timeout | null = null;
    constructor() {
        this.startCleanupLoop();
    }
    public acquire(
        resourceKey: string,
        holder: string,
        durationMs: number = VCNS_CONFIG.LOCK_DEFAULT_DURATION_MS,
        reason?: string,
    ): boolean {
        const now = Date.now();
        const existing = this.locks.get(resourceKey);
        if (existing) {
            if (now < existing.expiresAt) {
                if (existing.holder === holder) {
                    // Bug #2 Fix: Extend lock duration for same holder
                    existing.expiresAt = now + durationMs;
                    return true;
                }
                // Bug #2 Fix: Log lock contention for debugging
                console.warn(`[LockManager] Lock contention: ${resourceKey} held by ${existing.holder}, requested by ${holder}`);
                return false;
            }
            // Bug #2 Fix: Clean up expired lock
            console.log(`[LockManager] Expired lock removed: ${resourceKey}`);
            this.locks.delete(resourceKey);
        }
        this.locks.set(resourceKey, {
            holder,
            lockedAt: now,
            expiresAt: now + durationMs,
            reason,
        });
        return true;
    }
    public release(resourceKey: string, holder: string): boolean {
        const existing = this.locks.get(resourceKey);
        if (!existing) {
            return true;
        }
        if (existing.holder !== holder) {
            return false;
        }
        this.locks.delete(resourceKey);
        return true;
    }
    public forceRelease(resourceKey: string): void {
        this.locks.delete(resourceKey);
    }
    public isLocked(resourceKey: string): boolean {
        const existing = this.locks.get(resourceKey);
        if (!existing) return false;
        if (Date.now() >= existing.expiresAt) {
            this.locks.delete(resourceKey);
            return false;
        }
        return true;
    }
    public getHolder(resourceKey: string): string | null {
        const existing = this.locks.get(resourceKey);
        if (!existing) return null;
        if (Date.now() >= existing.expiresAt) {
            this.locks.delete(resourceKey);
            return null;
        }
        return existing.holder;
    }
    public releaseByHolder(holder: string): number {
        let released = 0;
        for (const [resourceKey, lock] of this.locks.entries()) {
            if (lock.holder === holder) {
                this.locks.delete(resourceKey);
                released++;
            }
        }
        return released;
    }
    public getRemainingTime(resourceKey: string): number {
        const existing = this.locks.get(resourceKey);
        if (!existing) return 0;
        const remaining = existing.expiresAt - Date.now();
        if (remaining <= 0) {
            this.locks.delete(resourceKey);
            return 0;
        }
        return remaining;
    }
    public getActiveLocks(): Map<string, LockInfo> {
        this.cleanup();
        return new Map(this.locks);
    }
    public getLockCount(): number {
        this.cleanup();
        return this.locks.size;
    }
    private cleanup(): void {
        const now = Date.now();
        for (const [key, info] of this.locks) {
            if (now >= info.expiresAt) {
                this.locks.delete(key);
            }
        }
    }
    private startCleanupLoop(): void {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, 30000);
    }
    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
    public clear(): void {
        this.locks.clear();
    }
}
export const lockManager = new LockManager();

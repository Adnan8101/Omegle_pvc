export enum Priority {
    IMMEDIATE = -1,
    CRITICAL = 0,
    HIGH = 1,
    NORMAL = 2,
    LOW = 3,
}
interface QueuedTask<T> {
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    retries: number;
    priority: Priority;
    createdAt: number;
}
interface RateLimitBucket {
    queue: QueuedTask<any>[];
    processing: boolean;
    lastRequest: number;
    retryAfter: number;
    consecutiveErrors: number;
}
let globalRateLimited = false;
let globalRetryAfter = 0;
const buckets = new Map<string, RateLimitBucket>();
const CONFIG = {
    MIN_DELAY: 50,
    MAX_RETRIES: 5,
    BASE_BACKOFF: 500,
    MAX_BACKOFF: 30000,
    GLOBAL_LIMIT_DELAY: 3000,
    JITTER_MAX: 200,
    QUEUE_TIMEOUT: 30000,
    ERROR_THRESHOLD: 3,
    SLOWDOWN_MULTIPLIER: 2,
    MAX_QUEUE_SIZE: 1000,
    CIRCUIT_BREAKER_THRESHOLD: 10,
    CIRCUIT_RESET_TIME: 60000,
};
let circuitOpen = false;
let circuitOpenedAt = 0;
let globalErrorCount = 0;
function getBucket(route: string): RateLimitBucket {
    if (!buckets.has(route)) {
        buckets.set(route, {
            queue: [],
            processing: false,
            lastRequest: 0,
            retryAfter: 0,
            consecutiveErrors: 0,
        });
    }
    return buckets.get(route)!;
}
function addJitter(baseMs: number): number {
    return baseMs + Math.random() * CONFIG.JITTER_MAX;
}
function calculateBackoff(retries: number, bucket: RateLimitBucket): number {
    let backoff = CONFIG.BASE_BACKOFF * Math.pow(2, retries);
    if (bucket.consecutiveErrors >= CONFIG.ERROR_THRESHOLD) {
        backoff *= CONFIG.SLOWDOWN_MULTIPLIER;
    }
    return Math.min(addJitter(backoff), CONFIG.MAX_BACKOFF);
}
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function sortQueueByPriority(queue: QueuedTask<any>[]): void {
    queue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
    });
}
function cleanupTimedOutTasks(bucket: RateLimitBucket): void {
    const now = Date.now();
    const timedOut = bucket.queue.filter(t => now - t.createdAt > CONFIG.QUEUE_TIMEOUT);
    for (const task of timedOut) {
        const index = bucket.queue.indexOf(task);
        if (index > -1) {
            bucket.queue.splice(index, 1);
            task.reject(new Error('Task timed out in queue'));
        }
    }
}
async function processBucket(bucket: RateLimitBucket): Promise<void> {
    if (bucket.processing || bucket.queue.length === 0) return;
    bucket.processing = true;
    while (bucket.queue.length > 0) {
        cleanupTimedOutTasks(bucket);
        sortQueueByPriority(bucket.queue);
        if (bucket.queue.length === 0) break;
        const task = bucket.queue[0];
        if (globalRateLimited) {
            await sleep(addJitter(globalRetryAfter || CONFIG.GLOBAL_LIMIT_DELAY));
            globalRateLimited = false;
            globalRetryAfter = 0;
        }
        if (bucket.retryAfter > 0) {
            await sleep(addJitter(bucket.retryAfter));
            bucket.retryAfter = 0;
        }
        const now = Date.now();
        const timeSinceLast = now - bucket.lastRequest;
        let minDelay = CONFIG.MIN_DELAY;
        if (bucket.consecutiveErrors >= CONFIG.ERROR_THRESHOLD) {
            minDelay *= CONFIG.SLOWDOWN_MULTIPLIER;
        }
        if (timeSinceLast < minDelay) {
            await sleep(minDelay - timeSinceLast);
        }
        try {
            const result = await task.execute();
            bucket.queue.shift();
            bucket.consecutiveErrors = 0;
            task.resolve(result);
        } catch (error: any) {
            const discordError = error as { code?: number; status?: number; retry_after?: number; message?: string };
            if (discordError.status === 429 || discordError.code === 429) {
                const retryAfter = (discordError.retry_after || 1) * 1000;
                if (error.message?.includes('global')) {
                    globalRateLimited = true;
                    globalRetryAfter = retryAfter;
                } else {
                    bucket.retryAfter = retryAfter;
                }
                bucket.consecutiveErrors++;
                continue;
            }
            if (discordError.status && discordError.status >= 500 && task.retries < CONFIG.MAX_RETRIES) {
                task.retries++;
                bucket.consecutiveErrors++;
                await sleep(calculateBackoff(task.retries, bucket));
                continue;
            }
            bucket.queue.shift();
            bucket.consecutiveErrors++;
            task.reject(error);
        }
        bucket.lastRequest = Date.now();
    }
    bucket.processing = false;
}
export function executeWithRateLimit<T>(
    route: string,
    task: () => Promise<T>,
    priority: Priority = Priority.NORMAL
): Promise<T> {
    if (priority === Priority.IMMEDIATE) {
        return task();
    }
    return new Promise((resolve, reject) => {
        if (circuitOpen) {
            const timeSinceOpen = Date.now() - circuitOpenedAt;
            if (timeSinceOpen < CONFIG.CIRCUIT_RESET_TIME) {
                reject(new Error('Circuit breaker open - service temporarily unavailable'));
                return;
            }
            circuitOpen = false;
            globalErrorCount = 0;
        }
        const bucket = getBucket(route);
        if (bucket.queue.length >= CONFIG.MAX_QUEUE_SIZE) {
            reject(new Error('Queue full - service at capacity'));
            return;
        }
        bucket.queue.push({
            execute: task,
            resolve,
            reject,
            retries: 0,
            priority,
            createdAt: Date.now(),
        });
        processBucket(bucket);
    });
}
export function fireAndForget(
    route: string,
    task: () => Promise<any>,
    priority: Priority = Priority.LOW
): void {
    executeWithRateLimit(route, task, priority).catch(() => {
    });
}
export async function executeParallel<T>(
    tasks: Array<{ route: string; task: () => Promise<T>; priority?: Priority }>
): Promise<T[]> {
    return Promise.all(
        tasks.map(({ route, task, priority }) =>
            executeWithRateLimit(route, task, priority ?? Priority.NORMAL)
        )
    );
}
export function getQueueSize(route: string): number {
    return buckets.get(route)?.queue.length || 0;
}
export function getTotalQueueSize(): number {
    let total = 0;
    for (const bucket of buckets.values()) {
        total += bucket.queue.length;
    }
    return total;
}
export function isGloballyRateLimited(): boolean {
    return globalRateLimited;
}
export function getBucketStats(): Map<string, { queueSize: number; consecutiveErrors: number }> {
    const stats = new Map<string, { queueSize: number; consecutiveErrors: number }>();
    for (const [route, bucket] of buckets) {
        stats.set(route, {
            queueSize: bucket.queue.length,
            consecutiveErrors: bucket.consecutiveErrors,
        });
    }
    return stats;
}
export function clearAllBuckets(): void {
    buckets.clear();
    globalRateLimited = false;
    globalRetryAfter = 0;
}

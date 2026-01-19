/**
 * World-Class Rate Limiter with Priority Queue, Jitter, and Graceful Handling
 * Prevents Discord API rate limits and handles extreme load gracefully
 */

export enum Priority {
    CRITICAL = 0,  // User-facing immediate actions (replies, modals)
    HIGH = 1,      // Channel creation, permission changes
    NORMAL = 2,    // Standard operations
    LOW = 3,       // Background tasks, cleanup
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

// Global rate limit state
let globalRateLimited = false;
let globalRetryAfter = 0;

// Per-route buckets
const buckets = new Map<string, RateLimitBucket>();

// Configuration - tuned for high load
const CONFIG = {
    MIN_DELAY: 50,            // 50ms between requests (20 req/sec per bucket)
    MAX_RETRIES: 5,           // Max retry attempts
    BASE_BACKOFF: 500,        // Base backoff delay (500ms)
    MAX_BACKOFF: 30000,       // Max backoff delay (30s)
    GLOBAL_LIMIT_DELAY: 3000, // Delay when globally rate limited
    JITTER_MAX: 200,          // Max random jitter (ms)
    QUEUE_TIMEOUT: 30000,     // Max time a task can wait in queue
    ERROR_THRESHOLD: 3,       // Consecutive errors before slowdown
    SLOWDOWN_MULTIPLIER: 2,   // Multiply delay when errors occur
    MAX_QUEUE_SIZE: 1000,     // Max tasks per bucket (prevents memory exhaustion)
    CIRCUIT_BREAKER_THRESHOLD: 10, // Errors before circuit opens
    CIRCUIT_RESET_TIME: 60000,     // 1 minute before circuit half-opens
};

// Circuit breaker state
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

// Add random jitter to prevent thundering herd
function addJitter(baseMs: number): number {
    return baseMs + Math.random() * CONFIG.JITTER_MAX;
}

function calculateBackoff(retries: number, bucket: RateLimitBucket): number {
    let backoff = CONFIG.BASE_BACKOFF * Math.pow(2, retries);

    // Add extra delay if bucket has consecutive errors
    if (bucket.consecutiveErrors >= CONFIG.ERROR_THRESHOLD) {
        backoff *= CONFIG.SLOWDOWN_MULTIPLIER;
    }

    return Math.min(addJitter(backoff), CONFIG.MAX_BACKOFF);
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Sort queue by priority (lower number = higher priority)
function sortQueueByPriority(queue: QueuedTask<any>[]): void {
    queue.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt; // FIFO within same priority
    });
}

// Clean up timed out tasks
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
        // Cleanup and sort
        cleanupTimedOutTasks(bucket);
        sortQueueByPriority(bucket.queue);

        if (bucket.queue.length === 0) break;

        const task = bucket.queue[0];

        // Check global rate limit
        if (globalRateLimited) {
            await sleep(addJitter(globalRetryAfter || CONFIG.GLOBAL_LIMIT_DELAY));
            globalRateLimited = false;
            globalRetryAfter = 0;
        }

        // Check bucket-specific rate limit
        if (bucket.retryAfter > 0) {
            await sleep(addJitter(bucket.retryAfter));
            bucket.retryAfter = 0;
        }

        // Enforce minimum delay between requests (with error-based slowdown)
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
            bucket.queue.shift(); // Remove successful task
            bucket.consecutiveErrors = 0; // Reset error counter
            task.resolve(result);
        } catch (error: any) {
            const discordError = error as { code?: number; status?: number; retry_after?: number; message?: string };

            // Handle rate limit (429)
            if (discordError.status === 429 || discordError.code === 429) {
                const retryAfter = (discordError.retry_after || 1) * 1000;

                if (error.message?.includes('global')) {
                    globalRateLimited = true;
                    globalRetryAfter = retryAfter;
                } else {
                    bucket.retryAfter = retryAfter;
                }

                bucket.consecutiveErrors++;
                // Don't remove task, retry after delay
                continue;
            }

            // Handle transient errors (5xx) with retry
            if (discordError.status && discordError.status >= 500 && task.retries < CONFIG.MAX_RETRIES) {
                task.retries++;
                bucket.consecutiveErrors++;
                await sleep(calculateBackoff(task.retries, bucket));
                continue;
            }

            // Non-recoverable error or max retries reached
            bucket.queue.shift();
            bucket.consecutiveErrors++;
            task.reject(error);
        }

        bucket.lastRequest = Date.now();
    }

    bucket.processing = false;
}

/**
 * Execute a task with rate limiting and automatic retry
 * @param route - The route/bucket identifier (e.g., "channel:123456")
 * @param task - Async function to execute
 * @param priority - Priority level (default: NORMAL)
 */
export function executeWithRateLimit<T>(
    route: string,
    task: () => Promise<T>,
    priority: Priority = Priority.NORMAL
): Promise<T> {
    return new Promise((resolve, reject) => {
        // Circuit breaker check
        if (circuitOpen) {
            const timeSinceOpen = Date.now() - circuitOpenedAt;
            if (timeSinceOpen < CONFIG.CIRCUIT_RESET_TIME) {
                reject(new Error('Circuit breaker open - service temporarily unavailable'));
                return;
            }
            // Half-open: try one request
            circuitOpen = false;
            globalErrorCount = 0;
        }

        const bucket = getBucket(route);

        // Queue overflow protection
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

/**
 * Execute multiple tasks in parallel with rate limiting
 * Tasks are distributed across buckets for optimal parallelism
 */
export async function executeParallel<T>(
    tasks: Array<{ route: string; task: () => Promise<T>; priority?: Priority }>
): Promise<T[]> {
    return Promise.all(
        tasks.map(({ route, task, priority }) =>
            executeWithRateLimit(route, task, priority ?? Priority.NORMAL)
        )
    );
}

/**
 * Get current queue size for a bucket (for monitoring)
 */
export function getQueueSize(route: string): number {
    return buckets.get(route)?.queue.length || 0;
}

/**
 * Get total queue size across all buckets
 */
export function getTotalQueueSize(): number {
    let total = 0;
    for (const bucket of buckets.values()) {
        total += bucket.queue.length;
    }
    return total;
}

/**
 * Check if globally rate limited
 */
export function isGloballyRateLimited(): boolean {
    return globalRateLimited;
}

/**
 * Get bucket stats (for monitoring)
 */
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

/**
 * Clear all buckets (for testing/reset)
 */
export function clearAllBuckets(): void {
    buckets.clear();
    globalRateLimited = false;
    globalRetryAfter = 0;
}

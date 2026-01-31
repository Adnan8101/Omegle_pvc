import prisma, { isConnected, connectAsync } from '../utils/database';
type EventType = 
    | 'vc_created'
    | 'vc_deleted'
    | 'vc_owner_changed'
    | 'vc_permission_changed'
    | 'vc_renamed'
    | 'vc_limit_changed'
    | 'intent_executed'
    | 'rate_pressure_event'
    | 'error_occurred';
interface PersistenceEvent {
    type: EventType;
    guildId: string;
    channelId?: string;
    userId?: string;
    data: Record<string, unknown>;
    timestamp: number;
}
interface BufferStats {
    size: number;
    oldestEvent: number | null;
    flushCount: number;
    failedFlushes: number;
    droppedEvents: number;
}
const CONFIG = {
    FLUSH_INTERVAL: 5000,       
    FLUSH_THRESHOLD: 50,        
    MAX_BUFFER_SIZE: 500,       
    MAX_RETRY_QUEUE: 100,       
    RETRY_DELAY: 10000,         
} as const;
let buffer: PersistenceEvent[] = [];
let retryQueue: PersistenceEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let isFlushInProgress = false;
const stats: BufferStats = {
    size: 0,
    oldestEvent: null,
    flushCount: 0,
    failedFlushes: 0,
    droppedEvents: 0,
};
export function recordEvent(
    type: EventType,
    guildId: string,
    data: Record<string, unknown> = {},
    channelId?: string,
    userId?: string
): void {
    const event: PersistenceEvent = {
        type,
        guildId,
        channelId,
        userId,
        data,
        timestamp: Date.now(),
    };
    if (buffer.length >= CONFIG.MAX_BUFFER_SIZE) {
        buffer.shift();
        stats.droppedEvents++;
    }
    buffer.push(event);
    stats.size = buffer.length;
    stats.oldestEvent = buffer[0]?.timestamp ?? null;
    if (buffer.length >= CONFIG.FLUSH_THRESHOLD) {
        flushAsync();
    }
}
export const events = {
    vcCreated(guildId: string, channelId: string, ownerId: string, data?: Record<string, unknown>) {
        recordEvent('vc_created', guildId, { ownerId, ...data }, channelId, ownerId);
    },
    vcDeleted(guildId: string, channelId: string, reason?: string) {
        recordEvent('vc_deleted', guildId, { reason }, channelId);
    },
    vcOwnerChanged(guildId: string, channelId: string, oldOwner: string, newOwner: string) {
        recordEvent('vc_owner_changed', guildId, { oldOwner, newOwner }, channelId, newOwner);
    },
    vcPermissionChanged(guildId: string, channelId: string, userId: string, action: string) {
        recordEvent('vc_permission_changed', guildId, { action }, channelId, userId);
    },
    ratePressure(guildId: string, pressure: number, queueSize: number) {
        recordEvent('rate_pressure_event', guildId, { pressure, queueSize });
    },
    error(guildId: string, error: string, context?: Record<string, unknown>) {
        recordEvent('error_occurred', guildId, { error, ...context });
    },
};
export function getStats(): Readonly<BufferStats> {
    return { ...stats };
}
export async function forceFlush(): Promise<void> {
    if (buffer.length === 0) return;
    await performFlush();
}
function flushAsync(): void {
    if (isFlushInProgress) return;
    setImmediate(() => {
        performFlush().catch(() => {
        });
    });
}
async function performFlush(): Promise<void> {
    if (isFlushInProgress) return;
    if (buffer.length === 0 && retryQueue.length === 0) return;
    isFlushInProgress = true;
    const eventsToWrite = [...retryQueue, ...buffer];
    buffer = [];
    retryQueue = [];
    stats.size = 0;
    stats.oldestEvent = null;
    try {
        if (!isConnected()) {
            connectAsync();
            throw new Error('Database not connected');
        }
        await writeBatch(eventsToWrite);
        stats.flushCount++;
    } catch (error) {
        stats.failedFlushes++;
        const toRetry = eventsToWrite.slice(0, CONFIG.MAX_RETRY_QUEUE);
        const dropped = eventsToWrite.length - toRetry.length;
        retryQueue = toRetry;
        stats.droppedEvents += dropped;
        setTimeout(() => flushAsync(), CONFIG.RETRY_DELAY);
    } finally {
        isFlushInProgress = false;
    }
}
async function writeBatch(events: PersistenceEvent[]): Promise<void> {
    if (events.length === 0) return;
    const byGuild = new Map<string, PersistenceEvent[]>();
    for (const event of events) {
        const list = byGuild.get(event.guildId) || [];
        list.push(event);
        byGuild.set(event.guildId, list);
    }
    const writes: Promise<unknown>[] = [];
    for (const [guildId, guildEvents] of byGuild) {
        if (guildEvents.length > 0) {
            console.log(`[PERSIST] Would write ${guildEvents.length} events for guild ${guildId}`);
        }
    }
    if (writes.length > 0) {
        await Promise.all(writes);
    }
}
export function start(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        if (buffer.length > 0) {
            flushAsync();
        }
    }, CONFIG.FLUSH_INTERVAL);
    console.log('[PERSIST] 🟢 Service started');
}
export async function stop(): Promise<void> {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    await forceFlush();
    console.log('[PERSIST] 🔴 Service stopped');
}
start();
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient;
    dbState: DatabaseState;
};
interface DatabaseState {
    connected: boolean;
    lastConnectAttempt: number;
    consecutiveFailures: number;
    backoffUntil: number;
    queryCount: number;
    errorCount: number;
}
const CONFIG = {
    POOL_SIZE: process.env.DB_POOL_SIZE ? parseInt(process.env.DB_POOL_SIZE) : 15,
    POOL_TIMEOUT: 20,           
    CONNECT_TIMEOUT: 15,        
    QUERY_TIMEOUT: 15000,       
    TRANSACTION_TIMEOUT: 25000, 
    MAX_BACKOFF: 30000,         
    BASE_BACKOFF: 1000,         
    MAX_RETRIES: 3,             
    STATEMENT_CACHE_SIZE: 50,  
    PGBOUNCER_MODE: false,      
} as const;
function buildConnectionUrl(): string {
    const baseUrl = process.env.DATABASE_URL || '';
    const cleanUrl = baseUrl
        .replace(/[&?]connection_limit=\d+/g, '')
        .replace(/[&?]pool_timeout=\d+/g, '')
        .replace(/[&?]connect_timeout=\d+/g, '')
        .replace(/[&?]statement_cache_size=\d+/g, '')
        .replace(/[&?]pgbouncer=\w+/g, '')
        .replace(/[&?]idle_in_transaction_session_timeout=\d+/g, '')
        .replace(/[&?]connect_timeout=\d+/g, '');
    const sep = cleanUrl.includes('?') ? '&' : '?';
    let params = `connection_limit=${CONFIG.POOL_SIZE}`;
    params += `&pool_timeout=${CONFIG.POOL_TIMEOUT}`;
    params += `&connect_timeout=${CONFIG.CONNECT_TIMEOUT}`;
    params += `&statement_cache_size=${CONFIG.STATEMENT_CACHE_SIZE}`;
    params += `&idle_in_transaction_session_timeout=30000`; 
    if (CONFIG.PGBOUNCER_MODE) {
        params += '&pgbouncer=true';
    }
    return `${cleanUrl}${sep}${params}`;
}
function createClient(): PrismaClient {
    const connectionUrl = buildConnectionUrl();
    return new PrismaClient({
        log: [
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
        ],
        datasources: { 
            db: { url: connectionUrl } 
        },
        transactionOptions: {
            maxWait: 5000,                     
            timeout: CONFIG.TRANSACTION_TIMEOUT, 
            isolationLevel: 'ReadCommitted',   
        },
    });
}
export const prisma: PrismaClient = globalForPrisma.prisma || createClient();
if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = prisma;
    (prisma as any).$on('error', (e: any) => {
        const errorMsg = e.message || '';
        if (errorMsg.includes('terminating connection due to administrator command')) {
            console.warn('[DB] ⚠️ Connection terminated by admin - will reconnect automatically');
            globalForPrisma.dbState.connected = false;
            setTimeout(() => connectAsync(), 1000);
        } else {
            console.error('[DB] ❌ Error event:', e);
            globalForPrisma.dbState.errorCount++;
            globalForPrisma.dbState.connected = false;
        }
    });
    (prisma as any).$on('warn', (e: any) => {
        console.warn('[DB] ⚠️ Warning:', e.message);
    });
}
globalForPrisma.dbState = globalForPrisma.dbState || {
    connected: false,
    lastConnectAttempt: 0,
    consecutiveFailures: 0,
    backoffUntil: 0,
    queryCount: 0,
    errorCount: 0,
};
let connectionInProgress = false;
async function killIdleConnections(): Promise<void> {
    try {
        const result = await prisma.$queryRawUnsafe<any[]>(`
            SELECT COUNT(*) as killed FROM (
                SELECT pg_terminate_backend(pid) as terminated
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND state = 'idle in transaction'
                  AND state_change < NOW() - INTERVAL '2 minutes'
                  AND pid <> pg_backend_pid()
                  AND application_name NOT LIKE '%prisma%'
            ) t WHERE terminated = true
        `);
        const killed = result[0]?.killed || 0;
        if (killed > 0) {
            console.log(`[DB] 🧹 Killed ${killed} stuck idle-in-transaction connection(s)`);
        }
    } catch (err: any) {
        console.error('[DB] ⚠️ Failed to clean idle connections:', err.message);
    }
}
export function connectAsync(): void {
    if (connectionInProgress) return;
    if (globalForPrisma.dbState.connected) return;
    const now = Date.now();
    if (now < globalForPrisma.dbState.backoffUntil) return;
    connectionInProgress = true;
    globalForPrisma.dbState.lastConnectAttempt = now;
    prisma.$connect()
        .then(() => prisma.$queryRaw`SELECT 1 as health_check`)
        .then(() => {
            globalForPrisma.dbState.connected = true;
            globalForPrisma.dbState.consecutiveFailures = 0;
            globalForPrisma.dbState.backoffUntil = 0;
            console.log('[DB] ✅ Connected to database');
        })
        .catch((err: Error) => {
            globalForPrisma.dbState.connected = false;
            globalForPrisma.dbState.consecutiveFailures++;
            const backoff = Math.min(
                CONFIG.BASE_BACKOFF * Math.pow(2, globalForPrisma.dbState.consecutiveFailures - 1),
                CONFIG.MAX_BACKOFF
            );
            globalForPrisma.dbState.backoffUntil = Date.now() + backoff;
            console.error(`[DB] ❌ Connection failed (retry in ${Math.round(backoff/1000)}s): ${err.message}`);
        })
        .finally(() => {
            connectionInProgress = false;
        });
}
export function isConnected(): boolean {
    return globalForPrisma.dbState.connected;
}
export function getState(): Readonly<DatabaseState> {
    return { ...globalForPrisma.dbState };
}
export async function withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = CONFIG.MAX_RETRIES,
    baseDelay = 500
): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (!globalForPrisma.dbState.connected) {
                connectAsync();
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            const result = await operation();
            globalForPrisma.dbState.queryCount++;
            return result;
        } catch (error: any) {
            lastError = error;
            globalForPrisma.dbState.errorCount++;
            const errorCode = error.code || '';
            const errorMsg = error.message?.toLowerCase() || '';
            const isRetryable = 
                errorCode === 'P1001' ||  
                errorCode === 'P1002' ||  
                errorCode === 'P1008' ||  
                errorCode === 'P1017' ||  
                errorCode === 'P2024' ||  
                errorCode === 'P2034' ||  
                errorMsg.includes('connection') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('deadlock') ||
                errorMsg.includes('terminating connection') ||
                errorMsg.includes('administrator command') ||
                errorMsg.includes('too many clients');
            if (!isRetryable || attempt === maxRetries) {
                console.error(`[DB] ❌ Operation failed after ${attempt} attempts:`, {
                    code: errorCode,
                    message: error.message,
                });
                throw error;
            }
            globalForPrisma.dbState.connected = false;
            const delay = baseDelay * Math.pow(2, attempt - 1);
            const jitter = Math.random() * 200;
            await new Promise(resolve => setTimeout(resolve, delay + jitter));
            console.warn(`[DB] ⚠️ Retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms (${errorCode || 'unknown error'})`);
        }
    }
    throw lastError || new Error('Max retries reached');
}
let healthCheckInterval: NodeJS.Timeout | null = null;
function startHealthCheck(): void {
    if (healthCheckInterval) return;
    let cleanupCounter = 0;
    healthCheckInterval = setInterval(async () => {
        if (!globalForPrisma.dbState.connected) {
            connectAsync();
            return;
        }
        try {
            await prisma.$queryRaw`SELECT 1 as ping`;
            cleanupCounter++;
            if (cleanupCounter >= 20) {
                cleanupCounter = 0;
                await killIdleConnections();
            }
        } catch (err: any) {
            const errMsg = err.message?.toLowerCase() || '';
            if (errMsg.includes('terminating connection')) {
                console.warn('[DB] ⚠️ Connection terminated - reconnecting...');
            } else {
                console.warn('[DB] ⚠️ Health check failed, marking disconnected');
            }
            globalForPrisma.dbState.connected = false;
            setTimeout(() => connectAsync(), 2000);
        }
    }, 30000);
}
let metricsInterval: NodeJS.Timeout | null = null;
function startMetrics(): void {
    if (metricsInterval) return;
    metricsInterval = setInterval(() => {
        const uptime = Math.round((Date.now() - globalForPrisma.dbState.lastConnectAttempt) / 1000);
        console.log(`[DB] 📊 Metrics | Queries: ${globalForPrisma.dbState.queryCount} | Errors: ${globalForPrisma.dbState.errorCount} | Uptime: ${uptime}s`);
    }, 300000);
}
let shuttingDown = false;
function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[DB] 🔄 Graceful shutdown initiated...');
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    if (metricsInterval) clearInterval(metricsInterval);
    prisma.$disconnect()
        .then(() => {
            console.log('[DB] ✅ All connections closed');
            process.exit(0);
        })
        .catch((err) => {
            console.error('[DB] ❌ Error during disconnect:', err.message);
            process.exit(1);
        });
}
if (!globalForPrisma.prisma) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('exit', shutdown);
}
(async () => {
    console.log(`[DB] 🚀 High-Load Mode | Pool: ${CONFIG.POOL_SIZE} connections | Timeout: ${CONFIG.POOL_TIMEOUT}s | Retries: ${CONFIG.MAX_RETRIES}`);
    console.log(`[DB] ⚡ Optimized for 1000+ concurrent PVC operations`);
    try {
        await prisma.$disconnect();
        console.log('[DB] 🧹 Disconnected stale connections');
    } catch (err) {
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    await connectAsync();
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
        await killIdleConnections();
    } catch (err) {
    }
    startHealthCheck();
    startMetrics();
})();
export default prisma;
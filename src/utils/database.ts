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

// PRODUCTION CONFIG - Minimal pool to prevent connection exhaustion
// Critical: Database has limited connection slots, must be conservative
const CONFIG = {
    // Connection Pool - MINIMAL to prevent "too many connections" errors
    // Using 3 connections per instance to allow multiple bot instances/scripts
    POOL_SIZE: process.env.DB_POOL_SIZE ? parseInt(process.env.DB_POOL_SIZE) : 3,
    POOL_TIMEOUT: 20,           // Wait 20s for connection from pool
    CONNECT_TIMEOUT: 10,        // 10s to establish new connection
    
    // Query & Transaction Timeouts
    QUERY_TIMEOUT: 10000,       // 10s max query execution
    TRANSACTION_TIMEOUT: 20000, // 20s max transaction duration
    
    // Reconnection Strategy
    MAX_BACKOFF: 30000,         // Max 30s backoff
    BASE_BACKOFF: 1000,         // Start with 1s backoff
    MAX_RETRIES: 3,             // Retry failed operations 3 times
    
    // Performance Optimization
    STATEMENT_CACHE_SIZE: 50,   // Cache 50 prepared statements
    PGBOUNCER_MODE: false,      // Set true if using PgBouncer
} as const;

function buildConnectionUrl(): string {
    const baseUrl = process.env.DATABASE_URL || '';
    
    // Clean existing params to prevent duplicates
    const cleanUrl = baseUrl
        .replace(/[&?]connection_limit=\d+/g, '')
        .replace(/[&?]pool_timeout=\d+/g, '')
        .replace(/[&?]connect_timeout=\d+/g, '')
        .replace(/[&?]statement_cache_size=\d+/g, '')
        .replace(/[&?]pgbouncer=\w+/g, '')
        .replace(/[&?]idle_in_transaction_session_timeout=\d+/g, '')
        .replace(/[&?]connect_timeout=\d+/g, '');
    
    const sep = cleanUrl.includes('?') ? '&' : '?';
    
    // Build minimal connection string to prevent exhaustion
    let params = `connection_limit=${CONFIG.POOL_SIZE}`;
    params += `&pool_timeout=${CONFIG.POOL_TIMEOUT}`;
    params += `&connect_timeout=${CONFIG.CONNECT_TIMEOUT}`;
    params += `&statement_cache_size=${CONFIG.STATEMENT_CACHE_SIZE}`;
    params += `&idle_in_transaction_session_timeout=30000`; // Kill idle transactions after 30s
    
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
            maxWait: 5000,                     // Wait max 5s to start transaction
            timeout: CONFIG.TRANSACTION_TIMEOUT, // Transaction times out after 30s
            isolationLevel: 'ReadCommitted',   // Balance between consistency & performance
        },
    });
}
export const prisma: PrismaClient = globalForPrisma.prisma || createClient();

if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = prisma;
    
    // Setup error event listeners
    (prisma as any).$on('error', (e: any) => {
        console.error('[DB] ❌ Error event:', e);
        globalForPrisma.dbState.errorCount++;
        globalForPrisma.dbState.connected = false;
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

/**
 * Kill idle database connections that are wasting resources
 * Run this on startup to clean up stale connections from previous instances
 */
async function killIdleConnections(): Promise<void> {
    try {
        // Kill connections idle for more than 5 minutes
        await prisma.$executeRaw`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle'
              AND state_change < NOW() - INTERVAL '5 minutes'
              AND pid <> pg_backend_pid()
        `;
        
        // Kill idle in transaction connections older than 30 seconds
        await prisma.$executeRaw`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle in transaction'
              AND state_change < NOW() - INTERVAL '30 seconds'
              AND pid <> pg_backend_pid()
        `;
        
        console.log('[DB] 🧹 Cleaned up idle database connections');
    } catch (err: any) {
        // Ignore errors - might not have permission
        console.warn('[DB] ⚠️ Could not clean idle connections:', err.message);
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
            // Ensure connection before operation
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
            
            // Check if error is retryable
            const isRetryable = 
                // Connection errors
                errorCode === 'P1001' ||  // Can't reach database
                errorCode === 'P1002' ||  // Database timeout
                errorCode === 'P1008' ||  // Operations timed out
                errorCode === 'P1017' ||  // Server closed connection
                errorCode === 'P2024' ||  // Timed out fetching connection
                errorCode === 'P2034' ||  // Transaction conflict
                // Message-based detection
                errorMsg.includes('connection') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('deadlock') ||
                errorMsg.includes('too many clients');
            
            if (!isRetryable || attempt === maxRetries) {
                console.error(`[DB] ❌ Operation failed after ${attempt} attempts:`, {
                    code: errorCode,
                    message: error.message,
                });
                throw error;
            }
            
            // Mark connection as potentially broken
            globalForPrisma.dbState.connected = false;
            
            // Exponential backoff with jitter
            const delay = baseDelay * Math.pow(2, attempt - 1);
            const jitter = Math.random() * 200;
            await new Promise(resolve => setTimeout(resolve, delay + jitter));
            
            console.warn(`[DB] ⚠️ Retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms (${errorCode || 'unknown error'})`);
        }
    }
    
    throw lastError || new Error('Max retries reached');
}

// Periodic health check and cleanup (every 30s)
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
            
            // Clean idle connections every 10 minutes (20 health checks)
            cleanupCounter++;
            if (cleanupCounter >= 20) {
                cleanupCounter = 0;
                killIdleConnections();
            }
        } catch (err) {
            console.warn('[DB] ⚠️ Health check failed, marking disconnected');
            globalForPrisma.dbState.connected = false;
        }
    }, 30000);
}

// Metrics reporting (every 5min)
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
    
    // Force disconnect all connections in pool
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
    proKill idle connections from previous instances
    try {
        await killIdleConnections();
    } catch (err) {
        // Ignore errors - might fail on first connect
    }
    
    // cess.on('exit', shutdown);
}

// Initialize with aggressive cleanup to handle restarts
(async () => {
    console.log(`[DB] 🚀 Minimal Pool Mode | Pool: ${CONFIG.POOL_SIZE} connections | Timeout: ${CONFIG.POOL_TIMEOUT}s | Retries: ${CONFIG.MAX_RETRIES}`);
    console.log(`[DB] 💡 Using minimal pool to prevent "too many connections" errors`);
    
    // Disconnect any stale connections from previous instance
    try {
        await prisma.$disconnect();
        console.log('[DB] 🧹 Cleaned up stale connections from previous instance');
    } catch (err) {
        // Ignore errors on initial disconnect
    }
    
    // Wait a moment for connections to fully close
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    connectAsync();
    startHealthCheck();
    startMetrics();
})();

export default prisma;
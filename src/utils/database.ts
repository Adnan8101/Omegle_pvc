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

// CRITICAL: Reduced pool size to avoid exhausting server connections
const CONFIG = {
    POOL_SIZE: 10,               // Conservative pool size
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
        .replace(/[&?]idle_in_transaction_session_timeout=\d+/g, '');
    
    const sep = cleanUrl.includes('?') ? '&' : '?';
    
    let params = `connection_limit=${CONFIG.POOL_SIZE}`;
    params += `&pool_timeout=${CONFIG.POOL_TIMEOUT}`;
    params += `&connect_timeout=${CONFIG.CONNECT_TIMEOUT}`;
    params += `&statement_cache_size=${CONFIG.STATEMENT_CACHE_SIZE}`;
    params += `&idle_in_transaction_session_timeout=30000`;
    
    if (CONFIG.PGBOUNCER_MODE) {
        params += '&pgbouncer=true';
    }
    
    const finalUrl = `${cleanUrl}${sep}${params}`;
    
    console.log('[DATABASE] Pool config: 10 connections, 20s timeout');
    
    return finalUrl;
}

function createClient(): PrismaClient {
    const connectionUrl = buildConnectionUrl();
    
    return new PrismaClient({
        log: [
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
            { emit: 'stdout', level: 'info' },
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
        } 
        else if (errorMsg.includes('remaining connection slots are reserved') || errorMsg.includes('P2037')) {
            console.error('[DB] 🚨 CONNECTION POOL EXHAUSTED!');
            globalForPrisma.dbState.errorCount++;
            globalForPrisma.dbState.connected = false;
        }
        else {
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

export function connectAsync(): void {
    if (connectionInProgress) return;
    if (globalForPrisma.dbState.connected) return;
    
    const now = Date.now();
    if (now < globalForPrisma.dbState.backoffUntil) return;
    
    connectionInProgress = true;
    globalForPrisma.dbState.lastConnectAttempt = now;
    
    console.log('[DATABASE] Attempting to connect...');
    
    let attempt = 0;
    const maxAttempts = CONFIG.MAX_RETRIES;
    
    const tryConnect = async () => {
        attempt++;
        console.log(`[DATABASE] Connection attempt ${attempt}/${maxAttempts}...`);
        
        try {
            await prisma.$connect();
            console.log('[DATABASE] ✅ Connected to PostgreSQL');
            globalForPrisma.dbState.connected = true;
            globalForPrisma.dbState.consecutiveFailures = 0;
            globalForPrisma.dbState.backoffUntil = 0;
            connectionInProgress = false;
            
        } catch (error: any) {
            console.error(`[DATABASE] ❌ Connection attempt ${attempt} failed:`, error.message);
            globalForPrisma.dbState.consecutiveFailures++;
            
            if (attempt < maxAttempts) {
                const backoff = Math.min(
                    CONFIG.BASE_BACKOFF * Math.pow(2, globalForPrisma.dbState.consecutiveFailures - 1),
                    CONFIG.MAX_BACKOFF
                );
                console.log(`[DATABASE] Retrying in ${backoff}ms...`);
                setTimeout(tryConnect, backoff);
            } else {
                console.error('[DATABASE] ❌ All connection attempts failed');
                const finalBackoff = Math.min(
                    CONFIG.BASE_BACKOFF * Math.pow(2, globalForPrisma.dbState.consecutiveFailures),
                    CONFIG.MAX_BACKOFF
                );
                globalForPrisma.dbState.backoffUntil = Date.now() + finalBackoff;
                connectionInProgress = false;
            }
        }
    };
    
    tryConnect();
}

export async function verifyConnection(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        globalForPrisma.dbState.connected = true;
        return true;
    } catch (error: any) {
        console.error('[DATABASE] ❌ Connection verification failed:', error.message);
        globalForPrisma.dbState.connected = false;
        return false;
    }
}

export async function closeConnection(): Promise<void> {
    try {
        await prisma.$disconnect();
        console.log('[DATABASE] Connection closed gracefully');
        globalForPrisma.dbState.connected = false;
    } catch (error: any) {
        console.error('[DATABASE] Error closing connection:', error.message);
    }
}

export function getConnectionStats() {
    return {
        connected: globalForPrisma.dbState.connected,
        queryCount: globalForPrisma.dbState.queryCount,
        errorCount: globalForPrisma.dbState.errorCount,
        consecutiveFailures: globalForPrisma.dbState.consecutiveFailures,
        lastConnectAttempt: globalForPrisma.dbState.lastConnectAttempt,
    };
}

export function isConnected(): boolean {
    return globalForPrisma.dbState.connected;
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3
): Promise<T> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            
            if (error.code === 'P2037' || error.message?.includes('connection slots')) {
                console.error(`[DB] Attempt ${attempt}/${maxRetries} failed - connection pool exhausted`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
            }
            
            if (attempt === maxRetries) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        }
    }
    
    throw lastError;
}

export default prisma;

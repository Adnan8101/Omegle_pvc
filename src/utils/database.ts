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
}
const CONFIG = {
    POOL_SIZE: 2,           
    POOL_TIMEOUT: 15,       
    CONNECT_TIMEOUT: 10,    
    MAX_BACKOFF: 60000,     
    BASE_BACKOFF: 1000,     
} as const;
function buildConnectionUrl(): string {
    const baseUrl = process.env.DATABASE_URL || '';
    const cleanUrl = baseUrl
        .replace(/[&?]connection_limit=\d+/g, '')
        .replace(/[&?]pool_timeout=\d+/g, '')
        .replace(/[&?]connect_timeout=\d+/g, '');
    const sep = cleanUrl.includes('?') ? '&' : '?';
    return `${cleanUrl}${sep}connection_limit=${CONFIG.POOL_SIZE}&pool_timeout=${CONFIG.POOL_TIMEOUT}&connect_timeout=${CONFIG.CONNECT_TIMEOUT}`;
}
function createClient(): PrismaClient {
    return new PrismaClient({
        log: [{ emit: 'event', level: 'error' }],
        datasources: { db: { url: buildConnectionUrl() } },
    });
}
export const prisma: PrismaClient = globalForPrisma.prisma || createClient();
globalForPrisma.prisma = prisma;
globalForPrisma.dbState = globalForPrisma.dbState || {
    connected: false,
    lastConnectAttempt: 0,
    consecutiveFailures: 0,
    backoffUntil: 0,
};
let connectionInProgress = false;
export function connectAsync(): void {
    if (connectionInProgress) return;
    if (globalForPrisma.dbState.connected) return;
    const now = Date.now();
    if (now < globalForPrisma.dbState.backoffUntil) return;
    connectionInProgress = true;
    globalForPrisma.dbState.lastConnectAttempt = now;
    prisma.$connect()
        .then(() => prisma.$queryRaw`SELECT 1`)
        .then(() => {
            globalForPrisma.dbState.connected = true;
            globalForPrisma.dbState.consecutiveFailures = 0;
            globalForPrisma.dbState.backoffUntil = 0;
            console.log('[DB] ✅ Connected');
        })
        .catch((err: Error) => {
            globalForPrisma.dbState.connected = false;
            globalForPrisma.dbState.consecutiveFailures++;
            const backoff = Math.min(
                CONFIG.BASE_BACKOFF * Math.pow(2, globalForPrisma.dbState.consecutiveFailures),
                CONFIG.MAX_BACKOFF
            );
            globalForPrisma.dbState.backoffUntil = Date.now() + backoff;
            console.warn(`[DB] ⚠️ Connection failed (retry in ${backoff}ms): ${err.message}`);
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
    maxRetries = 3,
    baseDelay = 500
): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (!globalForPrisma.dbState.connected) {
                connectAsync();
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return await operation();
        } catch (error: any) {
            lastError = error;
            const errorCode = error.code || '';
            const isRetryable = 
                errorCode === 'P1001' || 
                errorCode === 'P1002' || 
                errorCode === 'P1008' || 
                errorCode === 'P1017' || 
                errorCode === 'P2024' || 
                error.message?.toLowerCase().includes('connection') ||
                error.message?.toLowerCase().includes('timeout');
            if (!isRetryable || attempt === maxRetries) {
                throw error;
            }
            globalForPrisma.dbState.connected = false;
            const delay = baseDelay * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError || new Error('Max retries reached');
}
let shuttingDown = false;
function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    prisma.$disconnect().catch(() => {});
}
if (!globalForPrisma.prisma) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
console.log(`[DB] 🔧 GEN-2 Mode | Pool: ${CONFIG.POOL_SIZE} | Non-blocking`);
connectAsync();
export default prisma;
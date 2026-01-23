import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient({
    log: [],
    transactionOptions: {
        maxWait: 10000,
        timeout: 30000,
    },
});

globalForPrisma.prisma = prisma;

async function connectWithRetry(maxRetries = 5, delay = 3000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await prisma.$connect();
            return;
        } catch {
            if (attempt === maxRetries) {
                process.exit(1);
            }
            await new Promise(resolve => setTimeout(resolve, delay * attempt));
        }
    }
}

connectWithRetry();

process.on('beforeExit', async () => {
    await prisma.$disconnect();
});

export async function withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    delay = 1000
): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            const isConnectionError =
                error.code === 'P1001' ||
                error.code === 'P1002' ||
                error.code === 'P1008' ||
                error.code === 'P1017' ||
                error.message?.includes('connection') ||
                error.message?.includes('timeout');

            if (!isConnectionError || attempt === maxRetries) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, delay * attempt));

            try {
                await prisma.$connect();
            } catch {
            }
        }
    }
    throw new Error('Max retries reached');
}

export default prisma;
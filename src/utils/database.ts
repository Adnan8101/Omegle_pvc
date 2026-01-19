import { PrismaClient } from '@prisma/client';

// Singleton Prisma client to prevent connection pool exhaustion
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma || new PrismaClient({
    log: [], // Silent logging for production stability
    transactionOptions: {
        maxWait: 5000,   // 5s max wait for transaction
        timeout: 10000,  // 10s transaction timeout
    },
});

// Ensure singleton in all environments
globalForPrisma.prisma = prisma;

export default prisma;


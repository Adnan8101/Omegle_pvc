import prisma from '../utils/database';
import type { Guild, GuildMember, OverwriteResolvable } from 'discord.js';
export enum VCRequestType {
    PVC = 'PVC',
    TEAM_DUO = 'TEAM_DUO',
    TEAM_TRIO = 'TEAM_TRIO',
    TEAM_SQUAD = 'TEAM_SQUAD',
}
export enum VCRequestStatus {
    PENDING = 'PENDING',
    PROCESSING = 'PROCESSING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    RETRYING = 'RETRYING',
    EXPIRED = 'EXPIRED',
    CANCELLED = 'CANCELLED',
}
export interface VCCreationRequestData {
    userId: string;
    guildId: string;
    requestType: VCRequestType;
    channelName: string;
    parentId?: string;
    permissionOverwrites?: OverwriteResolvable[];
    priority?: number;
}
export interface VCCreationRequest {
    id: string;
    userId: string;
    guildId: string;
    requestType: VCRequestType;
    status: VCRequestStatus;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
    expiresAt: Date;
    retryCount: number;
    maxRetries: number;
    nextRetryAt: Date | null;
    lastError: string | null;
    channelId: string | null;
    priority: number;
    channelName: string;
    parentId: string | null;
    permissionData: string | null;
}
export class VCQueueService {
    private static instance: VCQueueService;
    private processingMap = new Map<string, boolean>(); 
    private constructor() {}
    public static getInstance(): VCQueueService {
        if (!VCQueueService.instance) {
            VCQueueService.instance = new VCQueueService();
        }
        return VCQueueService.instance;
    }
    public async createRequest(data: VCCreationRequestData): Promise<VCCreationRequest> {
        const existing = await prisma.vCCreationRequest.findFirst({
            where: {
                userId: data.userId,
                guildId: data.guildId,
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
            },
        });
        if (existing) {
            console.log(`[VCQueue] User ${data.userId} already has pending request ${existing.id}`);
            return existing as VCCreationRequest;
        }
        
        // Serialize permission data (with BigInt support for Discord.js permissions)
        const permissionData = data.permissionOverwrites 
            ? JSON.stringify(data.permissionOverwrites, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ) 
            : null;
        
        // Create new request with 24 hour expiration (extended on each retry)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const request = await prisma.vCCreationRequest.create({
            data: {
                userId: data.userId,
                guildId: data.guildId,
                requestType: data.requestType,
                channelName: data.channelName,
                parentId: data.parentId || null,
                permissionData,
                priority: data.priority || 5,
                expiresAt,
                maxRetries: 999, 
            },
        });
        console.log(`[VCQueue] ✅ Created request ${request.id} for user ${data.userId}`);
        return request as VCCreationRequest;
    }
    public async getNextRequest(): Promise<VCCreationRequest | null> {
        const now = new Date();
        const requests = await prisma.vCCreationRequest.findMany({
            where: {
                OR: [
                    { status: 'PENDING' },
                    {
                        status: 'RETRYING',
                        nextRetryAt: {
                            lte: now,
                        },
                    },
                ],
                expiresAt: {
                    gt: now,
                },
            },
            orderBy: [
                { priority: 'asc' },
                { createdAt: 'asc' },
            ],
            take: 10,
        });
        for (const request of requests) {
            if (!this.processingMap.get(request.id)) {
                return request as VCCreationRequest;
            }
        }
        return null;
    }
    public async markProcessing(requestId: string): Promise<void> {
        this.processingMap.set(requestId, true);
        await prisma.vCCreationRequest.update({
            where: { id: requestId },
            data: {
                status: 'PROCESSING',
                updatedAt: new Date(),
            },
        });
        console.log(`[VCQueue] 🔄 Request ${requestId} marked as PROCESSING`);
    }
    public async markCompleted(requestId: string, channelId: string): Promise<void> {
        this.processingMap.delete(requestId);
        await prisma.vCCreationRequest.update({
            where: { id: requestId },
            data: {
                status: 'COMPLETED',
                channelId,
                completedAt: new Date(),
                updatedAt: new Date(),
            },
        });
        console.log(`[VCQueue] ✅ Request ${requestId} COMPLETED with channel ${channelId}`);
    }
    public async markFailedAndRetry(requestId: string, error: string): Promise<void> {
        const request = await prisma.vCCreationRequest.findUnique({
            where: { id: requestId },
        });
        if (!request) {
            console.error(`[VCQueue] Request ${requestId} not found`);
            return;
        }
        this.processingMap.delete(requestId);
        const retryCount = request.retryCount + 1;
        const baseDelay = 5000;
        const maxDelay = 5 * 60 * 1000;
        const delayMs = Math.min(baseDelay * Math.pow(2, retryCount - 1), maxDelay);
        const nextRetryAt = new Date(Date.now() + delayMs);
        const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await prisma.vCCreationRequest.update({
            where: { id: requestId },
            data: {
                status: 'RETRYING',
                retryCount,
                nextRetryAt,
                lastError: error.substring(0, 500),
                expiresAt: newExpiresAt,
                updatedAt: new Date(),
            },
        });
        console.log(`[VCQueue] ⚠️ Request ${requestId} FAILED (retry #${retryCount}), next retry at ${nextRetryAt.toISOString()}`);
        console.log(`[VCQueue] Error: ${error}`);
    }
    public async cancelRequest(userId: string, guildId: string): Promise<void> {
        const request = await prisma.vCCreationRequest.findFirst({
            where: {
                userId,
                guildId,
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
            },
        });
        if (request) {
            this.processingMap.delete(request.id);
            await prisma.vCCreationRequest.update({
                where: { id: request.id },
                data: {
                    status: 'CANCELLED',
                    updatedAt: new Date(),
                },
            });
            console.log(`[VCQueue] ❌ Request ${request.id} CANCELLED by user`);
        }
    }
    public async getUserRequest(userId: string, guildId: string): Promise<VCCreationRequest | null> {
        const request = await prisma.vCCreationRequest.findFirst({
            where: {
                userId,
                guildId,
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
        return request as VCCreationRequest | null;
    }
    public async getQueuePosition(requestId: string): Promise<number> {
        const request = await prisma.vCCreationRequest.findUnique({
            where: { id: requestId },
        });
        if (!request) return -1;
        const position = await prisma.vCCreationRequest.count({
            where: {
                guildId: request.guildId,
                status: {
                    in: ['PENDING', 'RETRYING'],
                },
                OR: [
                    { priority: { lt: request.priority } },
                    {
                        priority: request.priority,
                        createdAt: { lt: request.createdAt },
                    },
                ],
            },
        });
        return position + 1;
    }
    public async getQueueSize(guildId: string): Promise<number> {
        return await prisma.vCCreationRequest.count({
            where: {
                guildId,
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
            },
        });
    }
    public async cleanupExpired(): Promise<number> {
        const result = await prisma.vCCreationRequest.updateMany({
            where: {
                expiresAt: {
                    lt: new Date(),
                },
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
            },
            data: {
                status: 'EXPIRED',
                updatedAt: new Date(),
            },
        });
        if (result.count > 0) {
            console.log(`[VCQueue] 🧹 Cleaned up ${result.count} expired requests`);
        }
        return result.count;
    }
    public async loadPendingRequests(): Promise<VCCreationRequest[]> {
        const requests = await prisma.vCCreationRequest.findMany({
            where: {
                status: {
                    in: ['PENDING', 'PROCESSING', 'RETRYING'],
                },
                expiresAt: {
                    gt: new Date(),
                },
            },
            orderBy: [
                { priority: 'asc' },
                { createdAt: 'asc' },
            ],
        });
        const processingIds = requests
            .filter(r => r.status === 'PROCESSING')
            .map(r => r.id);
        if (processingIds.length > 0) {
            await prisma.vCCreationRequest.updateMany({
                where: {
                    id: { in: processingIds },
                },
                data: {
                    status: 'PENDING',
                    updatedAt: new Date(),
                },
            });
            console.log(`[VCQueue] 🔄 Reset ${processingIds.length} PROCESSING requests to PENDING`);
        }
        console.log(`[VCQueue] 📥 Loaded ${requests.length} pending requests from database`);
        return requests as VCCreationRequest[];
    }
    public async getStats(guildId?: string): Promise<{
        pending: number;
        processing: number;
        retrying: number;
        completed: number;
        failed: number;
        expired: number;
    }> {
        const where = guildId ? { guildId } : {};
        const [pending, processing, retrying, completed, failed, expired] = await Promise.all([
            prisma.vCCreationRequest.count({ where: { ...where, status: 'PENDING' } }),
            prisma.vCCreationRequest.count({ where: { ...where, status: 'PROCESSING' } }),
            prisma.vCCreationRequest.count({ where: { ...where, status: 'RETRYING' } }),
            prisma.vCCreationRequest.count({ where: { ...where, status: 'COMPLETED' } }),
            prisma.vCCreationRequest.count({ where: { ...where, status: 'FAILED' } }),
            prisma.vCCreationRequest.count({ where: { ...where, status: 'EXPIRED' } }),
        ]);
        return { pending, processing, retrying, completed, failed, expired };
    }
}
export const vcQueueService = VCQueueService.getInstance();

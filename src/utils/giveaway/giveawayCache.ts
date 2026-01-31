import { prisma } from '../database';
import { Giveaway, GiveawayParticipant } from '@prisma/client';

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

const CACHE_TTL = {
    GIVEAWAY: 60 * 1000,
    PARTICIPANT_CHECK: 30 * 1000,
    PARTICIPANT_COUNT: 15 * 1000,
    GIVEAWAY_LIST: 30 * 1000,
    CONFIG: 5 * 60 * 1000,
};

const giveawayCache = new Map<string, CacheEntry<Giveaway | null>>();
const participantExistsCache = new Map<string, CacheEntry<boolean>>();
const participantCountCache = new Map<number, CacheEntry<number>>();
const activeGiveawaysByGuildCache = new Map<string, CacheEntry<Giveaway[]>>();
const configCache = new Map<string, CacheEntry<any>>();

export async function getCachedGiveaway(messageId: string): Promise<Giveaway | null> {
    const cached = giveawayCache.get(messageId);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
    
    giveawayCache.set(messageId, {
        data: giveaway,
        expiresAt: Date.now() + CACHE_TTL.GIVEAWAY
    });

    return giveaway;
}

export async function isParticipantCached(giveawayId: number, userId: string): Promise<boolean> {
    const cacheKey = `${giveawayId}-${userId}`;
    const cached = participantExistsCache.get(cacheKey);
    
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const existing = await prisma.giveawayParticipant.findFirst({
        where: { giveawayId, userId },
        select: { id: true }
    });

    const exists = !!existing;
    
    participantExistsCache.set(cacheKey, {
        data: exists,
        expiresAt: Date.now() + CACHE_TTL.PARTICIPANT_CHECK
    });

    return exists;
}

export async function getParticipantCountCached(giveawayId: number): Promise<number> {
    const cached = participantCountCache.get(giveawayId);
    
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const count = await prisma.giveawayParticipant.count({
        where: { giveawayId }
    });

    participantCountCache.set(giveawayId, {
        data: count,
        expiresAt: Date.now() + CACHE_TTL.PARTICIPANT_COUNT
    });

    return count;
}

export async function getActiveGiveawaysCached(guildId: string): Promise<Giveaway[]> {
    const cached = activeGiveawaysByGuildCache.get(guildId);
    
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const giveaways = await prisma.giveaway.findMany({
        where: { guildId, ended: false }
    });

    activeGiveawaysByGuildCache.set(guildId, {
        data: giveaways,
        expiresAt: Date.now() + CACHE_TTL.GIVEAWAY_LIST
    });

    return giveaways;
}

export async function getGiveawayConfigCached(guildId: string): Promise<any> {
    const cached = configCache.get(guildId);
    
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }

    const config = await prisma.giveawayConfig.findUnique({
        where: { guildId }
    });

    configCache.set(guildId, {
        data: config,
        expiresAt: Date.now() + CACHE_TTL.CONFIG
    });

    return config;
}

export async function addParticipantCached(giveawayId: number, userId: string): Promise<GiveawayParticipant> {
    const participant = await prisma.giveawayParticipant.create({
        data: {
            giveawayId,
            userId,
            joinedAt: BigInt(Date.now())
        }
    });

    // Update caches
    const cacheKey = `${giveawayId}-${userId}`;
    participantExistsCache.set(cacheKey, {
        data: true,
        expiresAt: Date.now() + CACHE_TTL.PARTICIPANT_CHECK
    });

    participantCountCache.delete(giveawayId);

    return participant;
}

export async function removeParticipantCached(giveawayId: number, userId: string): Promise<void> {
    await prisma.giveawayParticipant.deleteMany({
        where: { giveawayId, userId }
    });

    // Update caches
    const cacheKey = `${giveawayId}-${userId}`;
    participantExistsCache.set(cacheKey, {
        data: false,
        expiresAt: Date.now() + CACHE_TTL.PARTICIPANT_CHECK
    });

    participantCountCache.delete(giveawayId);
}

export function invalidateGiveawayCache(messageId: string): void {
    giveawayCache.delete(messageId);
}

export function invalidateAllGiveawayCaches(giveaway: { id: number; messageId: string; guildId: string }): void {
    giveawayCache.delete(giveaway.messageId);
    participantCountCache.delete(giveaway.id);
    activeGiveawaysByGuildCache.delete(giveaway.guildId);
    
    // Clear participant caches for this giveaway
    for (const key of participantExistsCache.keys()) {
        if (key.startsWith(`${giveaway.id}-`)) {
            participantExistsCache.delete(key);
        }
    }
}

export function updateGiveawayCache(giveaway: Giveaway): void {
    giveawayCache.set(giveaway.messageId, {
        data: giveaway,
        expiresAt: Date.now() + CACHE_TTL.GIVEAWAY
    });
}

export function cleanupGiveawayCache(): void {
    const now = Date.now();
    
    for (const [key, entry] of giveawayCache) {
        if (now > entry.expiresAt) giveawayCache.delete(key);
    }
    
    for (const [key, entry] of participantExistsCache) {
        if (now > entry.expiresAt) participantExistsCache.delete(key);
    }
    
    for (const [key, entry] of participantCountCache) {
        if (now > entry.expiresAt) participantCountCache.delete(key);
    }
    
    for (const [key, entry] of activeGiveawaysByGuildCache) {
        if (now > entry.expiresAt) activeGiveawaysByGuildCache.delete(key);
    }
    
    for (const [key, entry] of configCache) {
        if (now > entry.expiresAt) configCache.delete(key);
    }
}

setInterval(cleanupGiveawayCache, 5 * 60 * 1000);

export function getGiveawayCacheStats(): {
    giveaways: number;
    participants: number;
    counts: number;
    lists: number;
    configs: number;
} {
    return {
        giveaways: giveawayCache.size,
        participants: participantExistsCache.size,
        counts: participantCountCache.size,
        lists: activeGiveawaysByGuildCache.size,
        configs: configCache.size
    };
}

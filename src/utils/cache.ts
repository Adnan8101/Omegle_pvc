

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

interface CacheOptions {
    ttlMs: number;
}

class TTLCache<K, V> {
    private cache = new Map<K, CacheEntry<V>>();
    private readonly defaultTtlMs: number;
    private readonly maxSize: number;

    constructor(defaultTtlMs: number = 60000, maxSize: number = 10000) {
        this.defaultTtlMs = defaultTtlMs;
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }

        return entry.data;
    }

    set(key: K, value: V, ttlMs?: number): void {
        // LRU eviction if at max size
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }

        this.cache.set(key, {
            data: value,
            expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
        });
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    has(key: K): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return false;
        }

        return true;
    }

    clear(): void {
        this.cache.clear();
    }

    // Cleanup expired entries (call periodically)
    cleanup(): number {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                removed++;
            }
        }

        return removed;
    }

    get size(): number {
        return this.cache.size;
    }
}

// Cache TTL configurations (in milliseconds)
const CACHE_TTL = {
    GUILD_SETTINGS: 5 * 60 * 1000,      // 5 minutes - rarely changes
    CHANNEL_PERMISSIONS: 2 * 60 * 1000,  // 2 minutes
    OWNER_PERMISSIONS: 2 * 60 * 1000,    // 2 minutes
    WHITELIST: 5 * 60 * 1000,            // 5 minutes
};

// Type definitions
interface CachedGuildSettings {
    id: string;
    guildId: string;
    interfaceVcId: string | null;
    interfaceTextId: string | null;
    commandChannelId: string | null;
    staffRoleId: string | null;
    adminStrictness: boolean;
}

interface CachedPermission {
    targetId: string;
    targetType: string;
    permission: string;
}

interface CachedWhitelistEntry {
    targetId: string;
    targetType: string;
}

const guildSettingsCache = new TTLCache<string, CachedGuildSettings>(CACHE_TTL.GUILD_SETTINGS);
const channelPermissionsCache = new TTLCache<string, CachedPermission[]>(CACHE_TTL.CHANNEL_PERMISSIONS);
const ownerPermissionsCache = new TTLCache<string, CachedPermission[]>(CACHE_TTL.OWNER_PERMISSIONS);
const whitelistCache = new TTLCache<string, CachedWhitelistEntry[]>(CACHE_TTL.WHITELIST);

setInterval(() => {
    guildSettingsCache.cleanup();
    channelPermissionsCache.cleanup();
    ownerPermissionsCache.cleanup();
    whitelistCache.cleanup();
}, 5 * 60 * 1000);

export async function getGuildSettings(guildId: string): Promise<CachedGuildSettings | null> {
    const cached = guildSettingsCache.get(guildId);
    if (cached !== undefined) return cached;

    const { default: prisma, withRetry } = await import('./database');
    const settings = await withRetry(() => prisma.guildSettings.findUnique({
        where: { guildId },
    }));

    if (settings) {
        guildSettingsCache.set(guildId, settings);
    }

    return settings;
}

export function invalidateGuildSettings(guildId: string): void {
    guildSettingsCache.delete(guildId);
}

export async function getChannelPermissions(channelId: string): Promise<CachedPermission[]> {
    const cached = channelPermissionsCache.get(channelId);
    if (cached !== undefined) return cached;

    const { default: prisma, withRetry } = await import('./database');
    const permissions = await withRetry(() => prisma.voicePermission.findMany({
        where: { channelId },
        select: { targetId: true, targetType: true, permission: true },
    }));

    channelPermissionsCache.set(channelId, permissions);
    return permissions;
}

export function invalidateChannelPermissions(channelId: string): void {
    channelPermissionsCache.delete(channelId);
}

// ============ Owner Permissions (Persistent) ============

export async function getOwnerPermissions(guildId: string, ownerId: string): Promise<CachedPermission[]> {
    const cacheKey = `${guildId}:${ownerId}`;

    const cached = ownerPermissionsCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const { default: prisma, withRetry } = await import('./database');
    const permissions = await withRetry(() => prisma.ownerPermission.findMany({
        where: { guildId, ownerId },
        select: { targetId: true, targetType: true },
    }));

    const mapped = permissions.map(p => ({
        targetId: p.targetId,
        targetType: p.targetType,
        permission: 'permit',
    }));

    ownerPermissionsCache.set(cacheKey, mapped);
    return mapped;
}

export function invalidateOwnerPermissions(guildId: string, ownerId: string): void {
    ownerPermissionsCache.delete(`${guildId}:${ownerId}`);
}

export async function getWhitelist(guildId: string): Promise<CachedWhitelistEntry[]> {
    const cached = whitelistCache.get(guildId);
    if (cached !== undefined) return cached;

    const { default: prisma, withRetry } = await import('./database');
    const whitelist = await withRetry(() => prisma.strictnessWhitelist.findMany({
        where: { guildId },
        select: { targetId: true, targetType: true },
    }));

    whitelistCache.set(guildId, whitelist);
    return whitelist;
}

export function invalidateWhitelist(guildId: string): void {
    whitelistCache.delete(guildId);
}

// Cleanup expired entries automatically every 5 minutes
setInterval(() => {
    guildSettingsCache.cleanup();
    channelPermissionsCache.cleanup();
    ownerPermissionsCache.cleanup();
    whitelistCache.cleanup();
}, 5 * 60 * 1000); // Every 5 minutes

export async function batchUpsertPermissions(
    channelId: string,
    permissions: Array<{ targetId: string; targetType: string; permission: string }>
): Promise<void> {
    const { default: prisma, withRetry } = await import('./database');

    await withRetry(() => prisma.$transaction(
        permissions.map(perm =>
            prisma.voicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId: perm.targetId } },
                update: { permission: perm.permission },
                create: {
                    channelId,
                    targetId: perm.targetId,
                    targetType: perm.targetType,
                    permission: perm.permission,
                },
            })
        )
    ));

    invalidateChannelPermissions(channelId);
}

export async function batchUpsertOwnerPermissions(
    guildId: string,
    ownerId: string,
    permissions: Array<{ targetId: string; targetType: string }>
): Promise<void> {
    const { default: prisma, withRetry } = await import('./database');

    await withRetry(() => prisma.$transaction(
        permissions.map(perm =>
            prisma.ownerPermission.upsert({
                where: { guildId_ownerId_targetId: { guildId, ownerId, targetId: perm.targetId } },
                update: {},
                create: {
                    guildId,
                    ownerId,
                    targetId: perm.targetId,
                    targetType: perm.targetType,
                },
            })
        )
    ));

    invalidateOwnerPermissions(guildId, ownerId);
}

export async function batchDeleteOwnerPermissions(
    guildId: string,
    ownerId: string,
    targetIds: string[]
): Promise<void> {
    const { default: prisma, withRetry } = await import('./database');

    await withRetry(() => prisma.ownerPermission.deleteMany({
        where: {
            guildId,
            ownerId,
            targetId: { in: targetIds },
        },
    }));

    invalidateOwnerPermissions(guildId, ownerId);
}

export function getCacheStats(): Record<string, number> {
    return {
        guildSettings: guildSettingsCache.size,
        channelPermissions: channelPermissionsCache.size,
        ownerPermissions: ownerPermissionsCache.size,
        whitelist: whitelistCache.size,
    };
}

export function clearAllCaches(): void {
    guildSettingsCache.clear();
    channelPermissionsCache.clear();
    ownerPermissionsCache.clear();
    whitelistCache.clear();
}

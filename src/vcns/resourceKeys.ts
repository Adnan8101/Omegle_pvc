export function vcCreateLockKey(guildId: string, ownerId: string): string {
    return `vc:create:${guildId}:${ownerId}`;
}
export function vcCreateResourceId(guildId: string, ownerId: string): string {
    return `vc:create:${guildId}:${ownerId}`;
}
export function vcModifyLockKey(channelId: string): string {
    return `vc:modify:${channelId}`;
}
export function permissionLockKey(channelId: string): string {
    return `perm:${channelId}`;
}
export function userActionLockKey(guildId: string, userId: string): string {
    return `user:${guildId}:${userId}`;
}
export function ownerTransferLockKey(channelId: string): string {
    return `owner:transfer:${channelId}`;
}
export function messageLockKey(messageId: string): string {
    return `msg:${messageId}`;
}
export function rateLimitBucketKey(guildId: string, route: string): string {
    return `rate:${guildId}:${route}`;
}
export function intentDeduplicationKey(
    action: string,
    resourceId: string,
    payloadHash?: string,
): string {
    const base = `intent:${action}:${resourceId}`;
    return payloadHash ? `${base}:${payloadHash}` : base;
}
export function hashPayload(payload: unknown): string {
    try {
        const str = JSON.stringify(payload);
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    } catch (error) {
        const fallback = `${typeof payload}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        let hash = 0;
        for (let i = 0; i < fallback.length; i++) {
            const char = fallback.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }
}

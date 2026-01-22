
const pausedGuilds = new Set<string>();

// Pause message cache (guildId -> messageId)
const pauseMessageCache = new Map<string, string>();
export function isPvcPaused(guildId: string): boolean {
    return pausedGuilds.has(guildId);
}

export function pausePvc(guildId: string): void {
    pausedGuilds.add(guildId);
}

export function resumePvc(guildId: string): void {
    pausedGuilds.delete(guildId);
}

export function getPausedGuilds(): string[] {
    return Array.from(pausedGuilds);
}
export function setPauseMessageId(guildId: string, messageId: string): void {
    pauseMessageCache.set(guildId, messageId);
}

export function getPauseMessageId(guildId: string): string | undefined {
    return pauseMessageCache.get(guildId);
}


export function clearPauseMessageId(guildId: string): void {
    pauseMessageCache.delete(guildId);
}

interface CommandUsage {
    command: string;
    userId: string;
    guildId: string;
    timestamp: number;
    mentionedCount: number;
}

const recentCommands = new Map<string, CommandUsage[]>();
const TRACKING_TIMEOUT = 10000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [key, usages] of recentCommands.entries()) {
        const filtered = usages.filter(u => now - u.timestamp < TRACKING_TIMEOUT + 5000);
        if (filtered.length === 0) {
            recentCommands.delete(key);
        } else {
            recentCommands.set(key, filtered);
        }
    }
}, CLEANUP_INTERVAL);

export function trackCommandUsage(
    command: string,
    userId: string,
    guildId: string,
    mentionedCount: number
): boolean {
    if (mentionedCount !== 1) return false;

    const key = `${guildId}:${userId}:${command}`;
    const now = Date.now();

    const usages = recentCommands.get(key) || [];
    const recentUsages = usages.filter(u => now - u.timestamp < TRACKING_TIMEOUT);
    const shouldShowHint = recentUsages.length > 0;

    recentUsages.push({ command, userId, guildId, timestamp: now, mentionedCount });
    recentCommands.set(key, recentUsages);

    return shouldShowHint;
}

export function clearCommandTracking(command: string, userId: string, guildId: string): void {
    recentCommands.delete(`${guildId}:${userId}:${command}`);
}

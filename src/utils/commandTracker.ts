/**
 * Command tracker for detecting repeated single-user command usage
 * Used to suggest multi-user commands
 */

interface CommandUsage {
    command: string;
    userId: string;
    guildId: string;
    timestamp: number;
    mentionedCount: number;
}

// Store recent command usages
const recentCommands: Map<string, CommandUsage[]> = new Map();

// Clean up old entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    const timeout = 15000; // 15 seconds (buffer beyond the 10 second check)
    
    for (const [key, usages] of recentCommands.entries()) {
        const filtered = usages.filter(u => now - u.timestamp < timeout);
        if (filtered.length === 0) {
            recentCommands.delete(key);
        } else {
            recentCommands.set(key, filtered);
        }
    }
}, 5 * 60 * 1000);

/**
 * Track a command usage
 * @param command The command name (e.g., "au" or "ru")
 * @param userId The user who used the command
 * @param guildId The guild where the command was used
 * @param mentionedCount Number of users mentioned in this command
 * @returns true if user should receive a hint (used same command twice within 10 seconds with single mentions)
 */
export function trackCommandUsage(
    command: string,
    userId: string,
    guildId: string,
    mentionedCount: number
): boolean {
    // Only track if user mentioned exactly 1 user
    if (mentionedCount !== 1) {
        return false;
    }

    const key = `${guildId}:${userId}:${command}`;
    const now = Date.now();
    const timeout = 10000; // 10 seconds

    // Get existing usages
    const usages = recentCommands.get(key) || [];
    
    // Filter to only recent usages (within 10 seconds)
    const recentUsages = usages.filter(u => now - u.timestamp < timeout);

    // If user already used this command with 1 mention in the last 10 seconds, show hint
    const shouldShowHint = recentUsages.length > 0;

    // Add current usage
    recentUsages.push({
        command,
        userId,
        guildId,
        timestamp: now,
        mentionedCount,
    });

    // Store updated usages
    recentCommands.set(key, recentUsages);

    return shouldShowHint;
}

/**
 * Clear tracking for a specific user/command combination
 * Call this after showing the hint to prevent spam
 */
export function clearCommandTracking(command: string, userId: string, guildId: string): void {
    const key = `${guildId}:${userId}:${command}`;
    recentCommands.delete(key);
}

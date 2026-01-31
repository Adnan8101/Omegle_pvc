/**
 * Centralized Time Utility for Giveaway System
 * All time calculations use UTC/GMT timestamps
 */

/**
 * Parse duration string (e.g., "2m", "1h", "30s", "7d") to milliseconds
 * @param durationStr Duration string with format: <number><unit>
 * @returns Milliseconds or null if invalid
 */
export function parseDuration(durationStr: string): number | null {
    const regex = /^(\d+)(s|m|h|d|w)$/i;
    const match = durationStr.toLowerCase().match(regex);
    
    if (!match) return null;

    const value = parseInt(match[1]);
    if (isNaN(value) || value <= 0) return null;

    const unit = match[2];

    switch (unit) {
        case 's': return value * 1000;                    
        case 'm': return value * 60 * 1000;               
        case 'h': return value * 60 * 60 * 1000;          
        case 'd': return value * 24 * 60 * 60 * 1000;     
        case 'w': return value * 7 * 24 * 60 * 60 * 1000; 
        default: return null;
    }
}

/**
 * Get current UTC timestamp in milliseconds
 * @returns Current UTC time in milliseconds
 */
export function getNowUTC(): number {
    return Date.now();
}

/**
 * Calculate end time based on duration
 * @param durationMs Duration in milliseconds
 * @returns End timestamp in milliseconds (UTC)
 */
export function calculateEndTime(durationMs: number): number {
    return getNowUTC() + durationMs;
}

/**
 * Calculate end time from duration string
 * @param durationStr Duration string (e.g., "2m")
 * @returns End timestamp in milliseconds (UTC) or null if invalid
 */
export function calculateEndTimeFromString(durationStr: string): number | null {
    const durationMs = parseDuration(durationStr);
    if (durationMs === null) return null;
    
    return calculateEndTime(durationMs);
}

/**
 * Check if a giveaway has ended
 * @param endTime End timestamp in milliseconds
 * @returns true if ended, false otherwise
 */
export function hasEnded(endTime: number | bigint): boolean {
    const endTimeMs = typeof endTime === 'bigint' ? Number(endTime) : endTime;
    return getNowUTC() >= endTimeMs;
}

/**
 * Get remaining time in milliseconds
 * @param endTime End timestamp in milliseconds
 * @returns Remaining time in milliseconds (0 if ended)
 */
export function getRemainingTime(endTime: number | bigint): number {
    const endTimeMs = typeof endTime === 'bigint' ? Number(endTime) : endTime;
    const remaining = endTimeMs - getNowUTC();
    return remaining > 0 ? remaining : 0;
}

/**
 * Format duration to human-readable string
 * @param ms Duration in milliseconds
 * @returns Formatted string (e.g., "2m 30s", "1h 15m")
 */
export function formatDuration(ms: number): string {
    if (ms <= 0) return "0s";

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    const parts: string[] = [];
    
    if (days > 0) parts.push(`${days}d`);
    if (hours % 24 > 0) parts.push(`${hours % 24}h`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
    if (seconds % 60 > 0 && parts.length < 2) parts.push(`${seconds % 60}s`);

    return parts.slice(0, 2).join(' ') || "0s";
}

/**
 * Format timestamp to Discord timestamp format
 * @param timestamp Timestamp in milliseconds
 * @param format Discord timestamp format (t, T, d, D, f, F, R)
 * @returns Discord formatted timestamp string
 */
export function toDiscordTimestamp(timestamp: number | bigint, format: string = 'R'): string {
    const timestampSec = typeof timestamp === 'bigint' 
        ? Number(timestamp) / 1000 
        : Math.floor(timestamp / 1000);
    
    return `<t:${Math.floor(timestampSec)}:${format}>`;
}

/**
 * Validate duration string
 * @param durationStr Duration string to validate
 * @returns Object with isValid boolean and error message if invalid
 */
export function validateDuration(durationStr: string): { isValid: boolean; error?: string } {
    const duration = parseDuration(durationStr);
    
    if (duration === null) {
        return {
            isValid: false,
            error: "Invalid duration format. Use format like: 30s, 2m, 1h, 7d"
        };
    }
    
    
    if (duration < 5000) {
        return {
            isValid: false,
            error: "Duration must be at least 5 seconds"
        };
    }
    
    
    if (duration > 60 * 24 * 60 * 60 * 1000) {
        return {
            isValid: false,
            error: "Duration cannot exceed 60 days"
        };
    }
    
    return { isValid: true };
}

/**
 * Convert milliseconds to BigInt for Prisma
 * @param ms Milliseconds
 * @returns BigInt timestamp
 */
export function toBigInt(ms: number): bigint {
    return BigInt(Math.floor(ms));
}

/**
 * Calculate delay for setTimeout based on end time
 * Maximum delay is capped at 2^31-1 ms (~24.8 days)
 * @param endTime End timestamp in milliseconds
 * @returns Delay in milliseconds (capped) or null if already ended
 */
export function calculateTimeout(endTime: number | bigint): number | null {
    const remaining = getRemainingTime(endTime);
    
    if (remaining <= 0) return null;
    
    
    const MAX_TIMEOUT = 2147483647; 
    
    return Math.min(remaining, MAX_TIMEOUT);
}

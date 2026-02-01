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
export function getNowUTC(): number {
    return Date.now();
}
export function calculateEndTime(durationMs: number): number {
    return getNowUTC() + durationMs;
}
export function calculateEndTimeFromString(durationStr: string): number | null {
    const durationMs = parseDuration(durationStr);
    if (durationMs === null) return null;
    return calculateEndTime(durationMs);
}
export function hasEnded(endTime: number | bigint): boolean {
    const endTimeMs = typeof endTime === 'bigint' ? Number(endTime) : endTime;
    return getNowUTC() >= endTimeMs;
}
export function getRemainingTime(endTime: number | bigint): number {
    const endTimeMs = typeof endTime === 'bigint' ? Number(endTime) : endTime;
    const remaining = endTimeMs - getNowUTC();
    return remaining > 0 ? remaining : 0;
}
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
export function toDiscordTimestamp(timestamp: number | bigint, format: string = 'R'): string {
    const timestampSec = typeof timestamp === 'bigint' 
        ? Number(timestamp) / 1000 
        : Math.floor(timestamp / 1000);
    return `<t:${Math.floor(timestampSec)}:${format}>`;
}
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
export function toBigInt(ms: number): bigint {
    return BigInt(Math.floor(ms));
}
export function calculateTimeout(endTime: number | bigint): number | null {
    const remaining = getRemainingTime(endTime);
    if (remaining <= 0) return null;
    const MAX_TIMEOUT = 2147483647; 
    return Math.min(remaining, MAX_TIMEOUT);
}

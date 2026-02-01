import { stateStore } from '../vcns/index';
const pausedGuilds = new Set<string>();
const pauseMessageCache = new Map<string, string>();
export function isPvcPaused(guildId: string): boolean {
    return pausedGuilds.has(guildId) || stateStore.isGuildPaused(guildId);
}
export function pausePvc(guildId: string): void {
    pausedGuilds.add(guildId);
    stateStore.pauseGuild(guildId);
}
export function resumePvc(guildId: string): void {
    pausedGuilds.delete(guildId);
    stateStore.resumeGuild(guildId);
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

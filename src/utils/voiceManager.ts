import type { VoiceChannel } from 'discord.js';
interface VoiceChannelState {
    channelId: string;
    guildId: string;
    ownerId: string;
    interfaceChannel: boolean;
}
const channelStates = new Map<string, VoiceChannelState>();
const ownerToChannel = new Map<string, string>();
const guildInterfaces = new Map<string, string>();
const joinOrder = new Map<string, string[]>();
const tempPermittedUsers = new Map<string, Set<string>>();
const creationLocks = new Map<string, Promise<void>>();
const userCooldowns = new Map<string, number>();
const COOLDOWNS = {
    CREATE_CHANNEL: 5000,
    JOIN_PROTECTED: 2000,
};
export function isOnCooldown(userId: string, action: keyof typeof COOLDOWNS): boolean {
    const key = `${userId}:${action}`;
    const lastAction = userCooldowns.get(key);
    if (!lastAction) return false;
    const cooldownTime = COOLDOWNS[action];
    return Date.now() - lastAction < cooldownTime;
}
export function setCooldown(userId: string, action: keyof typeof COOLDOWNS): void {
    const key = `${userId}:${action}`;
    userCooldowns.set(key, Date.now());
}
export async function acquireCreationLock(guildId: string, userId: string): Promise<boolean> {
    const key = `${guildId}:${userId}`;
    if (creationLocks.has(key)) {
        return false;
    }
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });
    creationLocks.set(key, lockPromise);
    setTimeout(() => {
        releaseCreationLock(guildId, userId);
    }, 10000);
    return true;
}
export function releaseCreationLock(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    const lockPromise = creationLocks.get(key);
    if (lockPromise) {
        creationLocks.delete(key);
    }
}
export function cleanupCooldowns(): void {
    const now = Date.now();
    const maxCooldown = Math.max(...Object.values(COOLDOWNS));
    for (const [key, timestamp] of userCooldowns) {
        if (now - timestamp > maxCooldown) {
            userCooldowns.delete(key);
        }
    }
}
setInterval(cleanupCooldowns, 60000);
export function registerChannel(channelId: string, guildId: string, ownerId: string): void {
    const state: VoiceChannelState = {
        channelId,
        guildId,
        ownerId,
        interfaceChannel: false,
    };
    channelStates.set(channelId, state);
    ownerToChannel.set(`${guildId}:${ownerId}`, channelId);
    
    // Also register in stateStore for VCNS consistency (async, fire and forget)
    import('../vcns/index').then(({ stateStore }) => {
        if (!stateStore.getChannelState(channelId)) {
            stateStore.registerChannel({
                channelId,
                guildId,
                ownerId,
                isLocked: false,
                isHidden: false,
                userLimit: 0,
                isTeamChannel: false,
                operationPending: false,
                lastModified: Date.now(),
            });
        }
    }).catch(() => {}); // Ignore if VCNS not ready yet
}
export function unregisterChannel(channelId: string): void {
    const state = channelStates.get(channelId);
    if (state) {
        ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
        channelStates.delete(channelId);
    }
    joinOrder.delete(channelId);
    tempPermittedUsers.delete(channelId);
    
    // Also unregister from stateStore
    import('../vcns/index').then(({ stateStore }) => {
        stateStore.unregisterChannel(channelId);
    }).catch(() => {});
}
export function getChannelState(channelId: string): VoiceChannelState | undefined {
    return channelStates.get(channelId);
}
export function getChannelByOwner(guildId: string, ownerId: string): string | undefined {
    return ownerToChannel.get(`${guildId}:${ownerId}`);
}
export function isChannelOwner(channelId: string, userId: string): boolean {
    const state = channelStates.get(channelId);
    return state?.ownerId === userId;
}
export function transferOwnership(channelId: string, newOwnerId: string): boolean {
    const state = channelStates.get(channelId);
    if (!state) return false;
    ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
    state.ownerId = newOwnerId;
    ownerToChannel.set(`${state.guildId}:${newOwnerId}`, channelId);
    return true;
}
export function registerInterfaceChannel(guildId: string, channelId: string): void {
    guildInterfaces.set(guildId, channelId);
}
export function isInterfaceChannel(channelId: string): boolean {
    for (const interfaceId of guildInterfaces.values()) {
        if (interfaceId === channelId) return true;
    }
    return false;
}
export function getInterfaceChannel(guildId: string): string | undefined {
    return guildInterfaces.get(guildId);
}
export function getGuildChannels(guildId: string): VoiceChannelState[] {
    return Array.from(channelStates.values()).filter(s => s.guildId === guildId);
}
export function clearAllState(): void {
    channelStates.clear();
    ownerToChannel.clear();
    guildInterfaces.clear();
}
export function unregisterInterfaceChannel(guildId: string): void {
    guildInterfaces.delete(guildId);
}
export function addUserToJoinOrder(channelId: string, userId: string): void {
    const order = joinOrder.get(channelId) || [];
    if (!order.includes(userId)) {
        order.push(userId);
        joinOrder.set(channelId, order);
    }
}
export function removeUserFromJoinOrder(channelId: string, userId: string): void {
    const order = joinOrder.get(channelId);
    if (order) {
        const filtered = order.filter(id => id !== userId);
        if (filtered.length > 0) {
            joinOrder.set(channelId, filtered);
        } else {
            joinOrder.delete(channelId);
        }
    }
}
export function getNextUserInOrder(channelId: string): string | undefined {
    const order = joinOrder.get(channelId);
    return order && order.length > 0 ? order[0] : undefined;
}
export function getJoinOrder(channelId: string): string[] {
    return joinOrder.get(channelId) || [];
}
export function addTempPermittedUsers(channelId: string, userIds: string[]): void {
    const existing = tempPermittedUsers.get(channelId) || new Set();
    for (const userId of userIds) {
        existing.add(userId);
    }
    tempPermittedUsers.set(channelId, existing);
}
export function hasTempPermission(channelId: string, userId: string): boolean {
    const users = tempPermittedUsers.get(channelId);
    return users?.has(userId) || false;
}
export function clearTempPermissions(channelId: string): void {
    tempPermittedUsers.delete(channelId);
}
export function clearGuildState(guildId: string): void {
    for (const [channelId, state] of channelStates) {
        if (state.guildId === guildId) {
            channelStates.delete(channelId);
            joinOrder.delete(channelId);
            tempPermittedUsers.delete(channelId);
        }
    }
    for (const key of ownerToChannel.keys()) {
        if (key.startsWith(guildId + ':')) {
            ownerToChannel.delete(key);
        }
    }
    guildInterfaces.delete(guildId);
    for (const key of teamInterfaces.keys()) {
        if (key.startsWith(guildId + ':')) {
            teamInterfaces.delete(key);
        }
    }
    for (const [channelId, state] of teamChannelStates) {
        if (state.guildId === guildId) {
            teamChannelStates.delete(channelId);
        }
    }
    for (const key of teamOwnerToChannel.keys()) {
        if (key.startsWith(guildId + ':')) {
            teamOwnerToChannel.delete(key);
        }
    }
}
export type TeamType = 'duo' | 'trio' | 'squad';
export const TEAM_USER_LIMITS: Record<TeamType, number> = {
    duo: 2,
    trio: 3,
    squad: 4,
};
interface TeamChannelState {
    channelId: string;
    guildId: string;
    ownerId: string;
    teamType: TeamType;
}
const teamInterfaces = new Map<string, string>();
const teamChannelStates = new Map<string, TeamChannelState>();
const teamOwnerToChannel = new Map<string, string>();
export function registerTeamInterfaceChannel(guildId: string, type: TeamType, channelId: string): void {
    teamInterfaces.set(`${guildId}:${type}`, channelId);
}
export function unregisterTeamInterfaceChannel(guildId: string, type: TeamType): void {
    teamInterfaces.delete(`${guildId}:${type}`);
}
export function isTeamInterfaceChannel(channelId: string): boolean {
    for (const interfaceId of teamInterfaces.values()) {
        if (interfaceId === channelId) return true;
    }
    return false;
}
export function getTeamInterfaceType(channelId: string): TeamType | undefined {
    for (const [key, interfaceId] of teamInterfaces) {
        if (interfaceId === channelId) {
            return key.split(':')[1] as TeamType;
        }
    }
    return undefined;
}
export function registerTeamChannel(channelId: string, guildId: string, ownerId: string, teamType: TeamType): void {
    const state: TeamChannelState = {
        channelId,
        guildId,
        ownerId,
        teamType,
    };
    teamChannelStates.set(channelId, state);
    teamOwnerToChannel.set(`${guildId}:${ownerId}`, channelId);
    
    // Also register in stateStore for VCNS consistency
    import('../vcns/index').then(({ stateStore }) => {
        if (!stateStore.getChannelState(channelId)) {
            stateStore.registerChannel({
                channelId,
                guildId,
                ownerId,
                isLocked: false,
                isHidden: false,
                userLimit: 0,
                isTeamChannel: true,
                teamType: teamType.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD',
                operationPending: false,
                lastModified: Date.now(),
            });
        }
    }).catch(() => {});
}
export function unregisterTeamChannel(channelId: string): void {
    const state = teamChannelStates.get(channelId);
    if (state) {
        teamOwnerToChannel.delete(`${state.guildId}:${state.ownerId}`);
        teamChannelStates.delete(channelId);
    }
    joinOrder.delete(channelId);
    tempPermittedUsers.delete(channelId);
    
    // Also unregister from stateStore
    import('../vcns/index').then(({ stateStore }) => {
        stateStore.unregisterChannel(channelId);
    }).catch(() => {});
}
export function getTeamChannelState(channelId: string): TeamChannelState | undefined {
    return teamChannelStates.get(channelId);
}
export function getTeamChannelByOwner(guildId: string, ownerId: string): string | undefined {
    return teamOwnerToChannel.get(`${guildId}:${ownerId}`);
}
export function isTeamChannelOwner(channelId: string, userId: string): boolean {
    const state = teamChannelStates.get(channelId);
    return state?.ownerId === userId;
}
export function transferTeamOwnership(channelId: string, newOwnerId: string): boolean {
    const state = teamChannelStates.get(channelId);
    if (!state) return false;
    teamOwnerToChannel.delete(`${state.guildId}:${state.ownerId}`);
    state.ownerId = newOwnerId;
    teamOwnerToChannel.set(`${state.guildId}:${newOwnerId}`, channelId);
    return true;
}
export function getGuildTeamChannels(guildId: string): TeamChannelState[] {
    return Array.from(teamChannelStates.values()).filter(s => s.guildId === guildId);
}
export async function loadAllTeamInterfaces(): Promise<void> {
    try {
        const { default: prisma } = await import('./database');
        const allTeamSettings = await prisma.teamVoiceSettings.findMany();
        for (const settings of allTeamSettings) {
            if (settings.duoVcId) registerTeamInterfaceChannel(settings.guildId, 'duo', settings.duoVcId);
            if (settings.trioVcId) registerTeamInterfaceChannel(settings.guildId, 'trio', settings.trioVcId);
            if (settings.squadVcId) registerTeamInterfaceChannel(settings.guildId, 'squad', settings.squadVcId);
        }
        console.log(`[VoiceManager] Loaded ${allTeamSettings.length} team interface configurations`);
    } catch (error) {
        console.error('[VoiceManager] Failed to load team interfaces:', error);
    }
}

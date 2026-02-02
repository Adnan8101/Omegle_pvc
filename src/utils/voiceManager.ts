import type { VoiceChannel } from 'discord.js';
interface VoiceChannelState {
    channelId: string;
    guildId: string;
    ownerId: string;
    interfaceChannel: boolean;
    isLocked?: boolean;
    isHidden?: boolean;
}
const channelStates = new Map<string, VoiceChannelState>();
const ownerToChannel = new Map<string, string>();
const guildInterfaces = new Map<string, string>();
const joinOrder = new Map<string, string[]>();
const tempPermittedUsers = new Map<string, Set<string>>();
const creationLocks = new Map<string, Promise<void>>();
const userCooldowns = new Map<string, number>();
const tempLockPermits = new Map<string, Set<string>>(); 
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
export function registerChannel(channelId: string, guildId: string, ownerId: string, skipIfExists: boolean = false): void {
    const existingState = channelStates.get(channelId);
    if (existingState) {
        if (skipIfExists) {
            console.log(`[VoiceManager] Channel ${channelId} already registered, skipping`);
            return;
        }
        if (existingState.ownerId !== ownerId) {
            console.log(`[VoiceManager] Updating owner for ${channelId}: ${existingState.ownerId} -> ${ownerId}`);
            ownerToChannel.delete(`${existingState.guildId}:${existingState.ownerId}`);
            existingState.ownerId = ownerId;
            ownerToChannel.set(`${guildId}:${ownerId}`, channelId);
        }
        return;
    }
    const state: VoiceChannelState = {
        channelId,
        guildId,
        ownerId,
        interfaceChannel: false,
    };
    channelStates.set(channelId, state);
    ownerToChannel.set(`${guildId}:${ownerId}`, channelId);
    console.log(`[VoiceManager] ✅ Registered channel ${channelId} with owner ${ownerId}`);
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
            console.log(`[VoiceManager] ✅ Registered channel ${channelId} in stateStore`);
        }
    }).catch(() => {}); 
}
export function unregisterChannel(channelId: string): void {
    const state = channelStates.get(channelId);
    if (state) {
        ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
        channelStates.delete(channelId);
    }
    joinOrder.delete(channelId);
    tempPermittedUsers.delete(channelId);
    tempLockPermits.delete(channelId); 
    import('../vcns/index').then(({ stateStore }) => {
        stateStore.unregisterChannel(channelId);
        console.log(`[VoiceManager] ✅ Unregistered channel ${channelId} from voiceManager and stateStore`);
    }).catch((err) => {
        console.error(`[VoiceManager] ⚠️ Failed to unregister from stateStore:`, err);
    });
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
export function registerTeamChannel(channelId: string, guildId: string, ownerId: string, teamType: TeamType, skipIfExists: boolean = false): void {
    const existingState = teamChannelStates.get(channelId);
    if (existingState) {
        if (skipIfExists) {
            console.log(`[VoiceManager] Team channel ${channelId} already registered, skipping`);
            return;
        }
        if (existingState.ownerId !== ownerId) {
            console.log(`[VoiceManager] Updating team owner for ${channelId}: ${existingState.ownerId} -> ${ownerId}`);
            teamOwnerToChannel.delete(`${existingState.guildId}:${existingState.ownerId}`);
            existingState.ownerId = ownerId;
            teamOwnerToChannel.set(`${guildId}:${ownerId}`, channelId);
        }
        return;
    }
    const state: TeamChannelState = {
        channelId,
        guildId,
        ownerId,
        teamType,
    };
    teamChannelStates.set(channelId, state);
    teamOwnerToChannel.set(`${guildId}:${ownerId}`, channelId);
    console.log(`[VoiceManager] ✅ Registered team channel ${channelId} with owner ${ownerId}`);
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
    tempLockPermits.delete(channelId); 
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
export function addTempLockPermit(channelId: string, userId: string): void {
    const existing = tempLockPermits.get(channelId) || new Set();
    existing.add(userId);
    tempLockPermits.set(channelId, existing);
    console.log(`[VoiceManager] Added temp lock permit for user ${userId} in channel ${channelId}`);
}
export function hasTempLockPermit(channelId: string, userId: string): boolean {
    const users = tempLockPermits.get(channelId);
    return users?.has(userId) || false;
}
export function removeTempLockPermit(channelId: string, userId: string): void {
    const users = tempLockPermits.get(channelId);
    if (users) {
        users.delete(userId);
        if (users.size === 0) {
            tempLockPermits.delete(channelId);
        }
        console.log(`[VoiceManager] Removed temp lock permit for user ${userId} in channel ${channelId}`);
    }
}
export function clearTempLockPermits(channelId: string): void {
    tempLockPermits.delete(channelId);
    console.log(`[VoiceManager] Cleared all temp lock permits for channel ${channelId}`);
}
export function getTempLockPermits(channelId: string): string[] {
    const users = tempLockPermits.get(channelId);
    return users ? Array.from(users) : [];
}
export function clearAllChannels(): void {
    channelStates.clear();
    ownerToChannel.clear();
    joinOrder.clear();
    tempPermittedUsers.clear();
    tempLockPermits.clear();
    console.log(`[VoiceManager] ✅ Cleared all channel states`);
}
export function clearGuildState(guildId: string): void {
    console.log(`[VoiceManager] Clearing state for guild ${guildId}...`);
    let clearedCount = 0;
    for (const [channelId, state] of channelStates.entries()) {
        if (state.guildId === guildId) {
            unregisterChannel(channelId);
            clearedCount++;
        }
    }
    for (const [channelId, state] of teamChannelStates.entries()) {
        if (state.guildId === guildId) {
            teamChannelStates.delete(channelId);
            teamOwnerToChannel.delete(`${state.guildId}:${state.ownerId}`);
            import('../vcns/index').then(({ stateStore }) => {
                stateStore.unregisterChannel(channelId);
            }).catch(() => {});
            clearedCount++;
        }
    }
    guildInterfaces.delete(guildId);
    for (const key of teamInterfaces.keys()) {
        if (key.startsWith(guildId + ':')) {
            teamInterfaces.delete(key);
        }
    }
    console.log(`[VoiceManager] ✅ Cleared ${clearedCount} channels for guild ${guildId}`);
}

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
}

export function unregisterChannel(channelId: string): void {
    const state = channelStates.get(channelId);
    if (state) {
        ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
        channelStates.delete(channelId);
    }
    joinOrder.delete(channelId);
    tempPermittedUsers.delete(channelId);
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

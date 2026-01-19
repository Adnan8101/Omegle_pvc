import type { VoiceChannel } from 'discord.js';

interface VoiceChannelState {
    channelId: string;
    guildId: string;
    ownerId: string;
    interfaceChannel: boolean;
    textChannelId?: string;
}

// In-memory cache for fast O(1) lookups
const channelStates = new Map<string, VoiceChannelState>();
const ownerToChannel = new Map<string, string>(); // ownerId -> channelId
const guildInterfaces = new Map<string, string>(); // guildId -> interfaceChannelId
const inactivityTimers = new Map<string, NodeJS.Timeout>(); // channelId -> timeout
const joinOrder = new Map<string, string[]>(); // channelId -> array of userIds in join order
const textChannels = new Map<string, string>(); // voiceChannelId -> textChannelId

/**
 * Register a private voice channel
 */
export function registerChannel(channelId: string, guildId: string, ownerId: string, textChannelId?: string): void {
    const state: VoiceChannelState = {
        channelId,
        guildId,
        ownerId,
        interfaceChannel: false,
        textChannelId,
    };
    channelStates.set(channelId, state);
    ownerToChannel.set(`${guildId}:${ownerId}`, channelId);
    if (textChannelId) {
        textChannels.set(channelId, textChannelId);
    }
}

/**
 * Unregister a private voice channel
 */
export function unregisterChannel(channelId: string): void {
    const state = channelStates.get(channelId);
    if (state) {
        ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
        channelStates.delete(channelId);
    }
    clearInactivityTimer(channelId);
    joinOrder.delete(channelId);
    textChannels.delete(channelId);
}

/**
 * Get channel state by ID
 */
export function getChannelState(channelId: string): VoiceChannelState | undefined {
    return channelStates.get(channelId);
}

/**
 * Get channel owned by a user in a guild
 */
export function getChannelByOwner(guildId: string, ownerId: string): string | undefined {
    return ownerToChannel.get(`${guildId}:${ownerId}`);
}

/**
 * Check if a user owns a channel
 */
export function isChannelOwner(channelId: string, userId: string): boolean {
    const state = channelStates.get(channelId);
    return state?.ownerId === userId;
}

/**
 * Transfer channel ownership
 */
export function transferOwnership(channelId: string, newOwnerId: string): boolean {
    const state = channelStates.get(channelId);
    if (!state) return false;

    // Remove old owner mapping
    ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);

    // Update state
    state.ownerId = newOwnerId;

    // Add new owner mapping
    ownerToChannel.set(`${state.guildId}:${newOwnerId}`, channelId);

    return true;
}

/**
 * Register an interface channel for a guild
 */
export function registerInterfaceChannel(guildId: string, channelId: string): void {
    guildInterfaces.set(guildId, channelId);
}

/**
 * Check if a channel is an interface channel
 */
export function isInterfaceChannel(channelId: string): boolean {
    for (const interfaceId of guildInterfaces.values()) {
        if (interfaceId === channelId) return true;
    }
    return false;
}

/**
 * Get interface channel for a guild
 */
export function getInterfaceChannel(guildId: string): string | undefined {
    return guildInterfaces.get(guildId);
}

/**
 * Get all channels in a guild
 */
export function getGuildChannels(guildId: string): VoiceChannelState[] {
    return Array.from(channelStates.values()).filter(s => s.guildId === guildId);
}

/**
 * Clear all state (useful for testing)
 */
export function clearAllState(): void {
    channelStates.clear();
    ownerToChannel.clear();
    guildInterfaces.clear();
}

/**
 * Unregister an interface channel for a guild
 */
export function unregisterInterfaceChannel(guildId: string): void {
    guildInterfaces.delete(guildId);
}

/**
 * Set inactivity timer for a channel
 */
export function setInactivityTimer(channelId: string, callback: () => void, delay: number): void {
    clearInactivityTimer(channelId);
    const timer = setTimeout(callback, delay);
    inactivityTimers.set(channelId, timer);
}

/**
 * Clear inactivity timer for a channel
 */
export function clearInactivityTimer(channelId: string): void {
    const timer = inactivityTimers.get(channelId);
    if (timer) {
        clearTimeout(timer);
        inactivityTimers.delete(channelId);
    }
}

/**
 * Check if channel has an active inactivity timer
 */
export function hasInactivityTimer(channelId: string): boolean {
    return inactivityTimers.has(channelId);
}

/**
 * Add user to join order
 */
export function addUserToJoinOrder(channelId: string, userId: string): void {
    const order = joinOrder.get(channelId) || [];
    if (!order.includes(userId)) {
        order.push(userId);
        joinOrder.set(channelId, order);
    }
}

/**
 * Remove user from join order
 */
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

/**
 * Get next user in join order (for ownership transfer)
 */
export function getNextUserInOrder(channelId: string): string | undefined {
    const order = joinOrder.get(channelId);
    return order && order.length > 0 ? order[0] : undefined;
}

/**
 * Get join order for a channel
 */
export function getJoinOrder(channelId: string): string[] {
    return joinOrder.get(channelId) || [];
}

/**
 * Get text channel ID for a voice channel
 */
export function getTextChannelId(voiceChannelId: string): string | undefined {
    return textChannels.get(voiceChannelId);
}

/**
 * Set text channel ID for a voice channel
 */
export function setTextChannelId(voiceChannelId: string, textChannelId: string): void {
    textChannels.set(voiceChannelId, textChannelId);
    const state = channelStates.get(voiceChannelId);
    if (state) {
        state.textChannelId = textChannelId;
    }
}

import { EventEmitter } from 'events';
import {
    SystemState,
    GuildState,
    ChannelState,
    VCNS_CONFIG,
} from './types';
import { lockManager } from './lockManager';
export interface StateStoreEvents {
    systemStateChanged: (state: SystemState) => void;
    guildStateChanged: (guildId: string, state: GuildState) => void;
    channelStateChanged: (channelId: string, state: ChannelState) => void;
    channelCreated: (channelId: string, state: ChannelState) => void;
    channelDeleted: (channelId: string) => void;
    defenseModeActivated: (guildId: string) => void;
    defenseModeDeactivated: (guildId: string) => void;
    raidModeActivated: (guildId: string) => void;
    raidModeDeactivated: (guildId: string) => void;
}
export class StateStore extends EventEmitter {
    private systemState: SystemState;
    private guildStates: Map<string, GuildState> = new Map();
    private channelStates: Map<string, ChannelState> = new Map();
    private ownerToChannel: Map<string, string> = new Map(); 
    private cleanupInterval: NodeJS.Timeout | null = null;
    private globalBlocks: Map<string, { reason?: string; blockedAt: number }> = new Map(); 
    private permanentAccess: Map<string, Set<string>> = new Map(); 
    constructor() {
        super();
        this.systemState = this.createDefaultSystemState();
        this.startCleanupLoop();
    }
    public getSystemState(): Readonly<SystemState> {
        return { ...this.systemState };
    }
    public updateSystemState(updates: Partial<SystemState>): void {
        this.systemState = {
            ...this.systemState,
            ...updates,
        };
        this.emit('systemStateChanged', this.systemState);
    }
    public setRatePressure(pressure: number): void {
        const clamped = Math.max(0, Math.min(100, pressure));
        if (this.systemState.ratePressure !== clamped) {
            this.systemState.ratePressure = clamped;
            if (clamped >= VCNS_CONFIG.RATE_CRITICAL_THRESHOLD && !this.systemState.defenseMode) {
                this.activateDefenseMode();
            }
            this.emit('systemStateChanged', this.systemState);
        }
    }
    public activateDefenseMode(): void {
        if (!this.systemState.defenseMode) {
            this.systemState.defenseMode = true;
            this.emit('systemStateChanged', this.systemState);
        }
    }
    public deactivateDefenseMode(): void {
        if (this.systemState.defenseMode) {
            this.systemState.defenseMode = false;
            this.emit('systemStateChanged', this.systemState);
        }
    }
    public setQueueDepth(depth: number): void {
        this.systemState.queueDepth = depth;
    }
    public setActiveWorkers(count: number): void {
        this.systemState.activeWorkers = count;
    }
    public setCircuitBreaker(open: boolean): void {
        this.systemState.circuitBreakerOpen = open;
        this.emit('systemStateChanged', this.systemState);
    }
    public isSystemHealthy(): boolean {
        return (
            !this.systemState.circuitBreakerOpen &&
            this.systemState.ratePressure < VCNS_CONFIG.RATE_CRITICAL_THRESHOLD
        );
    }
    public getGuildState(guildId: string): Readonly<GuildState> {
        let state = this.guildStates.get(guildId);
        if (!state) {
            state = this.createDefaultGuildState(guildId);
            this.guildStates.set(guildId, state);
        }
        return { ...state };
    }
    public updateGuildState(guildId: string, updates: Partial<GuildState>): void {
        const current = this.getGuildState(guildId);
        const newState: GuildState = {
            ...current,
            ...updates,
            guildId, 
            lastActivity: Date.now(),
        };
        this.guildStates.set(guildId, newState);
        this.emit('guildStateChanged', guildId, newState);
    }
    public pauseGuild(guildId: string): void {
        this.updateGuildState(guildId, { pvcPaused: true });
    }
    public resumeGuild(guildId: string): void {
        this.updateGuildState(guildId, { pvcPaused: false });
    }
    public isGuildPaused(guildId: string): boolean {
        return this.getGuildState(guildId).pvcPaused;
    }
    public activateRaidMode(guildId: string): void {
        const state = this.guildStates.get(guildId);
        if (state && !state.raidMode) {
            state.raidMode = true;
            this.emit('raidModeActivated', guildId);
            this.emit('guildStateChanged', guildId, state);
        }
    }
    public deactivateRaidMode(guildId: string): void {
        const state = this.guildStates.get(guildId);
        if (state && state.raidMode) {
            state.raidMode = false;
            this.emit('raidModeDeactivated', guildId);
            this.emit('guildStateChanged', guildId, state);
        }
    }
    public recordEventPressure(guildId: string, pressure: number): void {
        const state = this.guildStates.get(guildId);
        if (state) {
            state.eventPressure = pressure;
            if (pressure >= VCNS_CONFIG.DEFENSE_MODE_TRIGGER_EVENTS_PER_SEC && !state.raidMode) {
                this.activateRaidMode(guildId);
            }
        }
    }
    public setGuildPendingIntents(guildId: string, count: number): void {
        const state = this.guildStates.get(guildId);
        if (state) {
            state.pendingIntents = count;
        }
    }
    public getChannelState(channelId: string): Readonly<ChannelState> | null {
        const state = this.channelStates.get(channelId);
        return state ? { ...state } : null;
    }
    public registerChannel(state: ChannelState): void {
        this.channelStates.set(state.channelId, { ...state });
        this.ownerToChannel.set(`${state.guildId}:${state.ownerId}`, state.channelId);
        this.emit('channelCreated', state.channelId, state);
        this.emit('channelStateChanged', state.channelId, state);
    }
    public updateChannelState(channelId: string, updates: Partial<ChannelState>): void {
        const current = this.channelStates.get(channelId);
        if (!current) {
            return;
        }
        if (updates.ownerId && updates.ownerId !== current.ownerId) {
            this.ownerToChannel.delete(`${current.guildId}:${current.ownerId}`);
            this.ownerToChannel.set(`${current.guildId}:${updates.ownerId}`, channelId);
        }
        const newState: ChannelState = {
            ...current,
            ...updates,
            channelId, 
            lastModified: Date.now(),
        };
        this.channelStates.set(channelId, newState);
        this.emit('channelStateChanged', channelId, newState);
    }
    public transferOwnership(
        channelId: string,
        newOwnerId: string,
    ): { success: boolean; error?: string; previousOwnerId?: string } {
        const current = this.channelStates.get(channelId);
        if (!current) {
            return { success: false, error: 'Channel not found in state' };
        }
        if (current.ownerId === newOwnerId) {
            return { success: true, previousOwnerId: newOwnerId };
        }
        const existingChannel = this.ownerToChannel.get(`${current.guildId}:${newOwnerId}`);
        if (existingChannel && existingChannel !== channelId) {
            return { success: false, error: 'New owner already owns another channel' };
        }
        const previousOwnerId = current.ownerId;
        this.ownerToChannel.delete(`${current.guildId}:${previousOwnerId}`);
        this.ownerToChannel.set(`${current.guildId}:${newOwnerId}`, channelId);
        const newState: ChannelState = {
            ...current,
            ownerId: newOwnerId,
            lastModified: Date.now(),
        };
        this.channelStates.set(channelId, newState);
        this.emit('channelStateChanged', channelId, newState);
        return { success: true, previousOwnerId };
    }
    public unregisterChannel(channelId: string): void {
        const state = this.channelStates.get(channelId);
        if (state) {
            this.ownerToChannel.delete(`${state.guildId}:${state.ownerId}`);
            this.channelStates.delete(channelId);
            this.emit('channelDeleted', channelId);
        }
    }
    public getChannelByOwner(guildId: string, ownerId: string): string | null {
        return this.ownerToChannel.get(`${guildId}:${ownerId}`) || null;
    }
    public isChannelOwner(guildId: string, userId: string): boolean {
        return this.ownerToChannel.has(`${guildId}:${userId}`);
    }
    public getGuildChannels(guildId: string): ChannelState[] {
        const channels: ChannelState[] = [];
        for (const state of this.channelStates.values()) {
            if (state.guildId === guildId) {
                channels.push({ ...state });
            }
        }
        return channels;
    }
    public getAllChannelIds(): string[] {
        return Array.from(this.channelStates.keys());
    }
    public tryLock(resourceId: string, durationMs: number = 10000): boolean {
        return lockManager.acquire(resourceId, 'stateStore:legacy', durationMs, 'legacy-tryLock');
    }
    public releaseLock(resourceId: string): void {
        lockManager.release(resourceId, 'stateStore:legacy');
    }
    public isLocked(resourceId: string): boolean {
        return lockManager.isLocked(resourceId);
    }
    public setChannelOperationPending(channelId: string, pending: boolean): void {
        this.updateChannelState(channelId, { operationPending: pending });
    }
    public addGlobalBlock(guildId: string, userId: string, reason?: string): void {
        this.globalBlocks.set(`${guildId}:${userId}`, {
            reason,
            blockedAt: Date.now(),
        });
    }
    public removeGlobalBlock(guildId: string, userId: string): void {
        this.globalBlocks.delete(`${guildId}:${userId}`);
    }
    public isGloballyBlocked(guildId: string, userId: string): { reason?: string; blockedAt: number } | null {
        return this.globalBlocks.get(`${guildId}:${userId}`) || null;
    }
    public loadGlobalBlocks(blocks: Array<{ guildId: string; userId: string; reason?: string | null }>): void {
        for (const block of blocks) {
            this.globalBlocks.set(`${block.guildId}:${block.userId}`, {
                reason: block.reason || undefined,
                blockedAt: Date.now(),
            });
        }
    }
    public addPermanentAccess(guildId: string, ownerId: string, targetId: string): void {
        const key = `${guildId}:${ownerId}`;
        if (!this.permanentAccess.has(key)) {
            this.permanentAccess.set(key, new Set());
        }
        this.permanentAccess.get(key)!.add(targetId);
    }
    public removePermanentAccess(guildId: string, ownerId: string, targetId: string): void {
        const key = `${guildId}:${ownerId}`;
        this.permanentAccess.get(key)?.delete(targetId);
    }
    public hasPermanentAccess(guildId: string, ownerId: string, targetId: string): boolean {
        return this.permanentAccess.get(`${guildId}:${ownerId}`)?.has(targetId) || false;
    }
    public getPermanentAccessTargets(guildId: string, ownerId: string): string[] {
        return Array.from(this.permanentAccess.get(`${guildId}:${ownerId}`) || []);
    }
    public loadPermanentAccess(grants: Array<{ guildId: string; ownerId: string; targetId: string }>): void {
        for (const grant of grants) {
            this.addPermanentAccess(grant.guildId, grant.ownerId, grant.targetId);
        }
    }
    public clearGuildState(guildId: string): void {
        for (const [channelId, state] of this.channelStates) {
            if (state.guildId === guildId) {
                this.unregisterChannel(channelId);
            }
        }
        this.guildStates.delete(guildId);
    }
    public clearAll(): void {
        this.channelStates.clear();
        this.guildStates.clear();
        this.ownerToChannel.clear();
        this.systemState = this.createDefaultSystemState();
    }
    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
    private createDefaultSystemState(): SystemState {
        return {
            ratePressure: 0,
            defenseMode: false,
            queueDepth: 0,
            activeWorkers: 0,
            lastHealthCheck: Date.now(),
            circuitBreakerOpen: false,
        };
    }
    private createDefaultGuildState(guildId: string): GuildState {
        return {
            guildId,
            pvcPaused: false,
            raidMode: false,
            eventPressure: 0,
            pendingIntents: 0,
            lastActivity: Date.now(),
        };
    }
    private startCleanupLoop(): void {
        if (this.cleanupInterval) return;
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [guildId, state] of this.guildStates) {
                if (now - state.lastActivity > 60000) {
                    state.eventPressure = 0;
                    if (state.raidMode) {
                        this.deactivateRaidMode(guildId);
                    }
                }
            }
            this.systemState.lastHealthCheck = now;
        }, VCNS_CONFIG.STATE_CLEANUP_INTERVAL_MS);
    }
    public loadChannelFromDB(
        channelId: string,
        guildId: string,
        ownerId: string,
        isLocked: boolean,
        isHidden: boolean,
        isTeamChannel: boolean,
        teamType?: 'DUO' | 'TRIO' | 'SQUAD',
        userLimit: number = 0,
    ): void {
        const state: ChannelState = {
            channelId,
            guildId,
            ownerId,
            isLocked,
            isHidden,
            userLimit,
            isTeamChannel,
            teamType,
            operationPending: false,
            lastModified: Date.now(),
        };
        this.channelStates.set(channelId, state);
        this.ownerToChannel.set(`${guildId}:${ownerId}`, channelId);
    }
    public loadGuildPauseState(guildId: string, isPaused: boolean): void {
        this.updateGuildState(guildId, { pvcPaused: isPaused });
    }
    public clearGuild(guildId: string): void {
        for (const [channelId, state] of this.channelStates.entries()) {
            if (state.guildId === guildId) {
                this.unregisterChannel(channelId);
            }
        }
        this.guildStates.delete(guildId);
        console.log(`[StateStore] ✅ Cleared all state for guild ${guildId}`);
    }
}
export const stateStore = new StateStore();

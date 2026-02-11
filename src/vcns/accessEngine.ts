import { stateStore } from './index';
import { getChannelPermissions, getWhitelist, getGuildSettings } from '../utils/cache';
export enum AccessTier {
    OWNER = 'OWNER',
    PERMANENT = 'PERMANENT', 
    WHITELIST = 'WHITELIST',
    TEMP = 'TEMP',
    NONE = 'NONE'
}
export enum AccessDecision {
    ALLOW = 'ALLOW',
    DENY = 'DENY'
}
export enum AccessReason {
    OWNER = 'OWNER',
    PERMANENT_ACCESS = 'PERMANENT_ACCESS',
    MEMORY_PERMIT = 'MEMORY_PERMIT',
    DB_PERMIT = 'DB_PERMIT',
    WHITELIST = 'WHITELIST',
    DEFAULT_ALLOW = 'DEFAULT_ALLOW',
    SYSTEM_SAFETY = 'SYSTEM_SAFETY',
    GLOBAL_BLOCK = 'GLOBAL_BLOCK',
    MEMORY_BAN = 'MEMORY_BAN',
    DB_BAN = 'DB_BAN',
    CHANNEL_FULL = 'CHANNEL_FULL',
    CHANNEL_LOCKED = 'CHANNEL_LOCKED',
    CHANNEL_HIDDEN = 'CHANNEL_HIDDEN',
    ADMIN_STRICTNESS = 'ADMIN_STRICTNESS'
}
export interface AccessContext {
    guildId: string;
    channelId: string;
    userId: string;
    userRoles: string[];
    channelOwnerId?: string;
    channelMembers?: number;
    channelLimit?: number;
    isChannelLocked?: boolean;
    isChannelHidden?: boolean;
    isBotUser?: boolean;
}
export interface AccessResult {
    decision: AccessDecision;
    reason: AccessReason;
    tier: AccessTier;
    message?: string;
    canOverride?: boolean;
}
export class AccessEngine {
    public async evaluateAccess(context: AccessContext): Promise<AccessResult> {
        const { guildId, channelId, userId, userRoles, channelOwnerId, isBotUser } = context;
        if (!guildId || !channelId || !userId) {
            return this.deny(AccessReason.SYSTEM_SAFETY, AccessTier.NONE, 
                'Missing required context for access evaluation');
        }
        if (isBotUser) {
            return this.allow(AccessReason.DEFAULT_ALLOW, AccessTier.NONE, 
                'Bot user - default allow');
        }
        if (channelOwnerId === userId) {
            return this.allow(AccessReason.OWNER, AccessTier.OWNER, 
                'Channel owner has full access');
        }
        if (stateStore.hasPermanentAccess(guildId, channelOwnerId || '', userId)) {
            return this.allow(AccessReason.PERMANENT_ACCESS, AccessTier.PERMANENT,
                'User has permanent access to this channel');
        }
        const memoryResult = this.checkMemoryState(channelId, userId);
        if (memoryResult) {
            return memoryResult;
        }
        if (stateStore.hasGlobalBlock(guildId, userId)) {
            return this.deny(AccessReason.GLOBAL_BLOCK, AccessTier.NONE,
                'User is globally blocked from voice channels');
        }
        const dbResult = await this.checkDatabasePermissions(channelId, userId, userRoles);
        if (dbResult) {
            return dbResult;
        }
        const whitelistResult = await this.checkWhitelist(guildId, userId, userRoles);
        if (whitelistResult) {
            return whitelistResult;
        }
        const strictnessResult = await this.checkAdminStrictness(context);
        if (strictnessResult) {
            return strictnessResult;
        }
        const channelStateResult = this.checkChannelState(context);
        if (channelStateResult) {
            return channelStateResult;
        }
        return this.allow(AccessReason.DEFAULT_ALLOW, AccessTier.NONE,
            'No restrictions found - default allow');
    }
    public async getUserAccessTier(context: AccessContext): Promise<AccessTier> {
        const result = await this.evaluateAccess(context);
        return result.tier;
    }
    private checkMemoryState(channelId: string, userId: string): AccessResult | null {
        if (stateStore.hasChannelPermit(channelId, userId)) {
            return this.allow(AccessReason.MEMORY_PERMIT, AccessTier.TEMP,
                'User has active memory permit');
        }
        if (stateStore.hasChannelBan(channelId, userId)) {
            return this.deny(AccessReason.MEMORY_BAN, AccessTier.NONE,
                'User has active memory ban');
        }
        return null;
    }
    private async checkDatabasePermissions(channelId: string, userId: string, userRoles: string[]): Promise<AccessResult | null> {
        try {
            const permissions = await getChannelPermissions(channelId);
            const userBan = permissions.find(p => 
                p.targetId === userId && 
                p.targetType === 'user' && 
                p.permission === 'ban'
            );
            if (userBan) {
                return this.deny(AccessReason.DB_BAN, AccessTier.NONE,
                    'User is banned from this channel');
            }
            const roleBan = permissions.find(p => 
                userRoles.includes(p.targetId) && 
                p.targetType === 'role' && 
                p.permission === 'ban'
            );
            if (roleBan) {
                return this.deny(AccessReason.DB_BAN, AccessTier.NONE,
                    'User role is banned from this channel');
            }
            const userPermit = permissions.find(p => 
                p.targetId === userId && 
                p.targetType === 'user' && 
                p.permission === 'permit'
            );
            if (userPermit) {
                return this.allow(AccessReason.DB_PERMIT, AccessTier.TEMP,
                    'User has database permit for this channel');
            }
            const rolePermit = permissions.find(p => 
                userRoles.includes(p.targetId) && 
                p.targetType === 'role' && 
                p.permission === 'permit'
            );
            if (rolePermit) {
                return this.allow(AccessReason.DB_PERMIT, AccessTier.TEMP,
                    'User role has database permit for this channel');
            }
            return null;
        } catch (error) {
            console.error('[AccessEngine] Error checking database permissions:', error);
            return null;
        }
    }
    private async checkWhitelist(guildId: string, userId: string, userRoles: string[]): Promise<AccessResult | null> {
        try {
            const whitelist = await getWhitelist(guildId);
            const isUserWhitelisted = whitelist.some(w => 
                w.targetId === userId && w.targetType === 'user'
            );
            if (isUserWhitelisted) {
                return this.allow(AccessReason.WHITELIST, AccessTier.WHITELIST,
                    'User is on the guild whitelist');
            }
            const isRoleWhitelisted = whitelist.some(w => 
                userRoles.includes(w.targetId) && w.targetType === 'role'
            );
            if (isRoleWhitelisted) {
                return this.allow(AccessReason.WHITELIST, AccessTier.WHITELIST,
                    'User role is on the guild whitelist');
            }
            return null;
        } catch (error) {
            console.error('[AccessEngine] Error checking whitelist:', error);
            return null;
        }
    }
    private async checkAdminStrictness(context: AccessContext): Promise<AccessResult | null> {
        const { guildId, isChannelLocked, isChannelHidden, channelMembers, channelLimit } = context;
        try {
            const settings = await getGuildSettings(guildId);
            if (!settings?.adminStrictness) {
                return null;
            }
            const isChannelRestricted = isChannelLocked || isChannelHidden || 
                (channelLimit && channelMembers && channelMembers >= channelLimit);
            if (isChannelRestricted) {
                return this.deny(AccessReason.ADMIN_STRICTNESS, AccessTier.NONE,
                    'Admin strictness enforced - channel has restrictions');
            }
            return null;
        } catch (error) {
            console.error('[AccessEngine] Error checking admin strictness:', error);
            return null;
        }
    }
    private checkChannelState(context: AccessContext): AccessResult | null {
        const { isChannelLocked, isChannelHidden, channelMembers, channelLimit } = context;
        if (isChannelHidden) {
            return this.deny(AccessReason.CHANNEL_HIDDEN, AccessTier.NONE,
                'Channel is hidden');
        }
        if (isChannelLocked) {
            return this.deny(AccessReason.CHANNEL_LOCKED, AccessTier.NONE,
                'Channel is locked');
        }
        if (channelLimit && channelMembers && channelMembers >= channelLimit) {
            return this.deny(AccessReason.CHANNEL_FULL, AccessTier.NONE,
                'Channel is at capacity');
        }
        return null;
    }
    private allow(reason: AccessReason, tier: AccessTier, message?: string): AccessResult {
        return {
            decision: AccessDecision.ALLOW,
            reason,
            tier,
            message,
            canOverride: false
        };
    }
    private deny(reason: AccessReason, tier: AccessTier, message?: string, canOverride: boolean = false): AccessResult {
        return {
            decision: AccessDecision.DENY,
            reason,
            tier,
            message,
            canOverride
        };
    }
}
export const accessEngine = new AccessEngine();
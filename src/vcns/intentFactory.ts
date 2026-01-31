import { randomUUID } from 'crypto';
import {
    Intent,
    IntentAction,
    IntentPriority,
    IntentStatus,
    IntentSource,
    ResourceType,
    VCNS_CONFIG,
    VCCreatePayload,
    VCDeletePayload,
    PermissionPayload,
    UserActionPayload,
    LogPayload,
} from './types';
import { vcCreateResourceId, ownerTransferLockKey } from './resourceKeys';
function generateIntentId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomUUID().split('-')[0];
    return `int_${timestamp}_${random}`;
}
function generateTraceId(): string {
    return `trace_${Date.now().toString(36)}_${randomUUID().split('-')[0]}`;
}
function getCostForAction(action: IntentAction): number {
    switch (action) {
        case IntentAction.VC_CREATE:
            return VCNS_CONFIG.COST_VC_CREATE;
        case IntentAction.VC_DELETE:
            return VCNS_CONFIG.COST_VC_DELETE;
        case IntentAction.PERM_GRANT:
        case IntentAction.PERM_REVOKE:
        case IntentAction.PERM_BAN:
        case IntentAction.PERM_UNBAN:
            return VCNS_CONFIG.COST_PERMISSION_CHANGE;
        case IntentAction.USER_KICK:
        case IntentAction.USER_DISCONNECT:
            return VCNS_CONFIG.COST_USER_KICK;
        case IntentAction.MSG_SEND:
        case IntentAction.MSG_EDIT:
        case IntentAction.MSG_DELETE:
            return VCNS_CONFIG.COST_MESSAGE_SEND;
        case IntentAction.LOG_ACTION:
        case IntentAction.LOG_ERROR:
            return VCNS_CONFIG.COST_LOG_ACTION;
        default:
            return 10; 
    }
}
function getTTLForAction(action: IntentAction): number {
    switch (action) {
        case IntentAction.VC_CREATE:
            return VCNS_CONFIG.INTENT_VC_CREATE_TTL_MS;
        default:
            return VCNS_CONFIG.INTENT_DEFAULT_TTL_MS;
    }
}
function getMaxRetriesForAction(action: IntentAction, priority: IntentPriority): number {
    if (priority === IntentPriority.CRITICAL || priority === IntentPriority.IMMEDIATE) {
        return VCNS_CONFIG.MAX_RETRIES_CRITICAL;
    }
    return VCNS_CONFIG.MAX_RETRIES_DEFAULT;
}
export class IntentFactory {
    static create<T>(
        action: IntentAction,
        guildId: string,
        resourceType: ResourceType,
        resourceId: string,
        payload: T,
        source: IntentSource,
        priority: IntentPriority = IntentPriority.NORMAL,
    ): Intent<T> {
        const now = Date.now();
        const ttl = getTTLForAction(action);
        return {
            id: generateIntentId(),
            action,
            priority,
            status: IntentStatus.PENDING,
            guildId,
            resourceType,
            resourceId,
            payload,
            source,
            cost: getCostForAction(action),
            createdAt: now,
            expiresAt: now + ttl,
            attempts: 0,
            maxAttempts: getMaxRetriesForAction(action, priority),
            meta: {
                traceId: generateTraceId(),
                feedbackSent: false,
            },
        };
    }
    static createVCCreate(
        payload: VCCreatePayload,
        source: IntentSource,
    ): Intent<VCCreatePayload> {
        return this.create(
            IntentAction.VC_CREATE,
            payload.guildId,
            ResourceType.VOICE_CHANNEL,
            vcCreateResourceId(payload.guildId, payload.ownerId),
            payload,
            source,
            IntentPriority.HIGH, 
        );
    }
    static createVCDelete(
        guildId: string,
        channelId: string,
        reason: string | undefined,
        source: IntentSource,
    ): Intent<VCDeletePayload> {
        return this.create(
            IntentAction.VC_DELETE,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, reason },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createVCLock(
        guildId: string,
        channelId: string,
        lock: boolean,
        source: IntentSource,
    ): Intent<{ channelId: string; isLocked: boolean }> {
        return this.create(
            lock ? IntentAction.VC_LOCK : IntentAction.VC_UNLOCK,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, isLocked: lock },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createVCHide(
        guildId: string,
        channelId: string,
        hide: boolean,
        source: IntentSource,
    ): Intent<{ channelId: string; isHidden: boolean }> {
        return this.create(
            hide ? IntentAction.VC_HIDE : IntentAction.VC_UNHIDE,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, isHidden: hide },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createVCRename(
        guildId: string,
        channelId: string,
        newName: string,
        source: IntentSource,
    ): Intent<{ channelId: string; name: string }> {
        return this.create(
            IntentAction.VC_RENAME,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, name: newName },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createVCSetLimit(
        guildId: string,
        channelId: string,
        userLimit: number,
        source: IntentSource,
    ): Intent<{ channelId: string; userLimit: number }> {
        return this.create(
            IntentAction.VC_SET_LIMIT,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, userLimit },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createPermissionGrant(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        source: IntentSource,
    ): Intent<PermissionPayload> {
        return this.create(
            IntentAction.PERM_GRANT,
            guildId,
            ResourceType.PERMISSION,
            `${channelId}:${targetId}`,
            { channelId, targetId, targetType, permission: 'permit' },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createPermissionBan(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        source: IntentSource,
    ): Intent<PermissionPayload> {
        return this.create(
            IntentAction.PERM_BAN,
            guildId,
            ResourceType.PERMISSION,
            `${channelId}:${targetId}`,
            { channelId, targetId, targetType, permission: 'ban' },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createPermissionRevoke(
        guildId: string,
        channelId: string,
        targetId: string,
        targetType: 'user' | 'role',
        source: IntentSource,
    ): Intent<PermissionPayload> {
        return this.create(
            IntentAction.PERM_REVOKE,
            guildId,
            ResourceType.PERMISSION,
            `${channelId}:${targetId}`,
            { channelId, targetId, targetType, permission: 'neutral' },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createUserKick(
        guildId: string,
        userId: string,
        channelId: string,
        reason: string | undefined,
        source: IntentSource,
    ): Intent<UserActionPayload> {
        return this.create(
            IntentAction.USER_KICK,
            guildId,
            ResourceType.USER,
            userId,
            { userId, channelId, reason },
            source,
            IntentPriority.CRITICAL, 
        );
    }
    static createUserMove(
        guildId: string,
        userId: string,
        fromChannelId: string,
        toChannelId: string,
        source: IntentSource,
    ): Intent<UserActionPayload> {
        return this.create(
            IntentAction.USER_MOVE,
            guildId,
            ResourceType.USER,
            userId,
            { userId, channelId: fromChannelId, targetChannelId: toChannelId },
            source,
            IntentPriority.HIGH,
        );
    }
    static createUserDisconnect(
        guildId: string,
        userId: string,
        channelId: string,
        reason: string | undefined,
        source: IntentSource,
    ): Intent<UserActionPayload> {
        return this.create(
            IntentAction.USER_DISCONNECT,
            guildId,
            ResourceType.USER,
            userId,
            { userId, channelId, reason },
            source,
            IntentPriority.HIGH,
        );
    }
    static createLogAction(
        guildId: string,
        action: string,
        channelId: string | undefined,
        userId: string | undefined,
        details: string | undefined,
        isTeamChannel: boolean,
        source: IntentSource,
    ): Intent<LogPayload> {
        const intent = this.create(
            IntentAction.LOG_ACTION,
            guildId,
            ResourceType.GUILD,
            guildId,
            { action, guildId, channelId, userId, details, isTeamChannel },
            source,
            IntentPriority.LOW,
        );
        intent.priority = IntentPriority.DROPPABLE;
        return intent;
    }
    static createEnforcement(
        guildId: string,
        channelId: string,
        source: IntentSource,
    ): Intent<{ channelId: string }> {
        return this.create(
            IntentAction.ENFORCE_STATE,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId },
            source,
            IntentPriority.HIGH, 
        );
    }
    static createOwnerTransfer(
        guildId: string,
        channelId: string,
        newOwnerId: string,
        source: IntentSource,
    ): Intent<{ channelId: string; newOwnerId: string }> {
        return this.create(
            IntentAction.OWNER_TRANSFER,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, newOwnerId },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createOwnerClaim(
        guildId: string,
        channelId: string,
        claimerId: string,
        source: IntentSource,
    ): Intent<{ channelId: string; claimerId: string }> {
        return this.create(
            IntentAction.OWNER_CLAIM,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId, claimerId },
            source,
            IntentPriority.NORMAL,
        );
    }
    static createInterfaceUpdate(
        guildId: string,
        channelId: string,
        source: IntentSource,
    ): Intent<{ channelId: string }> {
        return this.create(
            IntentAction.INTERFACE_UPDATE,
            guildId,
            ResourceType.VOICE_CHANNEL,
            channelId,
            { channelId },
            source,
            IntentPriority.LOW, 
        );
    }
    static createChild<T>(
        parent: Intent<unknown>,
        action: IntentAction,
        resourceType: ResourceType,
        resourceId: string,
        payload: T,
        priority?: IntentPriority,
    ): Intent<T> {
        const child = this.create(
            action,
            parent.guildId,
            resourceType,
            resourceId,
            payload,
            parent.source,
            priority ?? parent.priority,
        );
        child.parentId = parent.id;
        child.meta.traceId = parent.meta.traceId; 
        return child;
    }
    static userSource(userId: string, context?: string): IntentSource {
        return {
            type: 'user',
            userId,
            context,
        };
    }
    static eventSource(eventName: string, context?: string): IntentSource {
        return {
            type: 'event',
            eventName,
            context,
        };
    }
    static systemSource(context?: string): IntentSource {
        return {
            type: 'system',
            context,
        };
    }
    static enforcerSource(context?: string): IntentSource {
        return {
            type: 'enforcer',
            context,
        };
    }
}

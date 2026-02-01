export enum IntentPriority {
    IMMEDIATE = -1,
    CRITICAL = 0,
    HIGH = 1,
    NORMAL = 2,
    LOW = 3,
    DROPPABLE = 4,
}
export enum IntentAction {
    VC_CREATE = 'vc:create',
    VC_DELETE = 'vc:delete',
    VC_RENAME = 'vc:rename',
    VC_SET_LIMIT = 'vc:set_limit',
    VC_SET_BITRATE = 'vc:set_bitrate',
    VC_SET_REGION = 'vc:set_region',
    VC_LOCK = 'vc:lock',
    VC_UNLOCK = 'vc:unlock',
    VC_HIDE = 'vc:hide',
    VC_UNHIDE = 'vc:unhide',
    PERM_GRANT = 'perm:grant',
    PERM_REVOKE = 'perm:revoke',
    PERM_BAN = 'perm:ban',
    PERM_UNBAN = 'perm:unban',
    USER_KICK = 'user:kick',
    USER_MOVE = 'user:move',
    USER_DISCONNECT = 'user:disconnect',
    OWNER_TRANSFER = 'owner:transfer',
    OWNER_CLAIM = 'owner:claim',
    MSG_SEND = 'msg:send',
    MSG_EDIT = 'msg:edit',
    MSG_DELETE = 'msg:delete',
    MSG_REACT = 'msg:react',
    LOG_ACTION = 'log:action',
    LOG_ERROR = 'log:error',
    INTERFACE_UPDATE = 'interface:update',
    INTERFACE_REFRESH = 'interface:refresh',
    ENFORCE_PERMISSIONS = 'enforce:permissions',
    ENFORCE_STATE = 'enforce:state',
}
export enum IntentStatus {
    PENDING = 'pending',       
    SCHEDULED = 'scheduled',   
    EXECUTING = 'executing',   
    COMPLETED = 'completed',   
    FAILED = 'failed',         
    DROPPED = 'dropped',       
    EXPIRED = 'expired',       
    CANCELLED = 'cancelled',
    RETRY_SCHEDULED = 'retry_scheduled', 
}
export enum ResourceType {
    VOICE_CHANNEL = 'voice_channel',
    TEXT_CHANNEL = 'text_channel',
    GUILD = 'guild',
    USER = 'user',
    ROLE = 'role',
    MESSAGE = 'message',
    PERMISSION = 'permission',
}
export interface Intent<T = unknown> {
    id: string;
    action: IntentAction;
    priority: IntentPriority;
    status: IntentStatus;
    guildId: string;
    resourceType: ResourceType;
    resourceId: string;
    payload: T;
    source: IntentSource;
    cost: number;
    createdAt: number;
    expiresAt: number;
    attempts: number;
    maxAttempts: number;
    error?: string;
    parentId?: string;
    meta: IntentMeta;
    nextRetryAt?: number; 
}
export interface IntentSource {
    type: 'user' | 'system' | 'event' | 'scheduler' | 'enforcer';
    userId?: string;
    eventName?: string;
    context?: string;
}
export interface IntentMeta {
    traceId: string;
    channelName?: string;
    userDisplayName?: string;
    feedbackSent: boolean;
    estimatedWait?: number;
}
export interface VCCreatePayload {
    guildId: string;
    categoryId: string;
    ownerId: string;
    name: string;
    isTeamChannel: boolean;
    teamType?: 'DUO' | 'TRIO' | 'SQUAD';
    userLimit?: number;
    bitrate?: number;
}
export interface VCDeletePayload {
    channelId: string;
    reason?: string;
}
export interface PermissionPayload {
    channelId: string;
    targetId: string;
    targetType: 'user' | 'role';
    permission: 'permit' | 'ban' | 'neutral';
}
export interface UserActionPayload {
    userId: string;
    channelId?: string;
    targetChannelId?: string;
    reason?: string;
}
export interface LogPayload {
    action: string;
    guildId: string;
    channelId?: string;
    userId?: string;
    details?: string;
    isTeamChannel?: boolean;
}
export interface SystemState {
    ratePressure: number;
    defenseMode: boolean;
    queueDepth: number;
    activeWorkers: number;
    lastHealthCheck: number;
    circuitBreakerOpen: boolean;
}
export interface GuildState {
    guildId: string;
    pvcPaused: boolean;
    raidMode: boolean;
    eventPressure: number;
    pendingIntents: number;
    lastActivity: number;
}
export interface ChannelState {
    channelId: string;
    guildId: string;
    ownerId: string;
    isLocked: boolean;
    isHidden: boolean;
    userLimit: number;
    isTeamChannel: boolean;
    teamType?: 'DUO' | 'TRIO' | 'SQUAD';
    operationPending: boolean;
    creationLockUntil?: number;
    lastModified: number;
}
export interface Decision {
    execute: boolean;
    reason?: DecisionReason;
    delayMs?: number;
    notify: boolean;
    notificationMessage?: string;
}
export enum DecisionReason {
    APPROVED = 'approved',
    RATE_LIMITED = 'rate_limited',
    DUPLICATE = 'duplicate',
    RESOURCE_LOCKED = 'resource_locked',
    EXPIRED = 'expired',
    GUILD_PAUSED = 'guild_paused',
    DEFENSE_MODE = 'defense_mode',
    INVALID_STATE = 'invalid_state',
    PERMISSION_DENIED = 'permission_denied',
    QUEUE_FULL = 'queue_full',
}
export interface WorkerResult {
    success: boolean;
    intentId: string;
    action: IntentAction;
    executionTimeMs: number;
    error?: string;
    retryable: boolean;
    rateLimitHit: boolean;
    rateLimitRetryAfter?: number;
    data?: Record<string, unknown>;
}
export interface WorkerHealth {
    workerId: string;
    isHealthy: boolean;
    lastExecution: number;
    executionsCount: number;
    failuresCount: number;
    averageExecutionTime: number;
}
export interface NormalizedEvent {
    id: string;
    type: string;
    guildId: string;
    timestamp: number;
    data: unknown;
    pressure: number; 
}
export interface PressureSignal {
    guildId: string;
    eventType: string;
    count: number;
    windowMs: number;
    pressure: number;
}
export const VCNS_CONFIG: {
    MAX_QUEUE_SIZE: number;
    MAX_QUEUE_SIZE_PER_GUILD: number;
    INTENT_DEFAULT_TTL_MS: number;
    INTENT_VC_CREATE_TTL_MS: number;
    RATE_PRESSURE_THRESHOLD: number;
    RATE_CRITICAL_THRESHOLD: number;
    MIN_DELAY_BETWEEN_ACTIONS_MS: number;
    VC_CREATE_MIN_DELAY_MS: number;
    COST_VC_CREATE: number;
    COST_VC_DELETE: number;
    COST_PERMISSION_CHANGE: number;
    COST_USER_KICK: number;
    COST_MESSAGE_SEND: number;
    COST_LOG_ACTION: number;
    MAX_RETRIES_DEFAULT: number;
    MAX_RETRIES_CRITICAL: number;
    RETRY_BASE_DELAY_MS: number;
    RETRY_MAX_DELAY_MS: number;
    DEFENSE_MODE_TRIGGER_EVENTS_PER_SEC: number;
    DEFENSE_MODE_DURATION_MS: number;
    MAX_CONCURRENT_WORKERS: number;
    WORKER_HEALTH_CHECK_INTERVAL_MS: number;
    COMPLETED_INTENT_RETENTION_MS: number;
    STATE_CLEANUP_INTERVAL_MS: number;
    DEDUP_WINDOW_MS: number;
    LOCK_DEFAULT_DURATION_MS: number;
    VC_CREATE_LOCK_DURATION_MS: number;
    DEFAULT_BITRATE: number;
    DEFENSE_MODE_DELAY_MS: number;
    RAID_MODE_DELAY_MS: number;
} = {
    MAX_QUEUE_SIZE: 5000,
    MAX_QUEUE_SIZE_PER_GUILD: 500,
    INTENT_DEFAULT_TTL_MS: 60000,           
    INTENT_VC_CREATE_TTL_MS: 120000,        
    RATE_PRESSURE_THRESHOLD: 70,            
    RATE_CRITICAL_THRESHOLD: 90,            
    MIN_DELAY_BETWEEN_ACTIONS_MS: 100,      
    VC_CREATE_MIN_DELAY_MS: 500,            
    COST_VC_CREATE: 50,
    COST_VC_DELETE: 30,
    COST_PERMISSION_CHANGE: 10,
    COST_USER_KICK: 20,
    COST_MESSAGE_SEND: 5,
    COST_LOG_ACTION: 3,
    MAX_RETRIES_DEFAULT: 3,
    MAX_RETRIES_CRITICAL: 5,
    RETRY_BASE_DELAY_MS: 1000,
    RETRY_MAX_DELAY_MS: 30000,
    DEFENSE_MODE_TRIGGER_EVENTS_PER_SEC: 50,
    DEFENSE_MODE_DURATION_MS: 60000,
    MAX_CONCURRENT_WORKERS: 3,
    WORKER_HEALTH_CHECK_INTERVAL_MS: 10000,
    COMPLETED_INTENT_RETENTION_MS: 300000,  
    STATE_CLEANUP_INTERVAL_MS: 60000,
    DEDUP_WINDOW_MS: 5000,
    LOCK_DEFAULT_DURATION_MS: 10000,
    VC_CREATE_LOCK_DURATION_MS: 15000,
    DEFAULT_BITRATE: 64000,
    DEFENSE_MODE_DELAY_MS: 5000,
    RAID_MODE_DELAY_MS: 3000,
};

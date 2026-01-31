import {
    Intent,
    IntentAction,
    IntentPriority,
    IntentStatus,
    Decision,
    DecisionReason,
    VCNS_CONFIG,
} from './types';
import { stateStore } from './stateStore';
import { rateGovernor } from './rateGovernor';
import { intentQueue } from './intentQueue';
import { lockManager } from './lockManager';
export class DecisionEngine {
    public decide(intent: Intent<unknown>): Decision {
        if (this.isExpired(intent)) {
            return this.reject(DecisionReason.EXPIRED, 'Intent has expired');
        }
        if (intent.source.type === 'user' && intent.source.userId) {
            const block = stateStore.isGloballyBlocked(intent.guildId, intent.source.userId);
            if (block) {
                return this.reject(
                    DecisionReason.PERMISSION_DENIED,
                    `User globally blocked: ${block.reason || 'No reason provided'}`,
                    'You are blocked from using voice channel features.',
                );
            }
        }
        const systemHealth = this.checkSystemHealth(intent);
        if (!systemHealth.execute) {
            return systemHealth;
        }
        const guildCheck = this.checkGuildState(intent);
        if (!guildCheck.execute) {
            return guildCheck;
        }
        const resourceCheck = this.checkResourceState(intent);
        if (!resourceCheck.execute) {
            return resourceCheck;
        }
        const rateCheck = this.checkRateLimits(intent);
        if (!rateCheck.execute && rateCheck.reason !== DecisionReason.APPROVED) {
            return rateCheck;
        }
        return this.approve(rateCheck.delayMs || 0);
    }
    public decideBatch(intents: Intent<unknown>[]): Map<string, Decision> {
        const decisions = new Map<string, Decision>();
        for (const intent of intents) {
            decisions.set(intent.id, this.decide(intent));
        }
        return decisions;
    }
    private isExpired(intent: Intent<unknown>): boolean {
        return Date.now() > intent.expiresAt;
    }
    private checkSystemHealth(intent: Intent<unknown>): Decision {
        const systemState = stateStore.getSystemState();
        if (systemState.circuitBreakerOpen) {
            if (intent.priority > IntentPriority.IMMEDIATE) {
                return this.reject(
                    DecisionReason.RATE_LIMITED,
                    'Circuit breaker is open',
                    'The system is temporarily paused due to high load. Please wait.',
                );
            }
        }
        if (systemState.defenseMode) {
            if (intent.priority > IntentPriority.CRITICAL) {
                return this.approve(VCNS_CONFIG.DEFENSE_MODE_DELAY_MS, 'Defense mode active - delaying execution');
            }
        }
        if (systemState.queueDepth > VCNS_CONFIG.MAX_QUEUE_SIZE * 0.8) {
            if (intent.priority >= IntentPriority.LOW) {
                return this.reject(
                    DecisionReason.QUEUE_FULL,
                    'Queue is near capacity',
                    'The system is very busy. Please try again later.',
                );
            }
        }
        return this.approve();
    }
    private checkGuildState(intent: Intent<unknown>): Decision {
        const guildState = stateStore.getGuildState(intent.guildId);
        if (guildState.pvcPaused) {
            if (this.isVCOperation(intent.action)) {
                return this.reject(
                    DecisionReason.GUILD_PAUSED,
                    'PVC system is paused',
                    'Voice channel management is currently paused in this server.',
                );
            }
        }
        if (guildState.raidMode) {
            if (intent.priority > IntentPriority.CRITICAL) {
                return this.approve(VCNS_CONFIG.RAID_MODE_DELAY_MS, 'Raid mode active - slowing operations');
            }
        }
        if (guildState.eventPressure > 30) {
            const delay = Math.min(guildState.eventPressure * 100, VCNS_CONFIG.LOCK_DEFAULT_DURATION_MS);
            return this.approve(delay);
        }
        return this.approve();
    }
    private checkResourceState(intent: Intent<unknown>): Decision {
        // Check if resource is locked by someone OTHER than this intent
        const lockHolder = lockManager.getHolder(intent.resourceId);
        if (lockHolder && lockHolder !== intent.id) {
            // Resource is locked by another operation
            if (intent.priority <= IntentPriority.CRITICAL) {
                return this.approve(500, 'Resource locked - short wait');
            }
            return this.reject(
                DecisionReason.RESOURCE_LOCKED,
                'Resource is locked by another operation',
            );
        }
        // Note: If lockHolder === intent.id, the intent owns the lock (acquired by queue) - allow execution
        
        if (this.isVCOperation(intent.action)) {
            const channelState = stateStore.getChannelState(intent.resourceId);
            if (this.requiresExistingChannel(intent.action)) {
                if (!channelState) {
                    return this.reject(
                        DecisionReason.INVALID_STATE,
                        'Channel does not exist or is not managed',
                    );
                }
                if (channelState.operationPending) {
                    return this.approve(1000, 'Channel has pending operation');
                }
            }
            if (intent.action === IntentAction.VC_CREATE) {
                const payload = intent.payload as { ownerId: string };
                const existingChannel = stateStore.getChannelByOwner(intent.guildId, payload.ownerId);
                if (existingChannel) {
                    return this.reject(
                        DecisionReason.DUPLICATE,
                        'User already owns a channel',
                        'You already have an active voice channel.',
                    );
                }
            }
        }
        return this.approve();
    }
    private checkRateLimits(intent: Intent<unknown>): Decision {
        const rateCheck = rateGovernor.canProceed(intent.action, intent.priority);
        if (!rateCheck.allowed) {
            if (intent.priority <= IntentPriority.CRITICAL) {
                return this.approve(rateCheck.delayMs);
            }
            return this.reject(
                DecisionReason.RATE_LIMITED,
                rateCheck.reason || 'Rate limited',
                'The system is processing many requests. Please wait a moment.',
            );
        }
        if (rateCheck.delayMs > 0) {
            return this.approve(rateCheck.delayMs);
        }
        return this.approve();
    }
    private approve(delayMs: number = 0, message?: string): Decision {
        return {
            execute: true,
            reason: DecisionReason.APPROVED,
            delayMs,
            notify: false,
            notificationMessage: message,
        };
    }
    private reject(
        reason: DecisionReason,
        internalReason: string,
        userMessage?: string,
    ): Decision {
        return {
            execute: false,
            reason,
            notify: !!userMessage,
            notificationMessage: userMessage,
        };
    }
    private isVCOperation(action: IntentAction): boolean {
        return action.startsWith('vc:') || 
               action.startsWith('perm:') || 
               action.startsWith('owner:');
    }
    private requiresExistingChannel(action: IntentAction): boolean {
        const noChannelNeeded = [
            IntentAction.VC_CREATE,
            IntentAction.LOG_ACTION,
            IntentAction.LOG_ERROR,
        ];
        return !noChannelNeeded.includes(action);
    }
    public estimateExecutionTime(intent: Intent<unknown>): number {
        let baseTime = 100;
        switch (intent.action) {
            case IntentAction.VC_CREATE:
                baseTime = 2000; 
                break;
            case IntentAction.VC_DELETE:
                baseTime = 1000;
                break;
            case IntentAction.PERM_GRANT:
            case IntentAction.PERM_REVOKE:
            case IntentAction.PERM_BAN:
                baseTime = 500;
                break;
            case IntentAction.USER_KICK:
            case IntentAction.USER_DISCONNECT:
                baseTime = 300;
                break;
            case IntentAction.MSG_SEND:
                baseTime = 200;
                break;
            default:
                baseTime = 100;
        }
        const pressure = rateGovernor.getPressure();
        if (pressure > 50) {
            baseTime = baseTime * (1 + pressure / 100);
        }
        return baseTime;
    }
    public calculateETA(intent: Intent<unknown>): number {
        const queueWait = intentQueue.estimateWaitTime(intent.priority);
        const executionTime = this.estimateExecutionTime(intent);
        return queueWait + executionTime;
    }
    public formatETA(etaMs: number): string {
        if (etaMs < 1000) {
            return 'less than a second';
        }
        if (etaMs < 5000) {
            return 'a few seconds';
        }
        if (etaMs < 30000) {
            return `~${Math.ceil(etaMs / 1000)} seconds`;
        }
        if (etaMs < 60000) {
            return 'less than a minute';
        }
        return `~${Math.ceil(etaMs / 60000)} minutes`;
    }
}
export const decisionEngine = new DecisionEngine();

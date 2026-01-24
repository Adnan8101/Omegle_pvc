import { ChannelType, type VoiceChannel, PermissionFlagsBits, OverwriteType, EmbedBuilder } from 'discord.js';
import { client } from '../client';
import prisma from '../utils/database';
import { Priority, executeWithRateLimit } from '../utils/rateLimit';
import { recordBotEdit } from '../events/channelUpdate';
import { getWhitelist, getGuildSettings } from '../utils/cache';

/**
 * ENFORCER SERVICE - THE SHERIFF
 * 
 * This service is the SINGLE SOURCE OF TRUTH enforcement mechanism.
 * 
 * RULES:
 * 1. Database is ALWAYS the authority - Discord state is just a "renderer"
 * 2. NO ONE can edit channels except:
 *    - The bot itself
 *    - Strictness-whitelisted admins (if admin strictness is ON)
 * 3. PVC owners can ONLY edit via bot interactions (buttons/commands)
 * 4. All external changes are INSTANTLY reverted
 * 5. Unauthorized users who join locked channels are IMMEDIATELY kicked
 */
class EnforcerService {
    // No debounce - we react IMMEDIATELY
    private pendingEnforcements = new Set<string>();
    
    // Track channels we're currently enforcing to prevent loops
    private enforcingChannels = new Set<string>();

    // Track recently enforced channels to prevent notification spam
    // Key: channelId, Value: timestamp of last enforcement
    private recentlyEnforced = new Map<string, number>();
    private ENFORCEMENT_COOLDOWN = 60000; // 60 seconds cooldown for notifications (prevent self-punishment)

    // Rate limit retry queue - channels that need enforcement after rate limit clears
    private retryQueue = new Map<string, { notify: boolean; retryAt: number }>();
    private retryTimerActive = false;

    /**
     * IMMEDIATE enforcement - no delays, no debounce
     * Called when ANY external change is detected
     * @param channelId - The channel to enforce
     * @param notify - Whether to send notifications (default: true for external changes)
     */
    public async enforce(channelId: string, notify: boolean = true): Promise<void> {
        // Prevent duplicate enforcement calls for the same channel
        if (this.pendingEnforcements.has(channelId) || this.enforcingChannels.has(channelId)) {
            return;
        }

        // Check if we recently enforced this channel (prevent notification spam)
        const lastEnforced = this.recentlyEnforced.get(channelId);
        if (lastEnforced && Date.now() - lastEnforced < this.ENFORCEMENT_COOLDOWN) {
            // Still enforce but don't notify (to revert any changes)
            notify = false;
        }

        this.pendingEnforcements.add(channelId);
        
        try {
            await this.executeEnforcement(channelId, notify);
            // Record successful enforcement
            this.recentlyEnforced.set(channelId, Date.now());
        } catch (error: any) {
            // Check if rate limited
            if (error?.status === 429 || error?.code === 429) {
                const retryAfter = (error.retry_after || 5) * 1000;
                console.log(`[Enforcer] Rate limited on ${channelId}. Queuing retry in ${retryAfter}ms`);
                this.queueRetry(channelId, notify, retryAfter);
            } else {
                throw error;
            }
        } finally {
            this.pendingEnforcements.delete(channelId);
        }
    }

    /**
     * Queue a channel for retry after rate limit expires
     */
    private queueRetry(channelId: string, notify: boolean, delayMs: number): void {
        const retryAt = Date.now() + delayMs;
        
        // Only queue if not already queued or if new retry is sooner
        const existing = this.retryQueue.get(channelId);
        if (!existing || retryAt < existing.retryAt) {
            this.retryQueue.set(channelId, { notify: false, retryAt }); // Never notify on retries
        }

        // Start retry timer if not already running
        if (!this.retryTimerActive) {
            this.startRetryTimer();
        }
    }

    /**
     * Process the retry queue
     */
    private startRetryTimer(): void {
        if (this.retryTimerActive) return;
        this.retryTimerActive = true;

        const processQueue = async () => {
            const now = Date.now();
            const toRetry: string[] = [];

            // Find channels ready for retry
            for (const [channelId, data] of this.retryQueue.entries()) {
                if (now >= data.retryAt) {
                    toRetry.push(channelId);
                }
            }

            // Process retries
            for (const channelId of toRetry) {
                this.retryQueue.delete(channelId);
                console.log(`[Enforcer] Retrying enforcement for ${channelId}`);
                // Use enforceQuietly for retries (no notifications)
                this.enforceQuietly(channelId).catch(err => {
                    console.error(`[Enforcer] Retry failed for ${channelId}:`, err);
                });
            }

            // Continue timer if queue not empty
            if (this.retryQueue.size > 0) {
                setTimeout(processQueue, 1000); // Check every second
            } else {
                this.retryTimerActive = false;
            }
        };

        setTimeout(processQueue, 1000);
    }

    /**
     * Check if a channel was recently enforced
     */
    public wasRecentlyEnforced(channelId: string): boolean {
        const lastEnforced = this.recentlyEnforced.get(channelId);
        if (!lastEnforced) return false;
        return Date.now() - lastEnforced < this.ENFORCEMENT_COOLDOWN;
    }

    /**
     * Silent enforcement - used by VoiceStateService when owner makes changes via bot
     * Does NOT send "unauthorized change" notifications
     */
    public async enforceQuietly(channelId: string): Promise<void> {
        return this.enforce(channelId, false);
    }

    /**
     * Check if a user is authorized to edit a managed channel
     * ONLY returns true for:
     * - Bot itself
     * - Strictness-whitelisted admins (when strictness is ON)
     */
    public async isAuthorizedEditor(guildId: string, userId: string): Promise<boolean> {
        // Bot itself is always authorized
        if (userId === client.user?.id) {
            return true;
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return false;

        // Get settings and whitelist
        const [settings, whitelist] = await Promise.all([
            getGuildSettings(guildId),
            getWhitelist(guildId),
        ]);

        // If strictness is OFF, no one except bot is authorized to edit via Discord UI
        // Channel owners must use bot interactions
        if (!settings?.adminStrictness) {
            return false;
        }

        // If strictness is ON, only whitelisted admins can edit via Discord UI
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;

        const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');
        if (!hasAdminPerm) return false;

        const memberRoleIds = member.roles.cache.map(r => r.id);
        const isWhitelisted = whitelist.some(
            w => w.targetId === userId || memberRoleIds.includes(w.targetId)
        );

        return isWhitelisted;
    }

    /**
     * The core enforcement logic - forces Discord to match DB state EXACTLY
     * @param channelId - The channel to enforce
     * @param notify - Whether to send notifications about the enforcement
     */
    private async executeEnforcement(channelId: string, notify: boolean = true): Promise<void> {
        this.enforcingChannels.add(channelId);

        try {
            // 1. Fetch DB State (THE TRUTH)
            let dbState: any = await prisma.privateVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true }
            });

            let isTeamChannel = false;
            if (!dbState) {
                dbState = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId },
                    include: { permissions: true }
                });
                isTeamChannel = !!dbState;
            }

            // Not a managed channel - nothing to enforce
            if (!dbState) {
                this.enforcingChannels.delete(channelId);
                return;
            }

            // 2. Fetch Discord Channel (THE REALITY)
            const channel = client.channels.cache.get(channelId) as VoiceChannel;
            if (!channel || channel.type !== ChannelType.GuildVoice) {
                console.log(`[Enforcer] Channel ${channelId} not found. Cleaning up DB...`);
                await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});
                await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => {});
                this.enforcingChannels.delete(channelId);
                return;
            }

            // 3. Construct the AUTHORITATIVE state
            const options: any = {
                userLimit: dbState.userLimit,
                bitrate: dbState.bitrate,
                rtcRegion: dbState.rtcRegion,
                videoQualityMode: dbState.videoQualityMode,
            };

            // 4. Build permission overwrites from DB
            const overwrites: any[] = [];

            // Owner gets FULL control
            overwrites.push({
                id: dbState.ownerId,
                type: OverwriteType.Member,
                allow: [
                    PermissionFlagsBits.Connect,
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.Speak,
                    PermissionFlagsBits.Stream,
                    PermissionFlagsBits.UseVAD,
                    PermissionFlagsBits.PrioritySpeaker,
                    PermissionFlagsBits.MuteMembers,
                    PermissionFlagsBits.DeafenMembers,
                    PermissionFlagsBits.MoveMembers,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.AttachFiles,
                ],
            });

            // @everyone role - enforce lock/hide state
            const everyoneDeny: bigint[] = [];
            const everyoneAllow: bigint[] = [];

            if (dbState.isLocked) {
                everyoneDeny.push(PermissionFlagsBits.Connect);
            } else {
                // Explicitly allow connect when unlocked to override any role denies
                everyoneAllow.push(PermissionFlagsBits.Connect);
            }

            if (dbState.isHidden) {
                everyoneDeny.push(PermissionFlagsBits.ViewChannel);
            } else {
                everyoneAllow.push(PermissionFlagsBits.ViewChannel);
            }

            overwrites.push({
                id: channel.guild.id,
                type: OverwriteType.Role,
                allow: everyoneAllow,
                deny: everyoneDeny,
            });

            // Permitted users/roles from DB
            for (const perm of dbState.permissions || []) {
                if (perm.permission === 'permit') {
                    overwrites.push({
                        id: perm.targetId,
                        type: perm.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                    });
                } else if (perm.permission === 'ban') {
                    overwrites.push({
                        id: perm.targetId,
                        type: perm.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                    });
                }
            }

            // 5. Apply the AUTHORITATIVE state
            options.permissionOverwrites = overwrites;

            // Record this as bot edit BEFORE making changes
            recordBotEdit(channelId);

            // Use IMMEDIATE priority - no queue, no delay
            await executeWithRateLimit(
                `enforce:${channelId}`,
                () => channel.edit(options),
                Priority.IMMEDIATE
            );

            console.log(`[Enforcer] ✅ Enforced DB state on channel ${channelId}`);

            // 6. Kick any unauthorized users currently in the channel
            await this.kickUnauthorizedMembers(channel, dbState);

            // 7. Log and notify ONLY if this was an external unauthorized change
            if (notify) {
                await this.notifyEnforcement(channel, isTeamChannel, dbState);
            }

        } catch (error) {
            console.error(`[Enforcer] ❌ Failed to enforce state on ${channelId}:`, error);
        } finally {
            this.enforcingChannels.delete(channelId);
        }
    }

    /**
     * Kick all unauthorized members from a channel
     * Called after enforcement to ensure no one bypasses via timing
     */
    private async kickUnauthorizedMembers(channel: VoiceChannel, dbState: any): Promise<void> {
        const guild = channel.guild;
        
        // Get settings and whitelist for strictness check
        const [settings, whitelist] = await Promise.all([
            getGuildSettings(guild.id),
            getWhitelist(guild.id),
        ]);

        const isLocked = dbState.isLocked;
        const isHidden = dbState.isHidden;
        const isFull = dbState.userLimit > 0 && channel.members.size > dbState.userLimit;

        // Get all global blocks for this guild (batch check)
        const globalBlocks = await prisma.globalVCBlock.findMany({
            where: { guildId: guild.id },
        });
        const globallyBlockedUserIds = new Set(globalBlocks.map(b => b.userId));

        // If channel is open, no need to kick anyone (except banned users and global blocks)
        const permissions = dbState.permissions || [];
        const bannedUserIds = new Set(
            permissions.filter((p: any) => p.permission === 'ban' && p.targetType === 'user').map((p: any) => p.targetId)
        );
        const bannedRoleIds = new Set(
            permissions.filter((p: any) => p.permission === 'ban' && p.targetType === 'role').map((p: any) => p.targetId)
        );
        const permittedUserIds = new Set(
            permissions.filter((p: any) => p.permission === 'permit' && p.targetType === 'user').map((p: any) => p.targetId)
        );
        const permittedRoleIds = new Set(
            permissions.filter((p: any) => p.permission === 'permit' && p.targetType === 'role').map((p: any) => p.targetId)
        );

        for (const [memberId, member] of channel.members) {
            // Skip bots (they have their own protection in voiceStateUpdate)
            if (member.user.bot) continue;

            // Owner is always allowed (unless globally blocked)
            if (memberId === dbState.ownerId && !globallyBlockedUserIds.has(memberId)) continue;

            // Check GLOBAL BLOCK - HIGHEST PRIORITY (kicks even owners)
            if (globallyBlockedUserIds.has(memberId)) {
                await this.kickMemberInstantly(member, channel.name, dbState.ownerId, 'globally blocked');
                continue;
            }

            const memberRoleIds = member.roles.cache.map(r => r.id);

            // Check if BANNED - always kick instantly
            const isBanned = bannedUserIds.has(memberId) || 
                memberRoleIds.some(roleId => bannedRoleIds.has(roleId));
            
            if (isBanned) {
                await this.kickMemberInstantly(member, channel.name, dbState.ownerId, 'blocked');
                continue;
            }

            // If channel is not locked/hidden/full, allow
            if (!isLocked && !isHidden && !isFull) continue;

            // Check if explicitly permitted
            const isPermitted = permittedUserIds.has(memberId) ||
                memberRoleIds.some(roleId => permittedRoleIds.has(roleId));
            
            if (isPermitted) continue;

            // Check admin/whitelist permissions
            const hasAdminPerm = member.permissions.has('Administrator') || member.permissions.has('ManageChannels');

            if (!settings?.adminStrictness) {
                // Strictness OFF - admins can bypass
                if (hasAdminPerm) continue;
            } else {
                // Strictness ON - only whitelisted admins can bypass
                const isWhitelisted = whitelist.some(
                    w => w.targetId === memberId || memberRoleIds.includes(w.targetId)
                );
                if (isWhitelisted && hasAdminPerm) continue;
            }

            // User is NOT authorized - KICK INSTANTLY
            const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
            await this.kickMemberInstantly(member, channel.name, dbState.ownerId, reason);
        }
    }

    /**
     * Kick a member INSTANTLY (IMMEDIATE priority like admin strictness)
     * Used for blocked users and unauthorized access
     */
    private async kickMemberInstantly(member: any, channelName: string, ownerId: string, reason: string): Promise<void> {
        // Use IMMEDIATE priority - same as admin strictness enforcement
        await executeWithRateLimit(
            `kick:${member.id}`,
            () => member.voice.disconnect(reason === 'globally blocked' ? 'Globally blocked' : reason === 'blocked' ? 'Blocked from channel' : 'Unauthorized access'),
            Priority.IMMEDIATE
        ).catch(err => {
            console.error(`[Enforcer] Failed to kick member instantly:`, err);
        });

        // Send DM notification
        try {
            const owner = member.guild.members.cache.get(ownerId);
            const ownerName = owner?.displayName || 'the owner';

            let embed: EmbedBuilder;
            
            if (reason === 'globally blocked') {
                embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚫 Global Voice Block')
                    .setDescription(
                        `You are **GLOBALLY BLOCKED** from joining any voice channel in **${member.guild.name}**.\n\n` +
                        `Contact server administrators for assistance.`
                    )
                    .setTimestamp();
            } else if (reason === 'blocked') {
                embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚫 Blocked')
                    .setDescription(
                        `You are **BLOCKED** from **${channelName}** by ${ownerName}.\n\n` +
                        `You cannot join this channel until you are unblocked.`
                    )
                    .setTimestamp();
            } else {
                embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle('🚫 Access Denied')
                    .setDescription(
                        `You were removed from **${channelName}** because the channel is **${reason}**.\n\n` +
                        `Ask **${ownerName}** to give you access to join.`
                    )
                    .setTimestamp();
            }

            await member.send({ embeds: [embed] }).catch(() => {});
            console.log(`[Enforcer] Kicked ${member.user.tag} from channel INSTANTLY (${reason})`);
        } catch (err) {
            console.error(`[Enforcer] Failed to send kick notification:`, err);
        }
    }

    /**
     * Send notification about enforcement
     */
    private async notifyEnforcement(channel: VoiceChannel, isTeamChannel: boolean, dbState: any): Promise<void> {
        try {
            const { logAction, LogAction } = await import('../utils/logger');

            await logAction({
                action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
                guild: channel.guild,
                channelName: channel.name,
                channelId: channel.id,
                details: `Manipulation detected and reverted back to original`,
                isTeamChannel,
                teamType: dbState.teamType
            });
        } catch (err) {
            console.error('[Enforcer] Notification failed:', err);
        }
    }

    /**
     * Validate if a join should be allowed based on DB state
     * Returns true if the user should be kicked
     */
    public async shouldKickUser(channelId: string, memberId: string, memberRoleIds: string[]): Promise<{ shouldKick: boolean; reason: string }> {
        // Fetch DB state
        let dbState: any = await prisma.privateVoiceChannel.findUnique({
            where: { channelId },
            include: { permissions: true }
        });

        if (!dbState) {
            dbState = await prisma.teamVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true }
            });
        }

        if (!dbState) {
            return { shouldKick: false, reason: '' };
        }

        // Owner is always allowed
        if (memberId === dbState.ownerId) {
            return { shouldKick: false, reason: '' };
        }

        const permissions = dbState.permissions || [];

        // Check if BANNED
        const isBanned = permissions.some(
            (p: any) => (p.targetId === memberId && p.permission === 'ban') ||
                (memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'ban')
        );

        if (isBanned) {
            return { shouldKick: true, reason: 'blocked' };
        }

        // If not locked/hidden, allow
        if (!dbState.isLocked && !dbState.isHidden) {
            return { shouldKick: false, reason: '' };
        }

        // Check if permitted
        const isPermitted = permissions.some(
            (p: any) => (p.targetId === memberId && p.permission === 'permit') ||
                (memberRoleIds.includes(p.targetId) && p.targetType === 'role' && p.permission === 'permit')
        );

        if (isPermitted) {
            return { shouldKick: false, reason: '' };
        }

        const reason = dbState.isLocked ? 'locked' : 'hidden';
        return { shouldKick: true, reason };
    }
}

export const enforcer = new EnforcerService();

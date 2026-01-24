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

    /**
     * IMMEDIATE enforcement - no delays, no debounce
     * Called when ANY external change is detected
     */
    public async enforce(channelId: string): Promise<void> {
        // Prevent duplicate enforcement calls for the same channel
        if (this.pendingEnforcements.has(channelId) || this.enforcingChannels.has(channelId)) {
            return;
        }

        this.pendingEnforcements.add(channelId);
        
        try {
            await this.executeEnforcement(channelId);
        } finally {
            this.pendingEnforcements.delete(channelId);
        }
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
     */
    private async executeEnforcement(channelId: string): Promise<void> {
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

            // 7. Log and notify
            await this.notifyEnforcement(channel, isTeamChannel, dbState);

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

        // If channel is open, no need to kick anyone (except banned users)
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

            // Owner is always allowed
            if (memberId === dbState.ownerId) continue;

            const memberRoleIds = member.roles.cache.map(r => r.id);

            // Check if BANNED - always kick
            const isBanned = bannedUserIds.has(memberId) || 
                memberRoleIds.some(roleId => bannedRoleIds.has(roleId));
            
            if (isBanned) {
                await this.kickMember(member, channel.name, dbState.ownerId, 'blocked');
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

            // User is NOT authorized - KICK
            const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
            await this.kickMember(member, channel.name, dbState.ownerId, reason);
        }
    }

    /**
     * Kick a member and send them a DM
     */
    private async kickMember(member: any, channelName: string, ownerId: string, reason: string): Promise<void> {
        try {
            await member.voice.disconnect();
            
            const owner = member.guild.members.cache.get(ownerId);
            const ownerName = owner?.displayName || 'the owner';

            const embed = new EmbedBuilder()
                .setColor(reason === 'blocked' ? 0xFF0000 : 0xFF6B6B)
                .setTitle(reason === 'blocked' ? '🚫 Blocked' : '🚫 Access Denied')
                .setDescription(
                    reason === 'blocked'
                        ? `You are **BLOCKED** from **${channelName}** by ${ownerName}.\n\nYou cannot join this channel until you are unblocked.`
                        : `You were removed from **${channelName}** because the channel is **${reason}**.\n\nAsk **${ownerName}** to give you access to join.`
                )
                .setTimestamp();

            await member.send({ embeds: [embed] }).catch(() => {});
            console.log(`[Enforcer] Kicked ${member.user.tag} from channel (${reason})`);
        } catch (err) {
            console.error(`[Enforcer] Failed to kick member:`, err);
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
                user: client.user!,
                channelName: channel.name,
                channelId: channel.id,
                details: `**Auto-Correction Triggered**\n\nUnauthorized channel modification detected and reverted.\n**Action:** Instantly restored DB state.\n\n*Only the channel owner (via bot interface) or whitelisted admins can modify channel settings.*`,
                isTeamChannel,
                teamType: dbState.teamType
            });

            // Send warning to channel
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ Unauthorized Change Reverted')
                .setDescription(
                    `**This channel is protected by the bot.**\n\n` +
                    `Direct Discord changes (permissions, lock, limit, etc.) are **NOT ALLOWED** and have been **instantly reverted**.\n\n` +
                    `✅ Use the **Bot Interface** buttons to control your channel.\n` +
                    `❌ Do NOT use Discord's channel settings.`
                )
                .setFooter({ text: 'Security Protocol Active • All changes logged' })
                .setTimestamp();

            await channel.send({ embeds: [embed] }).catch(() => {});
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

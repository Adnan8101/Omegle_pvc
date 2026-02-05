import { ChannelType, type VoiceChannel, PermissionFlagsBits, OverwriteType, EmbedBuilder } from 'discord.js';
import { client } from '../client';
import prisma from '../utils/database';
import { vcnsBridge } from '../vcns/bridge';
import { stateStore } from '../vcns/index';
import { recordBotEdit } from '../events/channelUpdate';
import { getWhitelist, getGuildSettings } from '../utils/cache';
class EnforcerService {
    private pendingEnforcements = new Set<string>();
    private enforcingChannels = new Set<string>();
    private recentlyEnforced = new Map<string, number>();
    private ENFORCEMENT_COOLDOWN = 60000;
    private retryQueue = new Map<string, { notify: boolean; retryAt: number }>();
    private retryTimerActive = false;
    public async enforce(channelId: string, notify: boolean = true): Promise<void> {
        if (this.pendingEnforcements.has(channelId) || this.enforcingChannels.has(channelId)) {
            return;
        }
        const lastEnforced = this.recentlyEnforced.get(channelId);
        if (lastEnforced && Date.now() - lastEnforced < this.ENFORCEMENT_COOLDOWN) {
            notify = false;
        }
        this.pendingEnforcements.add(channelId);
        try {
            await this.executeEnforcement(channelId, notify);
            this.recentlyEnforced.set(channelId, Date.now());
        } catch (error: any) {
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
    private queueRetry(channelId: string, notify: boolean, delayMs: number): void {
        const retryAt = Date.now() + delayMs;
        const existing = this.retryQueue.get(channelId);
        if (!existing || retryAt < existing.retryAt) {
            this.retryQueue.set(channelId, { notify: false, retryAt });
        }
        if (!this.retryTimerActive) {
            this.startRetryTimer();
        }
    }
    private startRetryTimer(): void {
        if (this.retryTimerActive) return;
        this.retryTimerActive = true;
        const processQueue = async () => {
            const now = Date.now();
            const toRetry: string[] = [];
            for (const [channelId, data] of this.retryQueue.entries()) {
                if (now >= data.retryAt) {
                    toRetry.push(channelId);
                }
            }
            for (const channelId of toRetry) {
                this.retryQueue.delete(channelId);
                console.log(`[Enforcer] Retrying enforcement for ${channelId}`);
                this.enforceQuietly(channelId).catch(err => {
                    console.error(`[Enforcer] Retry failed for ${channelId}:`, err);
                });
            }
            if (this.retryQueue.size > 0) {
                setTimeout(processQueue, 1000);
            } else {
                this.retryTimerActive = false;
            }
        };
        setTimeout(processQueue, 1000);
    }
    public wasRecentlyEnforced(channelId: string): boolean {
        const lastEnforced = this.recentlyEnforced.get(channelId);
        if (!lastEnforced) return false;
        return Date.now() - lastEnforced < this.ENFORCEMENT_COOLDOWN;
    }
    public async enforceQuietly(channelId: string): Promise<void> {
        return this.enforce(channelId, false);
    }
    public async isAuthorizedEditor(guildId: string, userId: string, channelId?: string): Promise<boolean> {
        if (userId === client.user?.id) {
            return true;
        }
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return false;
        let isPvc = false;
        let isTeam = false;
        let channelOwnerId: string | null = null;
        if (channelId) {
            const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            isPvc = !!pvc;
            isTeam = !!team;
            channelOwnerId = pvc?.ownerId || team?.ownerId || null;
            if (channelOwnerId === userId) {
                console.log(`[Enforcer] User ${userId} is channel owner - authorized`);
                return true;
            }
        }
        const results = await Promise.allSettled([
            getGuildSettings(guildId),
            prisma.teamVoiceSettings.findUnique({ where: { guildId } }),
            getWhitelist(guildId),
        ]);
        const pvcSettings = results[0].status === 'fulfilled' ? results[0].value : null;
        const teamSettings = results[1].status === 'fulfilled' ? results[1].value : null;
        const whitelist = results[2].status === 'fulfilled' ? results[2].value : [];
        let strictnessEnabled = false;
        if (isTeam && teamSettings) {
            strictnessEnabled = teamSettings.adminStrictness;
        } else if (isPvc && pvcSettings) {
            strictnessEnabled = pvcSettings.adminStrictness;
        } else if (pvcSettings) {
            strictnessEnabled = pvcSettings.adminStrictness;
        }
        if (!strictnessEnabled) {
            return false;
        }
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
    private async executeEnforcement(channelId: string, notify: boolean = true): Promise<void> {
        this.enforcingChannels.add(channelId);
        try {
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
            if (!dbState) {
                this.enforcingChannels.delete(channelId);
                return;
            }
            let channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
            if (!channel) {
                const guild = client.guilds.cache.get(dbState.guildId);
                if (!guild) {
                    console.warn(`[Enforcer] Guild ${dbState.guildId} missing from cache. Aborting enforcement for ${channelId}.`);
                    this.enforcingChannels.delete(channelId);
                    return;
                }
                try {
                    const fetchedChannel = await guild.channels.fetch(channelId);
                    if (fetchedChannel && fetchedChannel.type === ChannelType.GuildVoice) {
                        channel = fetchedChannel as VoiceChannel;
                    } else if (fetchedChannel) {
                        console.log(`[Enforcer] Channel ${channelId} exists but type is ${fetchedChannel.type} (not Voice). Cleaning up DB...`);
                        await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                        await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                        this.enforcingChannels.delete(channelId);
                        return;
                    }
                } catch (fetchErr: any) {
                    const isDefinitiveMissing =
                        fetchErr.code === 10003 ||
                        fetchErr.status === 404;
                    const isAccessDenied =
                        fetchErr.code === 50013 ||
                        fetchErr.status === 403;
                    if (isDefinitiveMissing || isAccessDenied) {
                        console.log(`[Enforcer] Channel ${channelId} confirmed missing/inaccessible. Cleaning up DB...`);
                        await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                        await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                        this.enforcingChannels.delete(channelId);
                        return;
                    } else {
                        console.error(`[Enforcer] ❌ API Error fetching channel ${channelId} (Code: ${fetchErr.code}). Aborting cleanup to prevent data loss.`);
                        this.enforcingChannels.delete(channelId);
                        return;
                    }
                }
            }
            if (channel && channel.type !== ChannelType.GuildVoice) {
                await prisma.privateVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                await prisma.teamVoiceChannel.deleteMany({ where: { channelId } }).catch(() => { });
                this.enforcingChannels.delete(channelId);
                return;
            }
            if (!channel) {
                console.warn(`[Enforcer] Channel ${channelId} could not be resolved. Aborting.`);
                this.enforcingChannels.delete(channelId);
                return;
            }
            const options: any = {
                userLimit: dbState.userLimit,
                bitrate: dbState.bitrate,
                rtcRegion: dbState.rtcRegion,
                videoQualityMode: dbState.videoQualityMode,
            };
            options.permissionOverwrites = this.buildOverwrites(dbState, channel.guild.id);
            recordBotEdit(channelId);
            await channel.edit(options);
            await this.kickUnauthorizedMembers(channel, dbState);
            if (notify) {
                await this.notifyEnforcement(channel, isTeamChannel, dbState);
            }
        } catch (error) {
            console.error(`[Enforcer] ❌ Failed to enforce state on ${channelId}:`, error);
        } finally {
            this.enforcingChannels.delete(channelId);
        }
    }
    private async kickUnauthorizedMembers(channel: VoiceChannel, dbState: any): Promise<void> {
        const guild = channel.guild;
        const channelId = channel.id;
        const results = await Promise.allSettled([
            getGuildSettings(guild.id),
            prisma.teamVoiceSettings.findUnique({ where: { guildId: guild.id } }),
            getWhitelist(guild.id),
        ]);
        const pvcSettings = results[0].status === 'fulfilled' ? results[0].value : null;
        const teamSettings = results[1].status === 'fulfilled' ? results[1].value : null;
        const whitelist = results[2].status === 'fulfilled' ? results[2].value : [];
        const isTeamChannel = 'teamType' in dbState;
        const strictnessEnabled = isTeamChannel ? teamSettings?.adminStrictness : pvcSettings?.adminStrictness;
        const isLocked = dbState.isLocked;
        const isHidden = dbState.isHidden;
        let isFull = false;
        if ('teamType' in dbState && dbState.teamType) {
            const TEAM_USER_LIMITS = { duo: 2, trio: 3, squad: 4 };
            const teamTypeLower = (dbState.teamType as string).toLowerCase() as keyof typeof TEAM_USER_LIMITS;
            const teamLimit = TEAM_USER_LIMITS[teamTypeLower];
            if (teamLimit) {
                isFull = channel.members.size >= teamLimit;
            }
        } else {
            // Explicitly check for valid positive userLimit (0 or undefined/null means unlimited)
            const userLimit = typeof dbState.userLimit === 'number' ? dbState.userLimit : 0;
            isFull = userLimit > 0 && channel.members.size > userLimit;
            console.log(`[Enforcer] 📊 Capacity check: members=${channel.members.size}, userLimit=${userLimit}, isFull=${isFull}`);
        }
        const globalBlocks = await prisma.globalVCBlock.findMany({
            where: { guildId: guild.id },
        });
        const globallyBlockedUserIds = new Set(globalBlocks.map(b => b.userId));
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
        
        // CRITICAL: Also include stateStore memory permissions (most recent from !au/!ru commands)
        const memoryPermits = stateStore.getChannelPermits(channelId);
        const memoryBans = stateStore.getChannelBans(channelId);
        for (const userId of memoryPermits) {
            permittedUserIds.add(userId);
        }
        for (const userId of memoryBans) {
            bannedUserIds.add(userId);
        }
        
        for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;
            if (memberId === dbState.ownerId && !globallyBlockedUserIds.has(memberId)) continue;
            if (globallyBlockedUserIds.has(memberId)) {
                await this.kickMemberInstantly(member, channel.name, dbState.ownerId, 'globally blocked');
                continue;
            }
            const memberRoleIds = member.roles.cache.map(r => r.id);
            const isBanned = bannedUserIds.has(memberId) ||
                memberRoleIds.some(roleId => bannedRoleIds.has(roleId));
            if (isBanned) {
                await this.kickMemberInstantly(member, channel.name, dbState.ownerId, 'blocked');
                continue;
            }
            const isRestricted = isLocked || isHidden || isFull;
            if (!isRestricted) {
                continue; 
            }
            const isPermitted = permittedUserIds.has(memberId) ||
                memberRoleIds.some(roleId => permittedRoleIds.has(roleId));
            if (isPermitted) {
                continue;
            }
            const hasPermanentAccess = stateStore.hasPermanentAccess(guild.id, dbState.ownerId, memberId);
            if (hasPermanentAccess) {
                continue;
            }
            if (strictnessEnabled) {
                const isWhitelisted = whitelist.some(
                    w => w.targetId === memberId || memberRoleIds.includes(w.targetId)
                );
                if (isWhitelisted) {
                    continue;
                }
                const restrictionReason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
                await this.kickMemberInstantly(member, channel.name, dbState.ownerId, `not whitelisted - channel ${restrictionReason} (admin strictness)`);
                continue;
            }
            const reason = isLocked ? 'locked' : isHidden ? 'hidden' : 'at capacity';
            await this.kickMemberInstantly(member, channel.name, dbState.ownerId, reason);
        }
    }
    private async kickMemberInstantly(member: any, channelName: string, ownerId: string, reason: string): Promise<void> {
        try {
            await vcnsBridge.kickUser({
                guild: member.guild,
                channelId: member.voice.channelId,
                userId: member.id,
                reason: reason === 'globally blocked' ? 'Globally blocked' :
                    reason === 'blocked' ? 'Blocked from channel' :
                        reason.includes('not whitelisted') ? 'Admin strictness: not whitelisted' : 'Unauthorized access',
                isImmediate: true,
            });
        } catch (err) {
            console.error(`[Enforcer] Failed to kick member instantly:`, err);
        }
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
            } else if (reason.includes('not whitelisted')) {
                embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🚫 Access Denied - Admin Strictness')
                    .setDescription(
                        `You were **instantly disconnected** from **${channelName}** in **${member.guild.name}**.\n\n` +
                        `**Reason:** Admin Strictness mode is enabled. Only authorized users can access voice channels.\n\n` +
                        `Contact a server administrator if you believe this is an error.`
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
            await member.send({ embeds: [embed] }).catch(() => { });
            console.log(`[Enforcer] Kicked ${member.user.tag} from channel INSTANTLY (${reason})`);
            const { logAction, LogAction } = await import('../utils/logger');
            await logAction({
                action: LogAction.USER_REMOVED,
                guild: member.guild,
                user: member.user,
                channelName: channelName,
                channelId: member.voice?.channelId || 'unknown',
                details: reason.includes('not whitelisted')
                    ? `Admin strictness: User not whitelisted - instant kick`
                    : `Unauthorized access: ${reason}`,
                isTeamChannel: false,
            }).catch(() => { });
        } catch (err) {
            console.error(`[Enforcer] Failed to send kick notification:`, err);
        }
    }
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
    private buildOverwrites(dbState: any, guildId: string): any[] {
        const overwrites: any[] = [];
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
        const everyoneDeny: bigint[] = [];
        if (dbState.isLocked) {
            everyoneDeny.push(PermissionFlagsBits.Connect);
        }
        if (dbState.isHidden) {
            everyoneDeny.push(PermissionFlagsBits.ViewChannel);
        }
        if (everyoneDeny.length > 0) {
            overwrites.push({
                id: guildId,
                type: OverwriteType.Role,
                allow: [],
                deny: everyoneDeny,
            });
        }
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
        
        // CRITICAL: Also include stateStore memory permissions (most recent from !au/!ru commands)
        const channelId = dbState.channelId;
        const memoryPermits = stateStore.getChannelPermits(channelId);
        const memoryBans = stateStore.getChannelBans(channelId);
        const alreadyProcessed = new Set((dbState.permissions || []).map((p: any) => p.targetId));
        
        for (const userId of memoryPermits) {
            if (!alreadyProcessed.has(userId)) {
                overwrites.push({
                    id: userId,
                    type: OverwriteType.Member,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                });
            }
        }
        for (const userId of memoryBans) {
            if (!alreadyProcessed.has(userId)) {
                overwrites.push({
                    id: userId,
                    type: OverwriteType.Member,
                    deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                });
            }
        }
        
        const permanentAccessTargets = stateStore.getPermanentAccessTargets(guildId, dbState.ownerId);
        for (const targetId of permanentAccessTargets) {
            const alreadyHasPermission = (dbState.permissions || []).some(
                (p: any) => p.targetId === targetId
            );
            if (!alreadyHasPermission) {
                overwrites.push({
                    id: targetId,
                    type: OverwriteType.Member,
                    allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
                });
            }
        }
        return overwrites;
    }
}
export const enforcer = new EnforcerService();

import { VoiceState, Guild, GuildMember, VoiceChannel } from 'discord.js';
import { accessEngine, AccessDecision, AccessContext } from '../vcns/accessEngine';
import { actionExecutor } from '../vcns/actionExecutor';
import { getChannelState, getTeamChannelState } from '../utils/voiceManager';
export class AccessProtectionHandler {
    public async validateAndEnforceAccess(state: VoiceState): Promise<{
        allowed: boolean;
        actionTaken?: string;
        reason?: string;
    }> {
        const { guild, member, channelId } = state;
        if (!guild || !member || !channelId) {
            return { allowed: false, reason: 'Missing required context' };
        }
        if (member.user.bot) {
            return { allowed: true, reason: 'Bot user - skipping validation' };
        }
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (!channel || !channel.isVoiceBased()) {
            return { allowed: false, reason: 'Invalid channel' };
        }
        const context = await this.buildAccessContext(guild, member, channel);
        const accessResult = await accessEngine.evaluateAccess(context);
        console.log(`[AccessProtection] Access evaluation for ${member.user.tag} in ${channelId}: ${accessResult.decision} (${accessResult.reason})`);
        if (accessResult.decision === AccessDecision.ALLOW) {
            return { 
                allowed: true, 
                reason: `Access granted: ${accessResult.reason}` 
            };
        }
        const enforcement = await this.enforceAccessDenial(state, accessResult);
        return {
            allowed: false,
            actionTaken: enforcement.actionTaken,
            reason: `Access denied: ${accessResult.reason}`
        };
    }
    private async buildAccessContext(
        guild: Guild, 
        member: GuildMember, 
        channel: VoiceChannel
    ): Promise<AccessContext> {
        const channelState = getChannelState(channel.id);
        const teamChannelState = getTeamChannelState(channel.id);
        const channelOwnerId = channelState?.ownerId || teamChannelState?.ownerId;
        const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
        const isChannelLocked = everyonePerms?.deny.has('Connect') ?? false;
        const isChannelHidden = everyonePerms?.deny.has('ViewChannel') ?? false;
        return {
            guildId: guild.id,
            channelId: channel.id,
            userId: member.id,
            userRoles: member.roles.cache.map(r => r.id),
            channelOwnerId,
            channelMembers: channel.members.size,
            channelLimit: channel.userLimit || undefined,
            isChannelLocked,
            isChannelHidden,
            isBotUser: member.user.bot
        };
    }
    private async enforceAccessDenial(state: VoiceState, accessResult: any): Promise<{
        success: boolean;
        actionTaken?: string;
        error?: string;
    }> {
        const { guild, member, channelId } = state;
        if (!guild || !member || !channelId) {
            return { success: false, error: 'Missing context for enforcement' };
        }
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        const result = await actionExecutor.executeKick({
            guild,
            member,
            channel,
            channelId,
            reason: accessResult.message || `Access denied: ${accessResult.reason}`,
            accessResult,
            silent: false 
        });
        return {
            success: result.success,
            actionTaken: result.actionTaken,
            error: result.error
        };
    }
    public async checkAccessOnly(state: VoiceState): Promise<{
        allowed: boolean;
        reason: string;
        tier: string;
    }> {
        const { guild, member, channelId } = state;
        if (!guild || !member || !channelId) {
            return { 
                allowed: false, 
                reason: 'Missing context', 
                tier: 'NONE' 
            };
        }
        if (member.user.bot) {
            return { 
                allowed: true, 
                reason: 'Bot user', 
                tier: 'NONE' 
            };
        }
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (!channel || !channel.isVoiceBased()) {
            return { 
                allowed: false, 
                reason: 'Invalid channel', 
                tier: 'NONE' 
            };
        }
        const context = await this.buildAccessContext(guild, member, channel);
        const accessResult = await accessEngine.evaluateAccess(context);
        return {
            allowed: accessResult.decision === AccessDecision.ALLOW,
            reason: accessResult.reason,
            tier: accessResult.tier
        };
    }
    public async validateBulkAccess(
        guild: Guild, 
        channel: VoiceChannel, 
        members: GuildMember[]
    ): Promise<Map<string, { allowed: boolean; reason: string; tier: string }>> {
        const results = new Map();
        for (const member of members) {
            const context = await this.buildAccessContext(guild, member, channel);
            const accessResult = await accessEngine.evaluateAccess(context);
            results.set(member.id, {
                allowed: accessResult.decision === AccessDecision.ALLOW,
                reason: accessResult.reason,
                tier: accessResult.tier
            });
        }
        return results;
    }
}
export const accessProtectionHandler = new AccessProtectionHandler();
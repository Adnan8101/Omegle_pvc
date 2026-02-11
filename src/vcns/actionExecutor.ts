import { Guild, GuildMember, VoiceChannel, EmbedBuilder } from 'discord.js';
import { vcnsBridge } from './bridge';
import { logAction, LogAction } from '../utils/logger';
import { AccessReason, AccessResult } from './accessEngine';
export interface ActionContext {
    guild: Guild;
    member?: GuildMember;
    channel?: VoiceChannel;
    channelId: string;
    reason: string;
    accessResult?: AccessResult;
    silent?: boolean;
}
export interface ActionResult {
    success: boolean;
    error?: string;
    actionTaken?: string;
}
export class ActionExecutor {
    public async executeKick(context: ActionContext): Promise<ActionResult> {
        const { guild, member, channel, channelId, reason, accessResult, silent } = context;
        if (!member) {
            return { success: false, error: 'No member to kick' };
        }
        try {
            console.log(`[ActionExecutor] 🚪 Kicking ${member.user.tag} from ${channelId}: ${reason}`);
            await member.voice.disconnect();
            if (!silent) {
                await this.sendKickNotification(member, guild, reason, accessResult);
            }
            await logAction({
                action: LogAction.USER_KICKED,
                guild: guild,
                user: member.user,
                channelName: channel?.name || 'Unknown Channel',
                channelId: channelId,
                details: reason,
            });
            console.log(`[ActionExecutor] ✅ Successfully kicked ${member.user.tag}`);
            return { 
                success: true, 
                actionTaken: `Kicked ${member.user.tag}: ${reason}` 
            };
        } catch (error) {
            console.error(`[ActionExecutor] ❌ Failed to kick ${member.user.tag}:`, error);
            return { 
                success: false, 
                error: `Failed to kick user: ${error}` 
            };
        }
    }
    public async executePermissionChange(context: ActionContext & {
        targetId: string;
        permissions: Record<string, boolean>;
        remove?: boolean;
    }): Promise<ActionResult> {
        const { guild, channelId, targetId, permissions, remove, reason } = context;
        try {
            console.log(`[ActionExecutor] 🔑 ${remove ? 'Removing' : 'Setting'} permissions for ${targetId} on ${channelId}: ${reason}`);
            const result = remove 
                ? await vcnsBridge.removePermission({
                    guild,
                    channelId,
                    targetId,
                    allowWhenHealthy: true,
                })
                : await vcnsBridge.editPermission({
                    guild,
                    channelId,
                    targetId,
                    permissions,
                    allowWhenHealthy: true,
                });
            if (result.success) {
                console.log(`[ActionExecutor] ✅ Permission change successful for ${targetId}`);
                return { 
                    success: true, 
                    actionTaken: `${remove ? 'Removed' : 'Set'} permissions for ${targetId}` 
                };
            } else {
                console.log(`[ActionExecutor] ⚠️ Permission change failed for ${targetId}:`, result.error);
                return { 
                    success: false, 
                    error: result.error 
                };
            }
        } catch (error) {
            console.error(`[ActionExecutor] ❌ Permission change error for ${targetId}:`, error);
            return { 
                success: false, 
                error: `Failed to change permissions: ${error}` 
            };
        }
    }
    public async executeChannelRename(context: ActionContext & {
        newName: string;
    }): Promise<ActionResult> {
        const { guild, channelId, newName, reason } = context;
        try {
            console.log(`[ActionExecutor] 📝 Renaming channel ${channelId} to "${newName}": ${reason}`);
            const result = await vcnsBridge.renameVC({
                guild,
                channelId,
                newName,
                allowWhenHealthy: true,
            });
            if (result.success) {
                console.log(`[ActionExecutor] ✅ Channel rename successful: ${newName}`);
                return { 
                    success: true, 
                    actionTaken: `Renamed channel to ${newName}` 
                };
            } else {
                console.log(`[ActionExecutor] ⚠️ Channel rename failed:`, result.error);
                return { 
                    success: false, 
                    error: result.error 
                };
            }
        } catch (error) {
            console.error(`[ActionExecutor] ❌ Channel rename error:`, error);
            return { 
                success: false, 
                error: `Failed to rename channel: ${error}` 
            };
        }
    }
    public async executeChannelDeletion(context: ActionContext): Promise<ActionResult> {
        const { guild, channelId, reason } = context;
        try {
            console.log(`[ActionExecutor] 🗑️ Deleting channel ${channelId}: ${reason}`);
            const result = await vcnsBridge.deleteVC({
                guild,
                channelId,
            });
            if (result.success) {
                console.log(`[ActionExecutor] ✅ Channel deletion successful`);
                return { 
                    success: true, 
                    actionTaken: `Deleted channel` 
                };
            } else {
                console.log(`[ActionExecutor] ⚠️ Channel deletion failed:`, result.error);
                return { 
                    success: false, 
                    error: result.error 
                };
            }
        } catch (error) {
            console.error(`[ActionExecutor] ❌ Channel deletion error:`, error);
            return { 
                success: false, 
                error: `Failed to delete channel: ${error}` 
            };
        }
    }
    private async sendKickNotification(
        member: GuildMember, 
        guild: Guild, 
        reason: string, 
        accessResult?: AccessResult
    ): Promise<void> {
        try {
            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle('🚪 Removed from Voice Channel')
                .setDescription(this.getKickMessage(reason, accessResult))
                .addFields([
                    { name: '🏠 Server', value: guild.name, inline: true },
                    { name: '📅 Time', value: new Date().toLocaleString(), inline: true }
                ])
                .setFooter({ 
                    text: 'Contact server admins if you believe this was an error',
                    iconURL: guild.iconURL() || undefined
                })
                .setTimestamp();
            await member.send({ embeds: [embed] });
            console.log(`[ActionExecutor] 📬 Sent kick notification to ${member.user.tag}`);
        } catch (error) {
            console.log(`[ActionExecutor] ⚠️ Could not send kick notification to ${member.user.tag}:`, error);
        }
    }
    private getKickMessage(reason: string, accessResult?: AccessResult): string {
        if (!accessResult) {
            return `**Reason:** ${reason}`;
        }
        switch (accessResult.reason) {
            case AccessReason.CHANNEL_LOCKED:
                return '🔒 **This channel is locked** - only permitted users can join.\n\nContact the channel owner for access.';
            case AccessReason.CHANNEL_HIDDEN:
                return '👁️‍🗨️ **This channel is hidden** - only permitted users can see and join it.\n\nContact the channel owner for access.';
            case AccessReason.CHANNEL_FULL:
                return '🚫 **This channel is full** - the user limit has been reached.\n\nPlease wait for a spot to open up.';
            case AccessReason.DB_BAN:
                return '⛔ **You are banned from this channel** - this was set by the channel owner or admins.\n\nContact server staff to appeal.';
            case AccessReason.MEMORY_BAN:
                return '⛔ **You are temporarily banned from this channel** - this was recently set by the owner.\n\nThis ban may be temporary - try again later.';
            case AccessReason.ADMIN_STRICTNESS:
                return '⚖️ **Admin strictness is enforced** - restricted channels require explicit permission.\n\nContact the channel owner or server admins.';
            case AccessReason.GLOBAL_BLOCK:
                return '🛡️ **You are blocked from voice channels** - this is a server-wide restriction.\n\nContact server administrators for assistance.';
            default:
                return `**Reason:** ${reason}${accessResult.message ? `\n\n${accessResult.message}` : ''}`;
        }
    }
}
export const actionExecutor = new ActionExecutor();
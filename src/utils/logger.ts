import { EmbedBuilder, GuildMember, type Guild, type User } from 'discord.js';
import prisma from './database';

export enum LogAction {
    CHANNEL_CREATED = 'Channel Created',
    CHANNEL_DELETED = 'Channel Deleted',
    CHANNEL_LOCKED = 'Channel Locked',
    CHANNEL_UNLOCKED = 'Channel Unlocked',
    CHANNEL_HIDDEN = 'Channel Hidden',
    CHANNEL_UNHIDDEN = 'Channel Unhidden',
    CHANNEL_RENAMED = 'Channel Renamed',
    CHANNEL_LIMIT_SET = 'User Limit Set',
    CHANNEL_BITRATE_SET = 'Bitrate Changed',
    CHANNEL_REGION_SET = 'Region Changed',
    CHANNEL_CLAIMED = 'Channel Claimed',
    CHANNEL_TRANSFERRED = 'Channel Transferred',

    USER_ADDED = 'User Added',
    USER_REMOVED = 'User Removed',
    USER_BANNED = 'User Banned',
    USER_PERMITTED = 'User Permitted',

    RENAME_REQUESTED = 'Rename Requested',
    RENAME_APPROVED = 'Rename Approved',
    RENAME_REJECTED = 'Rename Rejected',
    RENAME_EXPIRED = 'Rename Expired',

    PVC_SETUP = 'PVC System Setup',
    PVC_DELETED = 'PVC System Deleted',
    PVC_REFRESHED = 'PVC Interface Refreshed',

    TEAM_SETUP = 'Team VC System Setup',
    TEAM_CHANNEL_CREATED = 'Team Channel Created',
    TEAM_CHANNEL_DELETED = 'Team Channel Deleted',

    SETTINGS_UPDATED = 'Settings Updated',
}

interface LogData {
    action: LogAction;
    guild: Guild;
    user?: User | GuildMember;
    channelName?: string;
    channelId?: string;
    details?: string;
    targetUser?: User | GuildMember;
}

const ACTION_COLORS: Record<LogAction, number> = {
    [LogAction.CHANNEL_CREATED]: 0x00FF00,
    [LogAction.CHANNEL_DELETED]: 0xFF0000,
    [LogAction.CHANNEL_LOCKED]: 0xFFA500,
    [LogAction.CHANNEL_UNLOCKED]: 0x00FF00,
    [LogAction.CHANNEL_HIDDEN]: 0xFFA500,
    [LogAction.CHANNEL_UNHIDDEN]: 0x00FF00,
    [LogAction.CHANNEL_RENAMED]: 0x3498DB,
    [LogAction.CHANNEL_LIMIT_SET]: 0x3498DB,
    [LogAction.CHANNEL_BITRATE_SET]: 0x3498DB,
    [LogAction.CHANNEL_REGION_SET]: 0x3498DB,
    [LogAction.CHANNEL_CLAIMED]: 0xFFD700,
    [LogAction.CHANNEL_TRANSFERRED]: 0x9B59B6,
    [LogAction.USER_ADDED]: 0x00FF00,
    [LogAction.USER_REMOVED]: 0xFF6347,
    [LogAction.USER_BANNED]: 0xFF0000,
    [LogAction.USER_PERMITTED]: 0x00FF00,
    [LogAction.RENAME_REQUESTED]: 0xFFAA00,
    [LogAction.RENAME_APPROVED]: 0x00FF00,
    [LogAction.RENAME_REJECTED]: 0xFF0000,
    [LogAction.RENAME_EXPIRED]: 0x888888,
    [LogAction.PVC_SETUP]: 0x00FF00,
    [LogAction.PVC_DELETED]: 0xFF0000,
    [LogAction.PVC_REFRESHED]: 0x3498DB,
    [LogAction.TEAM_SETUP]: 0x00FF00,
    [LogAction.TEAM_CHANNEL_CREATED]: 0x00FF00,
    [LogAction.TEAM_CHANNEL_DELETED]: 0xFF0000,
    [LogAction.SETTINGS_UPDATED]: 0x3498DB,
};

export async function logAction(data: LogData): Promise<void> {
    try {
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId: data.guild.id },
        });

        if (!settings?.logsWebhookUrl) {
            return;
        }

        let description = '';

        if (data.user) {
            const username = data.user instanceof GuildMember ? data.user.user.username : data.user.username;
            const userId = data.user instanceof GuildMember ? data.user.user.id : data.user.id;
            description += `**User:** <@${userId}>`;
        }

        if (data.channelName) {
            description += `${description ? '\n' : ''}**Channel:** ${data.channelName}`;
        }

        if (data.targetUser) {
            const targetUserId = data.targetUser instanceof GuildMember ? data.targetUser.user.id : data.targetUser.id;
            description += `\n**Target:** <@${targetUserId}>`;
        }

        if (data.details) {
            description += `\n**Details:** ${data.details}`;
        }

        const embed = new EmbedBuilder()
            .setTitle(data.action)
            .setDescription(description)
            .setColor(ACTION_COLORS[data.action])
            .setTimestamp();

        const botUser = data.guild.client.user;
        const avatarURL = botUser?.displayAvatarURL() || undefined;

        await fetch(settings.logsWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [embed.toJSON()],
                username: 'PVC Logs',
                avatar_url: avatarURL,
            }),
        });
    } catch { }
}

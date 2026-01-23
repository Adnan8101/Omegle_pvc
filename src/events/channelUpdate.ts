import { Events, type GuildChannel, type DMChannel, ChannelType, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelState, getTeamChannelState } from '../utils/voiceManager';
import { getGuildSettings, getWhitelist } from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

export const name = Events.ChannelUpdate;
export const once = false;

interface ChannelSnapshot {
    userLimit: number;
    locked: boolean;
    hidden: boolean;
    timestamp: number;
}

const channelSnapshots = new Map<string, ChannelSnapshot>();
const recentBotEdits = new Map<string, number>();

const SNAPSHOT_EXPIRY = 30 * 60 * 1000;
const BOT_EDIT_WINDOW = 3000;

export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
}

export function updateChannelSnapshot(channelId: string, channel: GuildChannel): void {
    if (channel.type !== ChannelType.GuildVoice) return;
    
    const voiceChannel = channel as import('discord.js').VoiceChannel;
    const everyonePerms = voiceChannel.permissionOverwrites.cache.get(voiceChannel.guild.id);
    
    channelSnapshots.set(channelId, {
        userLimit: voiceChannel.userLimit,
        locked: everyonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false,
        hidden: everyonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false,
        timestamp: Date.now(),
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [channelId, snapshot] of channelSnapshots) {
        if (now - snapshot.timestamp > SNAPSHOT_EXPIRY) {
            channelSnapshots.delete(channelId);
        }
    }
    for (const [channelId, timestamp] of recentBotEdits) {
        if (now - timestamp > BOT_EDIT_WINDOW * 2) {
            recentBotEdits.delete(channelId);
        }
    }
}, 5 * 60 * 1000);

export async function execute(
    client: PVCClient,
    oldChannel: DMChannel | GuildChannel,
    newChannel: DMChannel | GuildChannel
): Promise<void> {
    if (!('guild' in oldChannel) || !('guild' in newChannel)) return;
    if (oldChannel.type !== ChannelType.GuildVoice) return;

    const channelId = newChannel.id;
    const guildId = newChannel.guild.id;

    const pvcState = getChannelState(channelId);
    const teamState = getTeamChannelState(channelId);

    if (!pvcState && !teamState) return;

    const isTeamChannel = Boolean(teamState);
    const ownerId = pvcState?.ownerId || teamState?.ownerId;

    const oldVoice = oldChannel as import('discord.js').VoiceChannel;
    const newVoice = newChannel as import('discord.js').VoiceChannel;

    const oldEveryonePerms = oldVoice.permissionOverwrites.cache.get(oldVoice.guild.id);
    const newEveryonePerms = newVoice.permissionOverwrites.cache.get(newVoice.guild.id);

    const oldLocked = oldEveryonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false;
    const newLocked = newEveryonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false;

    const oldHidden = oldEveryonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
    const newHidden = newEveryonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

    const oldLimit = oldVoice.userLimit;
    const newLimit = newVoice.userLimit;

    const limitIncreased = newLimit > oldLimit || (oldLimit > 0 && newLimit === 0);
    const wasUnlocked = oldLocked && !newLocked;
    const wasUnhidden = oldHidden && !newHidden;

    if (!limitIncreased && !wasUnlocked && !wasUnhidden) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < BOT_EDIT_WINDOW) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    let editorId: string | null = null;
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const auditLogs = await newVoice.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 5,
        });

        for (const entry of auditLogs.entries.values()) {
            if (entry.target?.id === channelId) {
                const timeDiff = Date.now() - entry.createdTimestamp;
                if (timeDiff < 5000) {
                    editorId = entry.executor?.id || null;
                    break;
                }
            }
        }
    } catch {
        return;
    }

    if (!editorId) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    if (editorId === client.user?.id) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    if (editorId === ownerId) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const [settings, whitelist] = await Promise.all([
        getGuildSettings(guildId),
        getWhitelist(guildId),
    ]);

    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: editorId } });
    if (isPvcOwner) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const editor = newVoice.guild.members.cache.get(editorId);
    const editorRoleIds = editor?.roles.cache.map(r => r.id) || [];

    if (settings?.staffRoleId && editorRoleIds.includes(settings.staffRoleId)) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const isWhitelisted = whitelist.some(
        w => w.targetId === editorId || editorRoleIds.includes(w.targetId)
    );
    if (isWhitelisted) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const changes: string[] = [];
    
    try {
        if (wasUnlocked) {
            await newVoice.permissionOverwrites.edit(newVoice.guild.id, {
                Connect: false,
            });
            changes.push('Lock reverted');
        }

        if (wasUnhidden) {
            await newVoice.permissionOverwrites.edit(newVoice.guild.id, {
                ViewChannel: false,
            });
            changes.push('Hide reverted');
        }

        if (limitIncreased) {
            await newVoice.setUserLimit(oldLimit);
            changes.push(`Limit reverted from ${newLimit === 0 ? 'unlimited' : newLimit} to ${oldLimit === 0 ? 'unlimited' : oldLimit}`);
        }

        logAction({
            action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
            guild: newVoice.guild,
            user: editor?.user,
            channelName: newVoice.name,
            channelId: channelId,
            details: `Changes attempted by <@${editorId}>:\n` +
                changes.map(c => `• ${c}`).join('\n') +
                `\n\nOnly the channel owner or authorized staff can modify PVC settings.`,
            isTeamChannel: isTeamChannel,
            teamType: teamState?.teamType,
        }).catch(() => {});

    } catch (error) {
        console.error('Failed to revert channel changes:', error);
    }
}

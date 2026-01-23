import { Events, type GuildChannel, type DMChannel, ChannelType, AuditLogEvent, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import type { PVCClient } from '../client';
import { getChannelState, getTeamChannelState } from '../utils/voiceManager';
import { getWhitelist, getChannelPermissions } from '../utils/cache';
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

    // Check if this was a bot edit (instant check, no delay)
    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < BOT_EDIT_WINDOW) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // INSTANT REVERT - Don't wait for audit logs, revert immediately
    recordBotEdit(channelId);
    const changes: string[] = [];
    
    const revertPromises: Promise<any>[] = [];
    
    if (wasUnlocked) {
        revertPromises.push(
            newVoice.permissionOverwrites.edit(newVoice.guild.id, { Connect: false })
        );
        changes.push('Unlock reverted');
    }

    if (wasUnhidden) {
        revertPromises.push(
            newVoice.permissionOverwrites.edit(newVoice.guild.id, { ViewChannel: false })
        );
        changes.push('Unhide reverted');
    }

    if (limitIncreased) {
        revertPromises.push(newVoice.setUserLimit(oldLimit));
        changes.push(`Limit reverted (${newLimit} → ${oldLimit})`);
    }

    // Execute all reverts in parallel for maximum speed
    await Promise.allSettled(revertPromises);

    // Now fetch audit logs to identify the editor (non-blocking for revert)
    let editorId: string | null = null;
    try {
        const auditLogs = await newVoice.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 5,
        });

        for (const entry of auditLogs.entries.values()) {
            if (entry.target?.id === channelId) {
                const timeDiff = Date.now() - entry.createdTimestamp;
                if (timeDiff < 15000) {
                    editorId = entry.executor?.id || null;
                    break;
                }
            }
        }
    } catch { }

    // Check if the editor was actually authorized (if so, we reverted wrongly - undo)
    if (editorId) {
        // Bot itself
        if (editorId === client.user?.id) {
            // Undo the revert - bot made the change
            return;
        }

        // Channel owner
        if (editorId === ownerId) {
            // Owner made the change - undo revert
            const undoPromises: Promise<any>[] = [];
            if (wasUnlocked) {
                undoPromises.push(newVoice.permissionOverwrites.edit(newVoice.guild.id, { Connect: null }));
            }
            if (wasUnhidden) {
                undoPromises.push(newVoice.permissionOverwrites.edit(newVoice.guild.id, { ViewChannel: null }));
            }
            if (limitIncreased) {
                undoPromises.push(newVoice.setUserLimit(newLimit));
            }
            await Promise.allSettled(undoPromises);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }

        // Check whitelist
        const whitelist = await getWhitelist(guildId);
        const editor = newVoice.guild.members.cache.get(editorId);
        const editorRoleIds = editor?.roles.cache.map(r => r.id) || [];

        const isWhitelisted = whitelist.some(
            w => w.targetId === editorId || editorRoleIds.includes(w.targetId)
        );
        
        if (isWhitelisted) {
            // Whitelisted user - undo revert
            const undoPromises: Promise<any>[] = [];
            if (wasUnlocked) {
                undoPromises.push(newVoice.permissionOverwrites.edit(newVoice.guild.id, { Connect: null }));
            }
            if (wasUnhidden) {
                undoPromises.push(newVoice.permissionOverwrites.edit(newVoice.guild.id, { ViewChannel: null }));
            }
            if (limitIncreased) {
                undoPromises.push(newVoice.setUserLimit(newLimit));
            }
            await Promise.allSettled(undoPromises);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }
    }

    // If we reach here, the change was unauthorized - revert stands
    
    // Kick unauthorized users who may have joined during exploit
    if (wasUnlocked || wasUnhidden || limitIncreased) {
        const channelPerms = await getChannelPermissions(channelId);
        const permittedUserIds = new Set(
            channelPerms
                .filter(p => p.permission === 'permit' && p.targetType === 'user')
                .map(p => p.targetId)
        );
        permittedUserIds.add(ownerId!);

        const kickPromises: Promise<any>[] = [];
        for (const [memberId, member] of newVoice.members) {
            if (!permittedUserIds.has(memberId) && memberId !== client.user?.id) {
                kickPromises.push(member.voice.disconnect().catch(() => {}));
            }
        }
        await Promise.allSettled(kickPromises);
    }

    // Send warning to VC text chat
    if (ownerId && editorId) {
        const warningEmbed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('⚠️ PVC Manipulation Detected')
            .setDescription(
                `<@${editorId}> tried to manipulate your voice channel.\n\n` +
                `**Changes attempted:**\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
                `This is a power abuse case. Please report to senior staff ASAP.`
            )
            .setTimestamp();

        newVoice.send({
            content: `<@${ownerId}>`,
            embeds: [warningEmbed],
        }).catch(() => {});
    }

    // Log action
    const editor = editorId ? newVoice.guild.members.cache.get(editorId) : null;
    logAction({
        action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
        guild: newVoice.guild,
        user: editor?.user,
        channelName: newVoice.name,
        channelId: channelId,
        details: editorId 
            ? `Changes attempted by <@${editorId}>:\n${changes.map(c => `• ${c}`).join('\n')}`
            : `Unauthorized changes detected:\n${changes.map(c => `• ${c}`).join('\n')}`,
        isTeamChannel: isTeamChannel,
        teamType: teamState?.teamType,
    }).catch(() => {});
}

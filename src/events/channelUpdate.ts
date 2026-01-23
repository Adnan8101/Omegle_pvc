import { Events, type GuildChannel, type DMChannel, ChannelType, AuditLogEvent, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import type { PVCClient } from '../client';
import { getChannelState, getTeamChannelState } from '../utils/voiceManager';
import { getWhitelist, getChannelPermissions } from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

export const name = Events.ChannelUpdate;
export const once = false;

interface ChannelSnapshot {
    name: string;
    userLimit: number;
    bitrate: number;
    rtcRegion: string | null;
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
    
    const vc = channel as import('discord.js').VoiceChannel;
    const everyonePerms = vc.permissionOverwrites.cache.get(vc.guild.id);
    
    channelSnapshots.set(channelId, {
        name: vc.name,
        userLimit: vc.userLimit,
        bitrate: vc.bitrate,
        rtcRegion: vc.rtcRegion,
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

    const oldVc = oldChannel as import('discord.js').VoiceChannel;
    const newVc = newChannel as import('discord.js').VoiceChannel;

    // Check if this was a bot edit
    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < BOT_EDIT_WINDOW) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const oldEveryonePerms = oldVc.permissionOverwrites.cache.get(oldVc.guild.id);
    const newEveryonePerms = newVc.permissionOverwrites.cache.get(newVc.guild.id);

    const oldLocked = oldEveryonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false;
    const newLocked = newEveryonePerms?.deny.has(PermissionFlagsBits.Connect) ?? false;

    const oldHidden = oldEveryonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
    const newHidden = newEveryonePerms?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

    // Detect ALL changes
    const changes: string[] = [];
    const revertActions: (() => Promise<any>)[] = [];

    // Name change
    if (oldVc.name !== newVc.name) {
        changes.push(`Name: "${newVc.name}" → "${oldVc.name}"`);
        revertActions.push(() => newVc.setName(oldVc.name));
    }

    // User limit change
    if (oldVc.userLimit !== newVc.userLimit) {
        changes.push(`Limit: ${newVc.userLimit || 'unlimited'} → ${oldVc.userLimit || 'unlimited'}`);
        revertActions.push(() => newVc.setUserLimit(oldVc.userLimit));
    }

    // Bitrate change
    if (oldVc.bitrate !== newVc.bitrate) {
        changes.push(`Bitrate: ${newVc.bitrate / 1000}kbps → ${oldVc.bitrate / 1000}kbps`);
        revertActions.push(() => newVc.setBitrate(oldVc.bitrate));
    }

    // Region change
    if (oldVc.rtcRegion !== newVc.rtcRegion) {
        changes.push(`Region: ${newVc.rtcRegion || 'auto'} → ${oldVc.rtcRegion || 'auto'}`);
        revertActions.push(() => newVc.setRTCRegion(oldVc.rtcRegion));
    }

    // Lock/Unlock
    if (oldLocked !== newLocked) {
        if (newLocked) {
            changes.push('Locked');
            revertActions.push(() => newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: null }));
        } else {
            changes.push('Unlocked');
            revertActions.push(() => newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: false }));
        }
    }

    // Hide/Unhide
    if (oldHidden !== newHidden) {
        if (newHidden) {
            changes.push('Hidden');
            revertActions.push(() => newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: null }));
        } else {
            changes.push('Unhidden');
            revertActions.push(() => newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: false }));
        }
    }

    // No changes detected
    if (changes.length === 0) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // INSTANT REVERT first
    recordBotEdit(channelId);
    await Promise.allSettled(revertActions.map(action => action()));

    // Now fetch audit logs to identify who made the change
    let editorId: string | null = null;
    try {
        const auditLogs = await newVc.guild.fetchAuditLogs({
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

    // Check if editor was authorized - if so, undo the revert
    if (editorId) {
        if (editorId === client.user?.id) {
            return;
        }

        // Channel owner - undo revert
        if (editorId === ownerId) {
            recordBotEdit(channelId);
            const undoActions: Promise<any>[] = [];
            if (oldVc.name !== newVc.name) undoActions.push(newVc.setName(newVc.name));
            if (oldVc.userLimit !== newVc.userLimit) undoActions.push(newVc.setUserLimit(newVc.userLimit));
            if (oldVc.bitrate !== newVc.bitrate) undoActions.push(newVc.setBitrate(newVc.bitrate));
            if (oldVc.rtcRegion !== newVc.rtcRegion) undoActions.push(newVc.setRTCRegion(newVc.rtcRegion));
            if (oldLocked !== newLocked) {
                undoActions.push(newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: newLocked ? false : null }));
            }
            if (oldHidden !== newHidden) {
                undoActions.push(newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: newHidden ? false : null }));
            }
            await Promise.allSettled(undoActions);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }

        // Check whitelist
        const whitelist = await getWhitelist(guildId);
        const editor = newVc.guild.members.cache.get(editorId);
        const editorRoleIds = editor?.roles.cache.map(r => r.id) || [];

        const isWhitelisted = whitelist.some(
            w => w.targetId === editorId || editorRoleIds.includes(w.targetId)
        );
        
        if (isWhitelisted) {
            recordBotEdit(channelId);
            const undoActions: Promise<any>[] = [];
            if (oldVc.name !== newVc.name) undoActions.push(newVc.setName(newVc.name));
            if (oldVc.userLimit !== newVc.userLimit) undoActions.push(newVc.setUserLimit(newVc.userLimit));
            if (oldVc.bitrate !== newVc.bitrate) undoActions.push(newVc.setBitrate(newVc.bitrate));
            if (oldVc.rtcRegion !== newVc.rtcRegion) undoActions.push(newVc.setRTCRegion(newVc.rtcRegion));
            if (oldLocked !== newLocked) {
                undoActions.push(newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: newLocked ? false : null }));
            }
            if (oldHidden !== newHidden) {
                undoActions.push(newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: newHidden ? false : null }));
            }
            await Promise.allSettled(undoActions);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }
    }

    // Unauthorized - kick intruders if security was compromised
    const wasUnlocked = oldLocked && !newLocked;
    const wasUnhidden = oldHidden && !newHidden;
    const limitIncreased = newVc.userLimit > oldVc.userLimit || (oldVc.userLimit > 0 && newVc.userLimit === 0);

    if (wasUnlocked || wasUnhidden || limitIncreased) {
        const channelPerms = await getChannelPermissions(channelId);
        const permittedUserIds = new Set(
            channelPerms
                .filter(p => p.permission === 'permit' && p.targetType === 'user')
                .map(p => p.targetId)
        );
        permittedUserIds.add(ownerId!);

        const kickPromises: Promise<any>[] = [];
        for (const [memberId, member] of newVc.members) {
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

        newVc.send({
            content: `<@${ownerId}>`,
            embeds: [warningEmbed],
        }).catch(() => {});
    }

    // Log action
    const editor = editorId ? newVc.guild.members.cache.get(editorId) : null;
    logAction({
        action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
        guild: newVc.guild,
        user: editor?.user,
        channelName: newVc.name,
        channelId: channelId,
        details: editorId 
            ? `Changes attempted by <@${editorId}>:\n${changes.map(c => `• ${c}`).join('\n')}`
            : `Unauthorized changes detected:\n${changes.map(c => `• ${c}`).join('\n')}`,
        isTeamChannel: isTeamChannel,
        teamType: teamState?.teamType,
    }).catch(() => {});
}

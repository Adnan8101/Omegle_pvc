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

    console.log(`[ChannelUpdate] Channel ${channelId} updated in guild ${guildId}`);

    const pvcState = getChannelState(channelId);
    const teamState = getTeamChannelState(channelId);

    if (!pvcState && !teamState) {
        console.log(`[ChannelUpdate] Channel ${channelId} is not a PVC or Team channel, skipping`);
        return;
    }

    console.log(`[ChannelUpdate] Channel is ${pvcState ? 'PVC' : 'Team'} channel, owner: ${pvcState?.ownerId || teamState?.ownerId}`);

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

    console.log(`[ChannelUpdate] Old state - locked: ${oldLocked}, hidden: ${oldHidden}, limit: ${oldLimit}`);
    console.log(`[ChannelUpdate] New state - locked: ${newLocked}, hidden: ${newHidden}, limit: ${newLimit}`);

    const limitIncreased = newLimit > oldLimit || (oldLimit > 0 && newLimit === 0);
    const wasUnlocked = oldLocked && !newLocked;
    const wasUnhidden = oldHidden && !newHidden;

    console.log(`[ChannelUpdate] Changes detected - limitIncreased: ${limitIncreased}, wasUnlocked: ${wasUnlocked}, wasUnhidden: ${wasUnhidden}`);

    if (!limitIncreased && !wasUnlocked && !wasUnhidden) {
        console.log(`[ChannelUpdate] No security-relevant changes detected, updating snapshot and returning`);
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < BOT_EDIT_WINDOW) {
        console.log(`[ChannelUpdate] Recent bot edit detected, allowing change`);
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    let editorId: string | null = null;
    try {
        console.log(`[ChannelUpdate] Fetching audit logs...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const auditLogs = await newVoice.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 10,
        });

        console.log(`[ChannelUpdate] Found ${auditLogs.entries.size} audit log entries`);

        for (const entry of auditLogs.entries.values()) {
            console.log(`[ChannelUpdate] Audit entry - target: ${entry.target?.id}, executor: ${entry.executor?.id}, time diff: ${Date.now() - entry.createdTimestamp}ms`);
            if (entry.target?.id === channelId) {
                const timeDiff = Date.now() - entry.createdTimestamp;
                if (timeDiff < 10000) {
                    editorId = entry.executor?.id || null;
                    console.log(`[ChannelUpdate] Found editor: ${editorId}`);
                    break;
                }
            }
        }
    } catch (err) {
        console.log(`[ChannelUpdate] Failed to fetch audit logs:`, err);
    }

    console.log(`[ChannelUpdate] Editor ID: ${editorId}`);

    // If editor is the bot itself, allow it
    if (editorId === client.user?.id) {
        console.log(`[ChannelUpdate] Editor is bot, allowing`);
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // If editor is the channel owner, allow it
    if (editorId === ownerId) {
        console.log(`[ChannelUpdate] Editor is channel owner, allowing`);
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // Only check permissions if we know who the editor is
    if (editorId) {
        const whitelist = await getWhitelist(guildId);

        const editor = newVoice.guild.members.cache.get(editorId);
        const editorRoleIds = editor?.roles.cache.map(r => r.id) || [];

        console.log(`[ChannelUpdate] Checking whitelist. Editor roles: ${editorRoleIds.join(', ')}`);
        console.log(`[ChannelUpdate] Whitelist entries: ${whitelist.map(w => `${w.targetId} (${w.targetType})`).join(', ')}`);

        const isWhitelisted = whitelist.some(
            w => w.targetId === editorId || editorRoleIds.includes(w.targetId)
        );
        if (isWhitelisted) {
            console.log(`[ChannelUpdate] Editor is whitelisted, allowing`);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }
    }

    console.log(`[ChannelUpdate] UNAUTHORIZED CHANGE DETECTED! Reverting...`);

    // If we reach here, the change is unauthorized - revert it
    const changes: string[] = [];
    const editor = editorId ? newVoice.guild.members.cache.get(editorId) : null;
    
    try {
        recordBotEdit(channelId);
        
        if (wasUnlocked) {
            await newVoice.permissionOverwrites.edit(newVoice.guild.id, {
                Connect: false,
            });
            changes.push('Lock reverted');
            console.log(`[ChannelUpdate] Reverted unlock`);
        }

        if (wasUnhidden) {
            await newVoice.permissionOverwrites.edit(newVoice.guild.id, {
                ViewChannel: false,
            });
            changes.push('Hide reverted');
            console.log(`[ChannelUpdate] Reverted unhide`);
        }

        if (limitIncreased) {
            await newVoice.setUserLimit(oldLimit);
            changes.push(`Limit reverted from ${newLimit === 0 ? 'unlimited' : newLimit} to ${oldLimit === 0 ? 'unlimited' : oldLimit}`);
            console.log(`[ChannelUpdate] Reverted limit from ${newLimit} to ${oldLimit}`);
        }

        console.log(`[ChannelUpdate] All changes reverted: ${changes.join(', ')}`);

        // Kick unauthorized users who joined during the exploit window
        if (wasUnlocked || wasUnhidden || limitIncreased) {
            const channelPerms = await getChannelPermissions(channelId);
            const permittedUserIds = new Set(
                channelPerms
                    .filter(p => p.permission === 'permit' && p.targetType === 'user')
                    .map(p => p.targetId)
            );
            permittedUserIds.add(ownerId!); // Owner is always permitted

            for (const [memberId, member] of newVoice.members) {
                if (!permittedUserIds.has(memberId) && memberId !== client.user?.id) {
                    try {
                        await member.voice.disconnect();
                        console.log(`[ChannelUpdate] Kicked unauthorized user ${memberId} who joined during exploit`);
                    } catch {
                        console.log(`[ChannelUpdate] Failed to kick user ${memberId}`);
                    }
                }
            }
        }

        // Notify the channel owner about the manipulation attempt
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

            try {
                await newVoice.send({
                    content: `<@${ownerId}>`,
                    embeds: [warningEmbed],
                });
                console.log(`[ChannelUpdate] Sent warning to channel owner ${ownerId}`);
            } catch {
                console.log(`[ChannelUpdate] Failed to send warning to VC text chat`);
            }
        }

        logAction({
            action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
            guild: newVoice.guild,
            user: editor?.user,
            channelName: newVoice.name,
            channelId: channelId,
            details: editorId 
                ? `Changes attempted by <@${editorId}>:\n` +
                  changes.map(c => `• ${c}`).join('\n')
                : `Unauthorized changes detected:\n` +
                  changes.map(c => `• ${c}`).join('\n'),
            isTeamChannel: isTeamChannel,
            teamType: teamState?.teamType,
        }).catch(() => {});

    } catch (error) {
        console.error('Failed to revert channel changes:', error);
    }
}

import { Events, type GuildChannel, type DMChannel, ChannelType, AuditLogEvent, PermissionFlagsBits, EmbedBuilder, OverwriteType, PermissionsBitField } from 'discord.js';
import type { PVCClient } from '../client';
import { getChannelState, getTeamChannelState } from '../utils/voiceManager';
import { getWhitelist, getChannelPermissions } from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

export const name = Events.ChannelUpdate;
export const once = false;

interface PermissionOverwriteSnapshot {
    id: string;
    type: OverwriteType;
    allow: bigint;
    deny: bigint;
}

interface ChannelSnapshot {
    name: string;
    userLimit: number;
    bitrate: number;
    rtcRegion: string | null;
    nsfw: boolean;
    rateLimitPerUser: number;
    videoQualityMode: number;
    permissionOverwrites: Map<string, PermissionOverwriteSnapshot>;
    timestamp: number;
}

const channelSnapshots = new Map<string, ChannelSnapshot>();
const recentBotEdits = new Map<string, number>();
const revertInProgress = new Set<string>();

const SNAPSHOT_EXPIRY = 30 * 60 * 1000;
const BOT_EDIT_WINDOW = 5000; // Increased for reliability

export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
}

export function updateChannelSnapshot(channelId: string, channel: GuildChannel): void {
    if (channel.type !== ChannelType.GuildVoice) return;
    
    const vc = channel as import('discord.js').VoiceChannel;
    
    // Store ALL permission overwrites
    const permOverwrites = new Map<string, PermissionOverwriteSnapshot>();
    for (const [id, overwrite] of vc.permissionOverwrites.cache) {
        permOverwrites.set(id, {
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield,
            deny: overwrite.deny.bitfield,
        });
    }
    
    channelSnapshots.set(channelId, {
        name: vc.name,
        userLimit: vc.userLimit,
        bitrate: vc.bitrate,
        rtcRegion: vc.rtcRegion,
        nsfw: vc.nsfw,
        rateLimitPerUser: vc.rateLimitPerUser || 0,
        videoQualityMode: vc.videoQualityMode || 1,
        permissionOverwrites: permOverwrites,
        timestamp: Date.now(),
    });
}

export function getChannelSnapshot(channelId: string): ChannelSnapshot | undefined {
    return channelSnapshots.get(channelId);
}

// Cleanup interval - runs more frequently
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
}, 60 * 1000);

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

    // Prevent concurrent reverts
    if (revertInProgress.has(channelId)) {
        return;
    }

    const isTeamChannel = Boolean(teamState);
    const ownerId = pvcState?.ownerId || teamState?.ownerId;

    const oldVc = oldChannel as import('discord.js').VoiceChannel;
    const newVc = newChannel as import('discord.js').VoiceChannel;

    // Check if this was a bot edit (MUST be checked BEFORE any processing)
    const botEditTime = recentBotEdits.get(channelId);
    const isBotEdit = botEditTime && Date.now() - botEditTime < BOT_EDIT_WINDOW;
    
    if (isBotEdit) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // Get old permission states
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
        changes.push(`Name: "${oldVc.name}" → "${newVc.name}"`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setName(oldVc.name);
        });
    }

    // User limit change
    if (oldVc.userLimit !== newVc.userLimit) {
        changes.push(`Limit: ${oldVc.userLimit || 'unlimited'} → ${newVc.userLimit || 'unlimited'}`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setUserLimit(oldVc.userLimit);
        });
    }

    // Bitrate change
    if (oldVc.bitrate !== newVc.bitrate) {
        changes.push(`Bitrate: ${oldVc.bitrate / 1000}kbps → ${newVc.bitrate / 1000}kbps`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setBitrate(oldVc.bitrate);
        });
    }

    // Region change
    if (oldVc.rtcRegion !== newVc.rtcRegion) {
        changes.push(`Region: ${oldVc.rtcRegion || 'auto'} → ${newVc.rtcRegion || 'auto'}`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setRTCRegion(oldVc.rtcRegion);
        });
    }

    // NSFW change
    if (oldVc.nsfw !== newVc.nsfw) {
        changes.push(`NSFW: ${oldVc.nsfw ? 'ON' : 'OFF'} → ${newVc.nsfw ? 'ON' : 'OFF'}`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setNSFW(oldVc.nsfw);
        });
    }

    // Slowmode change
    if ((oldVc.rateLimitPerUser || 0) !== (newVc.rateLimitPerUser || 0)) {
        changes.push(`Slowmode: ${oldVc.rateLimitPerUser || 0}s → ${newVc.rateLimitPerUser || 0}s`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setRateLimitPerUser(oldVc.rateLimitPerUser || 0);
        });
    }

    // Video quality mode change
    if ((oldVc.videoQualityMode || 1) !== (newVc.videoQualityMode || 1)) {
        const qualityNames: Record<number, string> = { 1: 'Auto', 2: '720p' };
        changes.push(`Video Quality: ${qualityNames[oldVc.videoQualityMode || 1] || 'Auto'} → ${qualityNames[newVc.videoQualityMode || 1] || 'Auto'}`);
        revertActions.push(async () => {
            recordBotEdit(channelId);
            await newVc.setVideoQualityMode(oldVc.videoQualityMode || 1);
        });
    }

    // Lock/Unlock (permission changes)
    if (oldLocked !== newLocked) {
        if (newLocked) {
            changes.push('Channel was locked (by external edit)');
            revertActions.push(async () => {
                recordBotEdit(channelId);
                await newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: null });
            });
        } else {
            changes.push('Channel was unlocked (by external edit)');
            revertActions.push(async () => {
                recordBotEdit(channelId);
                await newVc.permissionOverwrites.edit(newVc.guild.id, { Connect: false });
            });
        }
    }

    // Hide/Unhide (permission changes)
    if (oldHidden !== newHidden) {
        if (newHidden) {
            changes.push('Channel was hidden (by external edit)');
            revertActions.push(async () => {
                recordBotEdit(channelId);
                await newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: null });
            });
        } else {
            changes.push('Channel was unhidden (by external edit)');
            revertActions.push(async () => {
                recordBotEdit(channelId);
                await newVc.permissionOverwrites.edit(newVc.guild.id, { ViewChannel: false });
            });
        }
    }

    // Check for other permission overwrite changes (non-@everyone)
    const permissionChanges = detectPermissionOverwriteChanges(oldVc, newVc, ownerId!, guildId);
    if (permissionChanges.changes.length > 0) {
        changes.push(...permissionChanges.changes);
        revertActions.push(...permissionChanges.revertActions.map(action => async () => {
            recordBotEdit(channelId);
            await action();
        }));
    }

    // No changes detected
    if (changes.length === 0) {
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // Mark revert in progress to prevent race conditions
    revertInProgress.add(channelId);

    // Fetch audit logs FIRST to identify who made the change
    // Try multiple audit log types since Discord uses different ones
    let editorId: string | null = null;
    try {
        // Try ChannelUpdate first
        const auditLogs = await newVc.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 15,
        });

        for (const entry of auditLogs.entries.values()) {
            if (entry.target?.id === channelId) {
                const timeDiff = Date.now() - entry.createdTimestamp;
                if (timeDiff < 60000) { // 60 seconds window for audit log delay
                    editorId = entry.executor?.id || null;
                    console.log(`[ChannelUpdate] Found editor ${editorId} from ChannelUpdate audit log (${timeDiff}ms ago)`);
                    break;
                }
            }
        }

        // If not found, try ChannelOverwriteUpdate (for permission changes)
        if (!editorId) {
            const overwriteLogs = await newVc.guild.fetchAuditLogs({
                type: AuditLogEvent.ChannelOverwriteUpdate,
                limit: 15,
            });

            for (const entry of overwriteLogs.entries.values()) {
                if (entry.target?.id === channelId) {
                    const timeDiff = Date.now() - entry.createdTimestamp;
                    if (timeDiff < 60000) {
                        editorId = entry.executor?.id || null;
                        console.log(`[ChannelUpdate] Found editor ${editorId} from ChannelOverwriteUpdate audit log (${timeDiff}ms ago)`);
                        break;
                    }
                }
            }
        }

        // Also try ChannelOverwriteCreate and ChannelOverwriteDelete
        if (!editorId) {
            const createLogs = await newVc.guild.fetchAuditLogs({
                type: AuditLogEvent.ChannelOverwriteCreate,
                limit: 10,
            });

            for (const entry of createLogs.entries.values()) {
                if (entry.target?.id === channelId) {
                    const timeDiff = Date.now() - entry.createdTimestamp;
                    if (timeDiff < 60000) {
                        editorId = entry.executor?.id || null;
                        console.log(`[ChannelUpdate] Found editor ${editorId} from ChannelOverwriteCreate audit log (${timeDiff}ms ago)`);
                        break;
                    }
                }
            }
        }

        if (!editorId) {
            const deleteLogs = await newVc.guild.fetchAuditLogs({
                type: AuditLogEvent.ChannelOverwriteDelete,
                limit: 10,
            });

            for (const entry of deleteLogs.entries.values()) {
                if (entry.target?.id === channelId) {
                    const timeDiff = Date.now() - entry.createdTimestamp;
                    if (timeDiff < 60000) {
                        editorId = entry.executor?.id || null;
                        console.log(`[ChannelUpdate] Found editor ${editorId} from ChannelOverwriteDelete audit log (${timeDiff}ms ago)`);
                        break;
                    }
                }
            }
        }

        if (!editorId) {
            console.log(`[ChannelUpdate] Could not find editor in audit logs for channel ${channelId}`);
        }
    } catch (err) {
        console.error('[ChannelUpdate] Failed to fetch audit logs:', err);
    }

    // Check if editor was authorized
    let isAuthorized = false;
    
    if (editorId) {
        // Bot's own edits should have been caught by recordBotEdit
        if (editorId === client.user?.id) {
            console.log(`[ChannelUpdate] Ignoring bot's own edit on ${channelId}`);
            revertInProgress.delete(channelId);
            updateChannelSnapshot(channelId, newChannel);
            return;
        }

        // Channel owner is always authorized
        if (editorId === ownerId) {
            console.log(`[ChannelUpdate] Owner ${editorId} editing their own channel ${channelId} - authorized`);
            isAuthorized = true;
        }

        // Check whitelist
        if (!isAuthorized) {
            const whitelist = await getWhitelist(guildId);
            console.log(`[ChannelUpdate] Whitelist for guild ${guildId}:`, JSON.stringify(whitelist));
            
            const editor = newVc.guild.members.cache.get(editorId);
            const editorRoleIds = editor?.roles.cache.map(r => r.id) || [];
            console.log(`[ChannelUpdate] Editor ${editorId} has roles:`, editorRoleIds);

            const matchedEntry = whitelist.find(
                w => w.targetId === editorId || editorRoleIds.includes(w.targetId)
            );
            
            if (matchedEntry) {
                console.log(`[ChannelUpdate] Editor ${editorId} is whitelisted via ${matchedEntry.targetId} (${matchedEntry.targetType}) - authorized`);
                isAuthorized = true;
            } else {
                console.log(`[ChannelUpdate] Editor ${editorId} is NOT in whitelist - unauthorized`);
            }
        }
    } else {
        console.log(`[ChannelUpdate] Could not identify editor for ${channelId}`);
    }

    // If authorized, allow the change
    if (isAuthorized) {
        console.log(`[ChannelUpdate] Change authorized - updating snapshot for ${channelId}`);
        revertInProgress.delete(channelId);
        updateChannelSnapshot(channelId, newChannel);
        return;
    }

    // UNAUTHORIZED - REVERT IMMEDIATELY
    console.log(`[ChannelUpdate] Reverting unauthorized changes to ${channelId} by ${editorId || 'unknown'}: ${changes.join(', ')}`);

    try {
        // Execute all revert actions sequentially to avoid rate limits
        for (const action of revertActions) {
            try {
                await action();
            } catch (err) {
                console.error('[ChannelUpdate] Revert action failed:', err);
            }
        }

        // Kick intruders if security was compromised OR if channel should be locked/hidden
        // This closes the loophole where users join during the brief unlock window
        const wasUnlocked = oldLocked && !newLocked;
        const wasUnhidden = oldHidden && !newHidden;
        const limitIncreased = newVc.userLimit > oldVc.userLimit || (oldVc.userLimit > 0 && newVc.userLimit === 0);
        
        // ALWAYS kick unauthorized users if the channel was supposed to be locked or hidden
        // This ensures anyone who entered during the brief exploit window is removed
        if (wasUnlocked || wasUnhidden || limitIncreased || oldLocked || oldHidden) {
            console.log(`[ChannelUpdate] Kicking unauthorized users from ${channelId} (oldLocked=${oldLocked}, oldHidden=${oldHidden}, wasUnlocked=${wasUnlocked}, wasUnhidden=${wasUnhidden})`);
            await kickUnauthorizedUsers(newVc, ownerId!, client);
        }

        // Send warning to VC text chat - always send even if editor is unknown
        if (ownerId) {
            await sendWarningToVcChat(newVc, ownerId, editorId || null, changes);
        }

        // Log action
        await sendUnauthorizedChangeLog(newVc, editorId, changes, isTeamChannel, teamState?.teamType);

    } catch (err) {
        console.error('[ChannelUpdate] Failed to revert changes:', err);
    } finally {
        revertInProgress.delete(channelId);
        updateChannelSnapshot(channelId, newChannel);
    }
}

function detectPermissionOverwriteChanges(
    oldVc: import('discord.js').VoiceChannel,
    newVc: import('discord.js').VoiceChannel,
    ownerId: string,
    guildId: string
): { changes: string[]; revertActions: (() => Promise<any>)[] } {
    const changes: string[] = [];
    const revertActions: (() => Promise<any>)[] = [];

    const oldOverwrites = oldVc.permissionOverwrites.cache;
    const newOverwrites = newVc.permissionOverwrites.cache;

    // Find removed overwrites (except @everyone which is handled separately)
    for (const [id, oldOverwrite] of oldOverwrites) {
        if (id === guildId) continue; // Skip @everyone
        if (id === ownerId) continue; // Skip owner perms
        
        if (!newOverwrites.has(id)) {
            const targetType = oldOverwrite.type === OverwriteType.Role ? 'Role' : 'User';
            const mention = oldOverwrite.type === OverwriteType.Role ? `<@&${id}>` : `<@${id}>`;
            changes.push(`${targetType} permission removed: ${mention}`);
            
            revertActions.push(async () => {
                // Restore the old permission overwrite
                const permUpdate: Record<string, boolean | null> = {};
                const allowBits = new PermissionsBitField(oldOverwrite.allow.bitfield);
                const denyBits = new PermissionsBitField(oldOverwrite.deny.bitfield);
                
                for (const [perm, value] of Object.entries(PermissionFlagsBits)) {
                    const bigIntValue = value as bigint;
                    if (allowBits.has(bigIntValue)) {
                        permUpdate[perm] = true;
                    } else if (denyBits.has(bigIntValue)) {
                        permUpdate[perm] = false;
                    }
                }
                
                await newVc.permissionOverwrites.edit(id, permUpdate, {
                    type: oldOverwrite.type,
                });
            });
        }
    }

    // Find added overwrites
    for (const [id, newOverwrite] of newOverwrites) {
        if (id === guildId) continue;
        if (id === ownerId) continue;
        
        if (!oldOverwrites.has(id)) {
            const targetType = newOverwrite.type === OverwriteType.Role ? 'Role' : 'User';
            const mention = newOverwrite.type === OverwriteType.Role ? `<@&${id}>` : `<@${id}>`;
            changes.push(`${targetType} permission added: ${mention}`);
            
            revertActions.push(async () => {
                await newVc.permissionOverwrites.delete(id);
            });
        }
    }

    // Find modified overwrites
    for (const [id, newOverwrite] of newOverwrites) {
        if (id === guildId) continue;
        if (id === ownerId) continue;
        
        const oldOverwrite = oldOverwrites.get(id);
        if (!oldOverwrite) continue;

        const allowChanged = oldOverwrite.allow.bitfield !== newOverwrite.allow.bitfield;
        const denyChanged = oldOverwrite.deny.bitfield !== newOverwrite.deny.bitfield;

        if (allowChanged || denyChanged) {
            const targetType = newOverwrite.type === OverwriteType.Role ? 'Role' : 'User';
            const mention = newOverwrite.type === OverwriteType.Role ? `<@&${id}>` : `<@${id}>`;
            changes.push(`${targetType} permission modified: ${mention}`);
            
            revertActions.push(async () => {
                const permUpdate: Record<string, boolean | null> = {};
                const allowBits = new PermissionsBitField(oldOverwrite.allow.bitfield);
                const denyBits = new PermissionsBitField(oldOverwrite.deny.bitfield);
                
                for (const [perm, value] of Object.entries(PermissionFlagsBits)) {
                    const bigIntValue = value as bigint;
                    if (allowBits.has(bigIntValue)) {
                        permUpdate[perm] = true;
                    } else if (denyBits.has(bigIntValue)) {
                        permUpdate[perm] = false;
                    } else {
                        permUpdate[perm] = null;
                    }
                }
                await newVc.permissionOverwrites.edit(id, permUpdate);
            });
        }
    }

    return { changes, revertActions };
}

async function kickUnauthorizedUsers(
    vc: import('discord.js').VoiceChannel,
    ownerId: string,
    client: PVCClient
): Promise<void> {
    const channelPerms = await getChannelPermissions(vc.id);
    const permittedUserIds = new Set(
        channelPerms
            .filter(p => p.permission === 'permit' && p.targetType === 'user')
            .map(p => p.targetId)
    );
    permittedUserIds.add(ownerId);

    const kickPromises: Promise<any>[] = [];
    for (const [memberId, member] of vc.members) {
        if (!permittedUserIds.has(memberId) && memberId !== client.user?.id) {
            console.log(`[ChannelUpdate] Kicking unauthorized user ${memberId} from ${vc.id}`);
            kickPromises.push(
                member.voice.disconnect()
                    .catch(err => console.error(`[ChannelUpdate] Failed to kick ${memberId}:`, err))
            );
        }
    }
    
    if (kickPromises.length > 0) {
        await Promise.allSettled(kickPromises);
    }
}

async function sendWarningToVcChat(
    vc: import('discord.js').VoiceChannel,
    ownerId: string,
    editorId: string | null,
    changes: string[]
): Promise<void> {
    const editorText = editorId ? `<@${editorId}>` : 'Someone (unable to identify)';
    
    const warningEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('⚠️ PVC Manipulation Detected & Reverted')
        .setDescription(
            `${editorText} tried to manipulate your voice channel settings.\n\n` +
            `**Changes attempted:**\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
            `**All changes have been automatically reverted.**\n\n` +
            `This may be power abuse. Please report to senior staff if needed.`
        )
        .setTimestamp();

    try {
        await vc.send({
            content: `<@${ownerId}>`,
            embeds: [warningEmbed],
        });
        console.log(`[ChannelUpdate] Warning sent to VC chat for ${vc.id}`);
    } catch (err) {
        console.error(`[ChannelUpdate] Failed to send warning to VC chat ${vc.id}:`, err);
        
        // Try to DM the owner instead
        try {
            const owner = vc.guild.members.cache.get(ownerId);
            if (owner) {
                const dmEmbed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('⚠️ Your PVC Was Manipulated')
                    .setDescription(
                        `Someone tried to manipulate your voice channel **${vc.name}** in **${vc.guild.name}**.\n\n` +
                        `**Editor:** ${editorText}\n\n` +
                        `**Changes attempted:**\n${changes.map(c => `• ${c}`).join('\n')}\n\n` +
                        `**All changes have been automatically reverted.**\n\n` +
                        `This may be power abuse. Please report to senior staff if needed.`
                    )
                    .setTimestamp();

                await owner.send({ embeds: [dmEmbed] });
                console.log(`[ChannelUpdate] Warning sent via DM to owner ${ownerId}`);
            }
        } catch (dmErr) {
            console.error(`[ChannelUpdate] Failed to DM owner ${ownerId}:`, dmErr);
        }
    }
}

async function sendUnauthorizedChangeLog(
    vc: import('discord.js').VoiceChannel,
    editorId: string | null,
    changes: string[],
    isTeamChannel: boolean,
    teamType?: string
): Promise<void> {
    const editor = editorId ? vc.guild.members.cache.get(editorId) : null;
    
    try {
        await logAction({
            action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
            guild: vc.guild,
            user: editor?.user,
            channelName: vc.name,
            channelId: vc.id,
            details: editorId
                ? `**Editor:** <@${editorId}>\n\n**Changes attempted:**\n${changes.map(c => `• ${c}`).join('\n')}\n\n✅ **All changes were automatically reverted.**`
                : `**Unauthorized changes detected:**\n${changes.map(c => `• ${c}`).join('\n')}\n\n✅ **All changes were automatically reverted.**`,
            isTeamChannel: isTeamChannel,
            teamType: teamType,
        });
        console.log(`[ChannelUpdate] Log sent for unauthorized changes on ${vc.id}`);
    } catch (err) {
        console.error(`[ChannelUpdate] Failed to send log:`, err);
    }
}

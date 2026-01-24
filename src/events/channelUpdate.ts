import { Events, type DMChannel, type GuildChannel, ChannelType, AuditLogEvent } from 'discord.js';
import type { PVCClient } from '../client';
import { enforcer } from '../services/enforcerService';
import prisma from '../utils/database';

export const name = Events.ChannelUpdate;
export const once = false;

/**
 * Track bot's own edits to prevent self-punishment loops.
 * Uses timestamps with longer TTL to ensure we catch all self-edits.
 */
export const recentBotEdits = new Map<string, number>();

const BOT_EDIT_TTL = 60000; // 60 seconds - match enforcement cooldown to prevent self-punishment

/**
 * Record that the bot is about to make an edit.
 * Call this BEFORE any channel.edit() operation.
 */
export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
    console.log(`[ChannelUpdate] Recorded bot edit for ${channelId}`);
    
    // Clean up old entries periodically
    if (recentBotEdits.size > 50) {
        const now = Date.now();
        for (const [id, timestamp] of recentBotEdits.entries()) {
            if (now - timestamp > BOT_EDIT_TTL * 2) {
                recentBotEdits.delete(id);
            }
        }
    }
}

/**
 * Check if this is a bot's own edit (to prevent loops)
 */
function isBotEdit(channelId: string): boolean {
    const editTime = recentBotEdits.get(channelId);
    if (!editTime) return false;
    
    const elapsed = Date.now() - editTime;
    if (elapsed > BOT_EDIT_TTL) {
        recentBotEdits.delete(channelId);
        return false;
    }
    
    return true;
}

/**
 * CHANNEL UPDATE EVENT HANDLER
 * 
 * This is the FIRST LINE OF DEFENSE against unauthorized channel modifications.
 * 
 * RULES:
 * 1. If bot made the change -> IGNORE (prevent loops)
 * 2. If channel was recently enforced -> SILENT enforcement only (no notifications)
 * 3. If whitelisted admin made the change (strictness ON) -> ALLOW
 * 4. ALL OTHER CHANGES -> INSTANT REVERT
 * 
 * NO DEBOUNCE. NO DELAYS. IMMEDIATE ENFORCEMENT.
 */
export async function execute(
    client: PVCClient,
    oldChannel: DMChannel | GuildChannel,
    newChannel: DMChannel | GuildChannel
): Promise<void> {
    // Only handle guild voice channels
    if (!('guild' in oldChannel) || !('guild' in newChannel)) return;
    if (oldChannel.type !== ChannelType.GuildVoice) return;

    const channelId = newChannel.id;
    const guildId = newChannel.guild.id;

    // FAST PATH #1: Check memory cache first (sub-millisecond)
    // This is the PRIMARY defense against self-punishment
    if (isBotEdit(channelId)) {
        console.log(`[ChannelUpdate] Bot edit detected (memory cache). Ignoring.`);
        return;
    }

    // FAST PATH #2: Check if we recently enforced this channel
    // This catches any edits that are a result of our own enforcement
    if (enforcer.wasRecentlyEnforced(channelId)) {
        console.log(`[ChannelUpdate] Recently enforced channel. Silently re-enforcing just in case.`);
        // Still enforce but silently (in case there's drift)
        await enforcer.enforceQuietly(channelId).catch(err => {
            console.error(`[ChannelUpdate] Silent re-enforcement failed:`, err);
        });
        return;
    }

    // Check if this is a managed channel BEFORE doing anything else
    const [pvcChannel, teamChannel] = await Promise.all([
        prisma.privateVoiceChannel.findUnique({ where: { channelId } }),
        prisma.teamVoiceChannel.findUnique({ where: { channelId } }),
    ]);

    // Not a managed channel - ignore completely
    if (!pvcChannel && !teamChannel) {
        return;
    }

    // Fetch audit logs to identify the editor
    let editorId: string | null = null;
    try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 5, // Check more entries in case of batched updates
        });
        
        // Find the most recent log for this channel
        for (const [, log] of auditLogs.entries) {
            if (log.targetId === channelId && Date.now() - log.createdTimestamp < 15000) {
                editorId = log.executor?.id || null;
                break;
            }
        }
    } catch (err) {
        console.error('[ChannelUpdate] Failed to fetch audit logs:', err);
        // If we can't fetch audit logs, check memory cache again and be cautious
        if (isBotEdit(channelId)) {
            console.log(`[ChannelUpdate] Audit log fetch failed, but bot edit in cache. Ignoring.`);
            return;
        }
    }

    // CRITICAL: If bot made the change (audit log confirms), ignore IMMEDIATELY
    if (editorId === client.user?.id) {
        console.log(`[ChannelUpdate] Bot edit confirmed (audit log). Ignoring.`);
        // Also record in memory to prevent any follow-up events
        recordBotEdit(channelId);
        return;
    }

    // Check if the editor is authorized (whitelisted admin)
    if (editorId) {
        const isAuthorized = await enforcer.isAuthorizedEditor(guildId, editorId);
        if (isAuthorized) {
            console.log(`[ChannelUpdate] Authorized editor (whitelisted admin: ${editorId}). Allowing.`);
            return;
        }
    }

    // UNAUTHORIZED CHANGE DETECTED - ENFORCE IMMEDIATELY
    console.log(`[ChannelUpdate] ⚠️ UNAUTHORIZED CHANGE detected on ${channelId} by ${editorId || 'unknown'}. ENFORCING...`);
    
    // Enforce IMMEDIATELY - no debounce, no delay
    await enforcer.enforce(channelId);
}

import { Events, type DMChannel, type GuildChannel, ChannelType, AuditLogEvent } from 'discord.js';
import type { PVCClient } from '../client';
import { enforcer } from '../services/enforcerService';
import prisma from '../utils/database';

export const name = Events.ChannelUpdate;
export const once = false;

/**
 * Track bot's own edits to prevent self-punishment loops.
 * Uses timestamps with short TTL for memory efficiency.
 */
export const recentBotEdits = new Map<string, number>();

const BOT_EDIT_TTL = 5000; // 5 seconds - very short to catch only immediate self-edits

/**
 * Record that the bot is about to make an edit.
 * Call this BEFORE any channel.edit() operation.
 */
export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
    
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
 * 2. If whitelisted admin made the change (strictness ON) -> ALLOW
 * 3. ALL OTHER CHANGES -> INSTANT REVERT
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

    // FAST PATH: Check memory cache first (sub-millisecond)
    if (isBotEdit(channelId)) {
        console.log(`[ChannelUpdate] Bot edit (memory). Ignoring.`);
        return;
    }

    // Check if this is a managed channel
    const [pvcChannel, teamChannel] = await Promise.all([
        prisma.privateVoiceChannel.findUnique({ where: { channelId } }),
        prisma.teamVoiceChannel.findUnique({ where: { channelId } }),
    ]);

    // Not a managed channel - ignore
    if (!pvcChannel && !teamChannel) {
        return;
    }

    // Fetch audit logs to identify the editor
    let editorId: string | null = null;
    try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 1,
        });
        const log = auditLogs.entries.first();

        // Verify the log is recent and for this channel
        if (log && log.targetId === channelId && Date.now() - log.createdTimestamp < 5000) {
            editorId = log.executor?.id || null;
        }
    } catch (err) {
        console.error('[ChannelUpdate] Failed to fetch audit logs:', err);
    }

    // If bot made the change (audit log confirms), ignore
    if (editorId === client.user?.id) {
        console.log(`[ChannelUpdate] Bot edit (audit log). Ignoring.`);
        return;
    }

    // Check if the editor is authorized
    if (editorId) {
        const isAuthorized = await enforcer.isAuthorizedEditor(guildId, editorId);
        if (isAuthorized) {
            console.log(`[ChannelUpdate] Authorized editor (whitelisted admin). Allowing.`);
            // NOTE: Even whitelisted admins' changes are NOT persisted to DB
            // They can fix things temporarily but DB remains the source of truth
            return;
        }
    }

    // UNAUTHORIZED CHANGE DETECTED - ENFORCE IMMEDIATELY
    console.log(`[ChannelUpdate] ⚠️ UNAUTHORIZED CHANGE detected on ${channelId} by ${editorId || 'unknown'}. ENFORCING...`);
    
    // Enforce IMMEDIATELY - no debounce, no delay
    await enforcer.enforce(channelId);
}

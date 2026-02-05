import { Events, type DMChannel, type GuildChannel, ChannelType, AuditLogEvent } from 'discord.js';
import type { PVCClient } from '../client';
import { enforcer } from '../services/enforcerService';
import prisma from '../utils/database';
export const name = Events.ChannelUpdate;
export const once = false;
export const recentBotEdits = new Map<string, number>();
const BOT_EDIT_TTL = 60000; 
export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
    console.log(`[ChannelUpdate] Recorded bot edit for ${channelId}`);
    if (recentBotEdits.size > 50) {
        const now = Date.now();
        for (const [id, timestamp] of recentBotEdits.entries()) {
            if (now - timestamp > BOT_EDIT_TTL * 2) {
                recentBotEdits.delete(id);
            }
        }
    }
}
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
export async function execute(
    client: PVCClient,
    oldChannel: DMChannel | GuildChannel,
    newChannel: DMChannel | GuildChannel
): Promise<void> {
    if (!('guild' in oldChannel) || !('guild' in newChannel)) return;
    if (oldChannel.type !== ChannelType.GuildVoice) return;
    const channelId = newChannel.id;
    const guildId = newChannel.guild.id;
    if (isBotEdit(channelId)) {
        console.log(`[ChannelUpdate] Bot edit detected (memory cache). Ignoring.`);
        return;
    }
    if (enforcer.wasRecentlyEnforced(channelId)) {
        console.log(`[ChannelUpdate] Recently enforced channel. Silently re-enforcing just in case.`);
        await enforcer.enforceQuietly(channelId).catch(err => {
            console.error(`[ChannelUpdate] Silent re-enforcement failed:`, err);
        });
        return;
    }
    const results = await Promise.allSettled([
        prisma.privateVoiceChannel.findUnique({ where: { channelId } }),
        prisma.teamVoiceChannel.findUnique({ where: { channelId } }),
    ]);
    const pvcChannel = results[0].status === 'fulfilled' ? results[0].value : null;
    const teamChannel = results[1].status === 'fulfilled' ? results[1].value : null;
    if (!pvcChannel && !teamChannel) {
        return;
    }
    let editorId: string | null = null;
    try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
            type: AuditLogEvent.ChannelUpdate,
            limit: 5, 
        });
        for (const [, log] of auditLogs.entries) {
            if (log.targetId === channelId && Date.now() - log.createdTimestamp < 15000) {
                editorId = log.executor?.id || null;
                break;
            }
        }
    } catch (err) {
        console.error('[ChannelUpdate] Failed to fetch audit logs:', err);
        if (isBotEdit(channelId)) {
            console.log(`[ChannelUpdate] Audit log fetch failed, but bot edit in cache. Ignoring.`);
            return;
        }
    }
    if (editorId === client.user?.id) {
        console.log(`[ChannelUpdate] Bot edit confirmed (audit log). Ignoring.`);
        recordBotEdit(channelId);
        return;
    }
    if (editorId) {
        const isAuthorized = await enforcer.isAuthorizedEditor(guildId, editorId, channelId);
        if (isAuthorized) {
            console.log(`[ChannelUpdate] Authorized editor (whitelisted admin: ${editorId}). Allowing.`);
            return;
        }
    }
    console.log(`[ChannelUpdate] ⚠️ UNAUTHORIZED CHANGE detected on ${channelId} by ${editorId || 'unknown'}. ENFORCING...`);
    await enforcer.enforce(channelId);
}

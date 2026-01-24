import { Events, type DMChannel, type GuildChannel, ChannelType } from 'discord.js';
import type { PVCClient } from '../client';
import { enforcer } from '../services/enforcerService';

export const name = Events.ChannelUpdate;
export const once = false;

// Global set to track bot's own edits to avoid feedback loops
export const recentBotEdits = new Map<string, number>();

export function recordBotEdit(channelId: string): void {
    recentBotEdits.set(channelId, Date.now());
}

export async function execute(
    client: PVCClient,
    oldChannel: DMChannel | GuildChannel,
    newChannel: DMChannel | GuildChannel
): Promise<void> {
    if (!('guild' in oldChannel) || !('guild' in newChannel)) return;
    if (oldChannel.type !== ChannelType.GuildVoice) return;

    const channelId = newChannel.id;

    // CRITICAL: Fetch Audit Logs FIRST to check if bot made the change
    try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
            type: 11, // Channel Update
            limit: 1,
        });
        const log = auditLogs.entries.first();

        // If the log is very recent and matches our channel
        if (log && log.targetId === newChannel.id && Date.now() - log.createdTimestamp < 5000) {
            // IF THE EXECUTOR IS THE BOT ITSELF, IGNORE IT IMMEDIATELY
            if (log.executor?.id === client.user?.id) {
                console.log(`[ChannelUpdate] Bot made this change. Ignoring self-action.`);
                return;
            }
        }
    } catch (err) {
        console.error('[ChannelUpdate] Failed to fetch audit logs:', err);
    }

    // Memory-based check as secondary verification
    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < 10000) {
        console.log(`[ChannelUpdate] Bot edit detected via memory cache. Ignoring.`);
        return;
    }

    // If we reach here, it's an external change
    console.log(`[ChannelUpdate] External change detected on ${channelId}. Enforcing DB state...`);
    await enforcer.enforce(channelId);
}

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

    // 1. Check if this was a Bot Edit (Memory Check)
    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < 10000) { // Increased to 10s
        // It was us. We don't enforce against ourselves.
        return;
    }

    // 2. Fetch Audit Logs to be sure who did it
    try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
            type: 11, // Channel Update
            limit: 1,
        });
        const log = auditLogs.entries.first();

        // If the log is very recent and matches our channel
        if (log && log.targetId === newChannel.id && Date.now() - log.createdTimestamp < 10000) {
            // IF THE EXECUTOR IS US (THE BOT), IGNORE IT
            if (log.executor?.id === client.user?.id) {
                console.log(`[ChannelUpdate] Auto-Ignoring own change (verified via AuditLog)`);
                return;
            }
        }
    } catch { }

    // 3. It was NOT us. It's an external change.
    // Trust NOTHING. Enforce Everything.
    console.log(`[ChannelUpdate] External change detected on ${channelId}. Enforcing DB state...`);
    await enforcer.enforce(channelId);
}

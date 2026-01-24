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

    // 1. Check if this was a Bot Edit
    const botEditTime = recentBotEdits.get(channelId);
    if (botEditTime && Date.now() - botEditTime < 5000) {
        // It was us. We don't enforce against ourselves.
        return;
    }

    // 2. It was NOT us. It's an external change.
    // Trust NOTHING. Enforce Everything.
    console.log(`[ChannelUpdate] External change detected on ${channelId}. Enforcing DB state...`);
    await enforcer.enforce(channelId);
}

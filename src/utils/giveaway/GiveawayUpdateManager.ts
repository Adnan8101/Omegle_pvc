import { Client, TextChannel } from 'discord.js';
import { prisma } from '../database';
import { createGiveawayEmbed } from './embeds';
import { getCachedGiveaway, getParticipantCountCached } from './giveawayCache';
interface PendingUpdate {
    timeout: NodeJS.Timeout;
    lastReactionTime: number;
    reactionCount: number;
}
class GiveawayUpdateManager {
    private pendingUpdates: Map<string, PendingUpdate> = new Map();
    private client: Client | null = null;
    private reactionCounts: Map<string, number> = new Map();
    initialize(client: Client) {
        this.client = client;
    }
    private getAdaptiveDelay(giveawayId: string): number {
        const count = this.reactionCounts.get(giveawayId) || 0;
        if (count > 200) return 6000;
        if (count > 50) return 4000;
        return 2000;
    }
    scheduleUpdate(giveawayId: string, messageId: string, channelId: string, guildId: string) {
        if (!this.client) return;
        const now = Date.now();
        const pending = this.pendingUpdates.get(messageId);
        const currentCount = this.reactionCounts.get(messageId) || 0;
        this.reactionCounts.set(messageId, currentCount + 1);
        if (!pending) {
            setTimeout(() => {
                this.reactionCounts.delete(messageId);
            }, 60000);
        }
        if (pending) {
            clearTimeout(pending.timeout);
        }
        const delay = this.getAdaptiveDelay(messageId);
        const timeout = setTimeout(async () => {
            await this.executeUpdate(giveawayId, messageId, channelId);
            this.pendingUpdates.delete(messageId);
        }, delay);
        this.pendingUpdates.set(messageId, {
            timeout,
            lastReactionTime: now,
            reactionCount: (pending?.reactionCount || 0) + 1
        });
    }
    private async executeUpdate(giveawayId: string, messageId: string, channelId: string) {
        if (!this.client) return;
        try {
            const giveaway = await getCachedGiveaway(messageId);
            if (!giveaway || giveaway.ended) return;
            const count = await getParticipantCountCached(giveaway.id);
            const channel = this.client.channels.cache.get(channelId) as TextChannel;
            if (!channel) return;
            const message = await channel.messages.fetch(messageId);
            const embed = createGiveawayEmbed(giveaway, count);
            await message.edit({ embeds: [embed] });
        } catch (error) {
        }
    }
    async forceUpdate(messageId: string, channelId: string) {
        const pending = this.pendingUpdates.get(messageId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingUpdates.delete(messageId);
        }
        const giveaway = await getCachedGiveaway(messageId);
        if (giveaway) {
            await this.executeUpdate(giveaway.id.toString(), messageId, channelId);
        }
    }
    cleanup(messageId: string) {
        const pending = this.pendingUpdates.get(messageId);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingUpdates.delete(messageId);
        }
        this.reactionCounts.delete(messageId);
    }
}
export const giveawayUpdateManager = new GiveawayUpdateManager();

import { prisma } from '../utils/database';

import { Client, TextChannel } from 'discord.js';
import { GiveawayService } from './GiveawayService';
import { getNowUTC, hasEnded, toBigInt } from '../utils/giveaway/timeUtils';
import { createGiveawayEmbed } from '../utils/giveaway/embeds';
import { getParticipantCountCached, invalidateAllGiveawayCaches } from '../utils/giveaway/giveawayCache';

const preCalculatedGiveaways: Set<string> = new Set();

interface CachedSchedulerData {
    scheduledGiveaways: any[];
    activeGiveaways: any[];
    lastFetch: number;
}

const schedulerCache: CachedSchedulerData = {
    scheduledGiveaways: [],
    activeGiveaways: [],
    lastFetch: 0
};

const SCHEDULER_CACHE_TTL = 30000;
const SCHEDULER_INTERVAL = 15000;

export class GiveawaySchedulerService {
    private client: Client;
    private giveawayService: GiveawayService;
    private interval: NodeJS.Timeout | null = null;
    private activeGiveawayTimers: Map<string, NodeJS.Timeout> = new Map();
    private isRunning: boolean = false;

    constructor(client: Client) {
        this.client = client;
        this.giveawayService = new GiveawayService(client);
    }

    public start() {
        const loop = async () => {
            if (this.isRunning) return;
            this.isRunning = true;

            try {
                await this.refreshCacheIfNeeded();
                await this.checkScheduledGiveaways();
                await this.checkActiveGiveaways();
                await this.preCalculateUpcomingGiveaways();
            } catch (err) {
            } finally {
                this.isRunning = false;
                this.interval = setTimeout(loop, SCHEDULER_INTERVAL);
            }
        };

        loop();

        this.recoverActiveGiveaways();
    }

    private async refreshCacheIfNeeded() {
        const now = Date.now();
        if (now - schedulerCache.lastFetch < SCHEDULER_CACHE_TTL) return;

        const nowUTC = toBigInt(getNowUTC());
        const [scheduled, active] = await Promise.all([
            prisma.scheduledGiveaway.findMany({
                where: { startTime: { lte: BigInt(Date.now() + 60000) } }
            }),
            prisma.giveaway.findMany({
                where: { ended: false, endTime: { lte: nowUTC + BigInt(60000) } }
            })
        ]);

        schedulerCache.scheduledGiveaways = scheduled;
        schedulerCache.activeGiveaways = active;
        schedulerCache.lastFetch = now;
    }

    public stop() {
        if (this.interval) clearInterval(this.interval);

        this.activeGiveawayTimers.forEach(timer => clearTimeout(timer));
        this.activeGiveawayTimers.clear();
    }

    private async preCalculateUpcomingGiveaways() {
        try {
            const nowUTC = toBigInt(getNowUTC());
            const sixtySecondsLater = nowUTC + BigInt(60000);

            const upcomingGiveaways = schedulerCache.activeGiveaways.filter(g => 
                g.endTime > nowUTC && g.endTime <= sixtySecondsLater
            );

            for (const giveaway of upcomingGiveaways) {
                if (preCalculatedGiveaways.has(giveaway.messageId)) {
                    continue;
                }

                // Pre-calculate winners for all giveaways (no minimum participant requirement)
                await this.giveawayService.preCalculateWinners(giveaway.messageId);
                preCalculatedGiveaways.add(giveaway.messageId);
            }
        } catch (error) {
        }
    }

    private async recoverActiveGiveaways() {
        try {
            const activeGiveaways = await prisma.giveaway.findMany({
                where: { ended: false }
            });

            console.log(`[Giveaway] Recovering ${activeGiveaways.length} active giveaway(s)...`);

            for (const giveaway of activeGiveaways) {
                try {
                    const channel = await this.client.channels.fetch(giveaway.channelId).catch(() => null) as TextChannel | null;
                    if (!channel) {
                        console.log(`[Giveaway] ❌ Skipped GW #${giveaway.id} - Channel not found (${giveaway.channelId})`);
                        continue;
                    }

                    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
                    if (!message) {
                        console.log(`[Giveaway] ❌ Marking GW #${giveaway.id} as ended - Message deleted`);
                        await prisma.giveaway.update({
                            where: { id: giveaway.id },
                            data: { ended: true }
                        });
                        continue;
                    }

                    const participantCount = await getParticipantCountCached(giveaway.id);
                    const endTimestamp = Math.floor(Number(giveaway.endTime) / 1000);
                    const timeLeft = Number(giveaway.endTime) - Date.now();
                    const timeLeftStr = timeLeft > 0 ? `${Math.floor(timeLeft / 60000)}m ${Math.floor((timeLeft % 60000) / 1000)}s` : 'ENDING NOW';

                    console.log(`[Giveaway] ✅ Resumed GW #${giveaway.id}`);
                    console.log(`           Prize: ${giveaway.prize}`);
                    console.log(`           Winners: ${giveaway.winnersCount}`);
                    console.log(`           Participants: ${participantCount}`);
                    console.log(`           Ends: <t:${endTimestamp}:R> (${timeLeftStr})`);
                    console.log(`           Channel: #${channel.name} (${channel.id})`);
                    console.log(`           Host: ${giveaway.hostId}`);
                    if (giveaway.forcedWinners) {
                        console.log(`           Forced Winners: ${giveaway.forcedWinners}`);
                    }

                    const embed = createGiveawayEmbed(giveaway, participantCount);
                    await message.edit({ embeds: [embed] }).catch(() => {});

                } catch (error) {
                    console.error(`[Giveaway] Error recovering GW #${giveaway.id}:`, error);
                }
            }

            if (activeGiveaways.length > 0) {
                console.log(`[Giveaway] Recovery complete. ${activeGiveaways.length} giveaway(s) resumed.`);
            } else {
                console.log(`[Giveaway] No active giveaways to recover.`);
            }
        } catch (error) {
            console.error('[Giveaway] Failed to recover active giveaways:', error);
        }
    }

    private scheduleGiveawayEnd(giveaway: any) {
        if (this.activeGiveawayTimers.has(giveaway.messageId)) return;

        const now = Date.now();
        const endTime = Number(giveaway.endTime);
        const delay = endTime - now;

        // Only schedule if ending within 60 seconds
        if (delay > 0 && delay <= 60000) {
            const timer = setTimeout(async () => {
                try {
                    await this.giveawayService.endGiveaway(giveaway.messageId);
                    schedulerCache.activeGiveaways = schedulerCache.activeGiveaways.filter(g => g.id !== giveaway.id);
                    this.activeGiveawayTimers.delete(giveaway.messageId);
                } catch (error) {
                }
            }, delay);

            this.activeGiveawayTimers.set(giveaway.messageId, timer);
        }
    }

    private async checkActiveGiveaways() {
        try {
            const nowUTC = toBigInt(getNowUTC());
            const oneMinuteLater = nowUTC + BigInt(60000);

            // Schedule timers for giveaways ending within 60 seconds
            const upcomingGiveaways = schedulerCache.activeGiveaways.filter(g => 
                g.endTime > nowUTC && g.endTime <= oneMinuteLater
            );

            for (const giveaway of upcomingGiveaways) {
                this.scheduleGiveawayEnd(giveaway);
            }

            // End giveaways that are already past due (fallback)
            const endedGiveaways = schedulerCache.activeGiveaways.filter(g => g.endTime <= nowUTC);

            for (const giveaway of endedGiveaways) {
                if (this.activeGiveawayTimers.has(giveaway.messageId)) continue;

                try {
                    await this.giveawayService.endGiveaway(giveaway.messageId);
                    schedulerCache.activeGiveaways = schedulerCache.activeGiveaways.filter(g => g.id !== giveaway.id);
                } catch (error) {
                }
            }
        } catch (error) {
        }
    }

    private async checkScheduledGiveaways() {
        try {
            const now = BigInt(Date.now());

            const dueGiveaways = schedulerCache.scheduledGiveaways.filter(g => g.startTime <= now);

            for (const scheduled of dueGiveaways) {
                try {
                    await prisma.scheduledGiveaway.delete({
                        where: { id: scheduled.id }
                    });

                    schedulerCache.scheduledGiveaways = schedulerCache.scheduledGiveaways.filter(g => g.id !== scheduled.id);

                    let payload;
                    try {
                        payload = JSON.parse(scheduled.payload);
                    } catch (parseError) {
                        continue;
                    }

                    let channel: TextChannel | null = null;
                    try {
                        channel = await this.client.channels.fetch(scheduled.channelId) as TextChannel;
                    } catch (e) {
                    }

                    if (channel && payload.announcement) {
                        try {
                            const messageContent: any = {
                                content: payload.announcement
                            };

                            if (payload.announcementMedia) {
                                messageContent.content += `\n${payload.announcementMedia}`;
                            }

                            await channel.send(messageContent);
                        } catch (err) {
                        }
                    }

                    const giveawayData = {
                        channelId: scheduled.channelId,
                        guildId: scheduled.guildId,
                        hostId: scheduled.hostId,
                        prize: scheduled.prize,
                        winnersCount: scheduled.winnersCount,
                        endTime: scheduled.startTime + BigInt(payload.duration),
                        createdAt: BigInt(Date.now()),
                        emoji: payload.emoji,
                        roleRequirement: payload.roleRequirement,
                        inviteRequirement: payload.inviteRequirement,
                        captchaRequirement: payload.captchaRequirement,
                        winnerRole: payload.winnerRole,
                        assignRole: payload.assignRole,
                        customMessage: payload.customMessage,
                        thumbnail: payload.thumbnail,
                        increaseChance: payload.increaseChance,
                        increaseChanceRole: payload.increaseChanceRole
                    };

                    await this.giveawayService.startGiveaway(giveawayData);

                } catch (error) {
                }
            }

        } catch (error) {
        }
    }
}

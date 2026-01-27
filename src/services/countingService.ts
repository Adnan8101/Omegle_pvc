import { Message, EmbedBuilder } from 'discord.js';
import prisma from '../utils/database';

// In-memory lock with proper queuing
const processingQueue = new Map<string, Promise<void>>();

export class CountingService {
    /**
     * Handle counting messages with proper serialization per guild
     */
    public static async handleCountingMessage(message: Message): Promise<void> {
        if (!message.guild || message.author.bot) return;

        const guildId = message.guild.id;

        // Create a promise chain to serialize all messages for this guild
        const previousPromise = processingQueue.get(guildId) || Promise.resolve();
        
        const currentPromise = previousPromise
            .then(() => this.processCountingMessage(message))
            .catch((err) => console.error('[Counting] Processing error:', err));

        processingQueue.set(guildId, currentPromise);

        // Clean up after a delay to prevent memory leak
        currentPromise.finally(() => {
            setTimeout(() => {
                if (processingQueue.get(guildId) === currentPromise) {
                    processingQueue.delete(guildId);
                }
            }, 100);
        });
    }

    private static async processCountingMessage(message: Message): Promise<void> {
        if (!message.guild) return;

        try {
            // Extract number FIRST (before any async operations)
            const content = message.content.trim();
            const number = parseInt(content, 10);

            // Validate number format
            if (isNaN(number) || content !== number.toString() || number < 1) {
                return; // Silently ignore invalid numbers
            }

            // Get fresh settings from database
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: message.guild.id },
            });

            if (!settings || !settings.enabled || settings.channelId !== message.channel.id) {
                return;
            }

            const expectedNumber = settings.currentCount + 1;
            const isCorrect = number === expectedNumber;
            const isSameUser = settings.lastUserId === message.author.id;

            if (isCorrect && !isSameUser) {
                // ✅ CORRECT! Update DB immediately before anything else
                await prisma.$transaction([
                    // Update counting settings
                    prisma.countingSettings.update({
                        where: { guildId: message.guild.id },
                        data: {
                            currentCount: number,
                            lastUserId: message.author.id,
                        },
                    }),
                    // Increment user's counting stat
                    prisma.countingUserStats.upsert({
                        where: {
                            guildId_userId: {
                                guildId: message.guild.id,
                                userId: message.author.id,
                            },
                        },
                        update: {
                            counting: { increment: 1 },
                        },
                        create: {
                            guildId: message.guild.id,
                            userId: message.author.id,
                            counting: 1,
                        },
                    }),
                ]);

                // React after DB is updated (non-blocking)
                message.react('✅').catch(() => {});

                console.log(`[Counting] ✅ ${message.author.tag} -> ${number}`);
            } else {
                // ❌ WRONG! Handle error
                const errorReason = isSameUser 
                    ? "Can't count twice in a row!" 
                    : `Expected **${expectedNumber}**, got **${number}**`;

                // Delete wrong message
                await message.delete().catch(() => {});

                // Send brief error message
                if (message.channel.isSendable()) {
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setDescription(
                            `❌ ${message.author}\n${errorReason}\nContinue: **${settings.currentCount + 1}**`
                        );

                    const errorMsg = await message.channel.send({ embeds: [embed] }).catch(() => null);
                    
                    if (errorMsg) {
                        setTimeout(() => errorMsg.delete().catch(() => {}), 3500);
                    }
                }

                // Reset last user
                await prisma.countingSettings.update({
                    where: { guildId: message.guild.id },
                    data: { lastUserId: null },
                }).catch(() => {});

                console.log(`[Counting] ❌ ${message.author.tag} -> ${number} (expected ${expectedNumber})`);
            }
        } catch (error) {
            console.error('[Counting] Error:', error);
        }
    }
}

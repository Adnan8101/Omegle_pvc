import { Message, EmbedBuilder } from 'discord.js';
import prisma from '../utils/database';
const processingQueue = new Map<string, Promise<void>>();
export class CountingService {
    public static async handleCountingMessage(message: Message): Promise<void> {
        if (!message.guild || message.author.bot) return;
        const guildId = message.guild.id;
        const previousPromise = processingQueue.get(guildId) || Promise.resolve();
        const currentPromise = previousPromise
            .then(() => this.processCountingMessage(message))
            .catch((err) => console.error('[Counting] Processing error:', err));
        processingQueue.set(guildId, currentPromise);
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
            const content = message.content.trim();
            const number = parseInt(content, 10);
            if (isNaN(number) || content !== number.toString() || number < 1) {
                return; 
            }
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
                await prisma.$transaction([
                    prisma.countingSettings.update({
                        where: { guildId: message.guild.id },
                        data: {
                            currentCount: number,
                            lastUserId: message.author.id,
                        },
                    }),
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
                message.react('✅').catch(() => {});
                console.log(`[Counting] ✅ ${message.author.tag} -> ${number}`);
            } else {
                const errorReason = isSameUser 
                    ? "Can't count twice in a row!" 
                    : `Expected **${expectedNumber}**, got **${number}**`;
                await message.delete().catch(() => {});
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

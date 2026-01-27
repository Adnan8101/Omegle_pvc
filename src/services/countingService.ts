import { Message, EmbedBuilder } from 'discord.js';
import prisma from '../utils/database';

export class CountingService {
    /**
     * Handle counting messages in configured channels
     */
    public static async handleCountingMessage(message: Message): Promise<void> {
        if (!message.guild || message.author.bot) return;

        try {
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: message.guild.id },
            });

            if (!settings || !settings.enabled || settings.channelId !== message.channel.id) {
                return;
            }

            // Extract number from message
            const content = message.content.trim();
            const number = parseInt(content, 10);

            // Check if message is a valid number
            if (isNaN(number) || content !== number.toString()) {
                // Silently ignore non-numeric messages
                return;
            }

            const expectedNumber = settings.currentCount + 1;
            const isCorrect = number === expectedNumber;
            const isSameUser = settings.lastUserId === message.author.id;

            // Check if it's the correct number and not the same user
            if (isCorrect && !isSameUser) {
                // Correct count! React with checkmark
                await message.react('✅').catch(() => {});

                // Update database
                await prisma.countingSettings.update({
                    where: { guildId: message.guild.id },
                    data: {
                        currentCount: number,
                        lastUserId: message.author.id,
                    },
                });

                console.log(`[Counting] ${message.guild.name}: ${message.author.tag} counted ${number}`);
            } else {
                // Wrong count! Delete message and send error
                await message.delete().catch(() => {});

                let errorReason = '';
                if (isSameUser) {
                    errorReason = "You can't count twice in a row!";
                } else {
                    errorReason = `Expected **${expectedNumber}**, but got **${number}**`;
                }

                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setDescription(
                        `❌ **Wrong Count!**\n\n` +
                        `${message.author} broke the counting!\n` +
                        `${errorReason}\n\n` +
                        `Start from: **${settings.currentCount + 1}**`
                    )
                    .setFooter({ text: 'Pay attention to the sequence!' });

                if (message.channel.isSendable()) {
                    const errorMsg = await message.channel.send({ embeds: [embed] });

                    // Delete error message after 5 seconds
                    setTimeout(() => {
                        errorMsg.delete().catch(() => {});
                    }, 5000);
                }

                // Reset last user so anyone can continue
                await prisma.countingSettings.update({
                    where: { guildId: message.guild.id },
                    data: {
                        lastUserId: null,
                    },
                });

                console.log(`[Counting] ${message.guild.name}: ${message.author.tag} broke counting at ${number} (expected ${expectedNumber})`);
            }
        } catch (error) {
            console.error('[Counting] Error handling counting message:', error);
        }
    }
}

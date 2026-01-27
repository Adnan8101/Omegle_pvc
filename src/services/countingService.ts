import { Message, EmbedBuilder } from 'discord.js';
import prisma from '../utils/database';

// In-memory lock to prevent race conditions
const guildLocks = new Map<string, Promise<void>>();

export class CountingService {
    /**
     * Handle counting messages in configured channels with race condition protection
     */
    public static async handleCountingMessage(message: Message): Promise<void> {
        if (!message.guild || message.author.bot) return;

        const guildId = message.guild.id;

        // Wait for any existing processing to complete (prevents race conditions)
        while (guildLocks.has(guildId)) {
            try {
                await guildLocks.get(guildId);
            } catch {
                // Ignore errors from previous operations
            }
        }

        // Create a new lock for this operation
        let resolveLock: () => void;
        const lockPromise = new Promise<void>((resolve) => {
            resolveLock = resolve;
        });
        guildLocks.set(guildId, lockPromise);

        try {
            // Fetch settings
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: guildId },
            });

            if (!settings || !settings.enabled || settings.channelId !== message.channel.id) {
                return;
            }

            // Extract number from message
            const content = message.content.trim();
            const number = parseInt(content, 10);

            // Check if message is a valid number (also check for leading zeros, spaces, etc.)
            if (isNaN(number) || content !== number.toString() || number < 1) {
                // Silently ignore non-numeric messages or invalid numbers
                return;
            }

            const expectedNumber = settings.currentCount + 1;
            const isCorrect = number === expectedNumber;
            const isSameUser = settings.lastUserId === message.author.id;

            // Check if it's the correct number and not the same user
            if (isCorrect && !isSameUser) {
                // Correct count! Update database first (atomic operation)
                try {
                    await prisma.countingSettings.update({
                        where: { 
                            guildId: guildId,
                        },
                        data: {
                            currentCount: number,
                            lastUserId: message.author.id,
                        },
                    });

                    // Then react with checkmark
                    await message.react('✅').catch((err) => {
                        console.error(`[Counting] Failed to react: ${err.message}`);
                    });

                    console.log(`[Counting] ${message.guild.name}: ${message.author.tag} counted ${number}`);
                } catch (dbError) {
                    console.error('[Counting] Database update failed:', dbError);
                    // If database update fails, don't react
                }
            } else {
                // Wrong count! Delete message and send error
                let errorReason = '';
                if (isSameUser) {
                    errorReason = "You can't count twice in a row!";
                } else {
                    errorReason = `Expected **${expectedNumber}**, but got **${number}**`;
                }

                // Delete the wrong message first
                const messageDeleted = await message.delete().catch((err) => {
                    console.error(`[Counting] Failed to delete message: ${err.message}`);
                    return null;
                });

                // Send error embed
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setDescription(
                        `❌ **Wrong Count!**\n\n` +
                        `${messageDeleted ? message.author : `<@${message.author.id}>`} broke the counting!\n` +
                        `${errorReason}\n\n` +
                        `Start from: **${settings.currentCount + 1}**`
                    )
                    .setFooter({ text: 'Pay attention to the sequence!' });

                if (message.channel.isSendable()) {
                    try {
                        const errorMsg = await message.channel.send({ embeds: [embed] });

                        // Delete error message after 5 seconds
                        setTimeout(() => {
                            errorMsg.delete().catch(() => {});
                        }, 5000);
                    } catch (sendError) {
                        console.error('[Counting] Failed to send error message:', sendError);
                    }
                }

                // Reset last user so anyone can continue (prevent deadlock)
                try {
                    await prisma.countingSettings.update({
                        where: { guildId: guildId },
                        data: {
                            lastUserId: null,
                        },
                    });
                } catch (dbError) {
                    console.error('[Counting] Failed to reset last user:', dbError);
                }

                console.log(`[Counting] ${message.guild.name}: ${message.author.tag} broke counting at ${number} (expected ${expectedNumber})`);
            }
        } catch (error) {
            console.error('[Counting] Error handling counting message:', error);
        } finally {
            // Always release the lock
            guildLocks.delete(guildId);
            resolveLock!();
        }
    }
}

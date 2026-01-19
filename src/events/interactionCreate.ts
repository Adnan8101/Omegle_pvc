import { Events, type Interaction, MessageFlags, DiscordAPIError } from 'discord.js';
import type { PVCClient } from '../client';
import { handleButtonInteraction } from '../interactions/buttons';
import { handleModalSubmit } from '../interactions/modals';
import { handleSelectMenuInteraction } from '../interactions/selects';

export const name = Events.InteractionCreate;
export const once = false;

// Per-user rate limiting for interactions
const userRateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = {
    MAX_INTERACTIONS: 15,  // Max interactions per window
    WINDOW_MS: 10000,      // 10 second window
};

function isRateLimited(userId: string): boolean {
    const now = Date.now();
    const userLimit = userRateLimits.get(userId);
    
    if (!userLimit || now > userLimit.resetAt) {
        userRateLimits.set(userId, { count: 1, resetAt: now + RATE_LIMIT.WINDOW_MS });
        return false;
    }
    
    userLimit.count++;
    if (userLimit.count > RATE_LIMIT.MAX_INTERACTIONS) {
        return true;
    }
    return false;
}

// Cleanup old rate limit entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [userId, limit] of userRateLimits) {
        if (now > limit.resetAt) {
            userRateLimits.delete(userId);
        }
    }
}, 60000);

// Safe reply helper - never throws
async function safeReply(interaction: Interaction, content: string): Promise<void> {
    try {
        if (!interaction.isRepliable()) return;

        if (interaction.replied) {
            // Already replied, try followUp
            await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
        } else if (interaction.deferred) {
            // Deferred, use editReply
            await interaction.editReply({ content }).catch(() => { });
        } else {
            // Fresh reply
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => { });
        }
    } catch {
        // Silently ignore - interaction token likely expired
    }
}

// Check if error is a known "stale" error we can ignore
function isStaleError(error: unknown): boolean {
    const discordError = error as DiscordAPIError;
    const staleErrorCodes = [
        10003, // Unknown Channel
        10008, // Unknown Message
        50027, // Invalid Webhook Token (expired interaction)
    ];
    return staleErrorCodes.includes(discordError.code as number);
}

export async function execute(client: PVCClient, interaction: Interaction): Promise<void> {
    try {
        // Anti-spam: Per-user rate limiting
        if (isRateLimited(interaction.user.id)) {
            await safeReply(interaction, '⏳ You\'re doing that too fast! Please wait a moment.');
            return;
        }

        // Handle slash commands
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) {
                await safeReply(interaction, 'Unknown command.');
                return;
            }
            await command.execute(interaction);
            return;
        }

        // Handle button interactions
        if (interaction.isButton()) {
            await handleButtonInteraction(interaction);
            return;
        }

        // Handle modal submissions
        if (interaction.isModalSubmit()) {
            await handleModalSubmit(interaction);
            return;
        }

        // Handle select menu interactions
        if (interaction.isAnySelectMenu()) {
            await handleSelectMenuInteraction(interaction);
            return;
        }
    } catch (error) {
        // Silently handle errors (stale or otherwise)
        // Try to inform user, but don't crash if we can't
        await safeReply(interaction, 'An error occurred while processing this interaction.');
    }
}

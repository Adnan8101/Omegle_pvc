import { Events, type Interaction, MessageFlags, DiscordAPIError } from 'discord.js';
import type { PVCClient } from '../client';
import { handleButtonInteraction } from '../interactions/buttons';
import { handleModalSubmit } from '../interactions/modals';
import { handleSelectMenuInteraction } from '../interactions/selects';

export const name = Events.InteractionCreate;
export const once = false;

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

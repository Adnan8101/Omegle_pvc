import { Events, type Interaction, MessageFlags, DiscordAPIError } from 'discord.js';
import type { PVCClient } from '../client';
export const name = Events.InteractionCreate;
export const once = false;
const userRateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = {
    MAX_INTERACTIONS: 15,
    WINDOW_MS: 10000,
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
setInterval(() => {
    const now = Date.now();
    for (const [userId, limit] of userRateLimits) {
        if (now > limit.resetAt) {
            userRateLimits.delete(userId);
        }
    }
}, 60000);
async function safeReply(interaction: Interaction, content: string): Promise<void> {
    try {
        if (!interaction.isRepliable() || interaction.isAutocomplete()) return;
        if (interaction.replied) {
            await interaction.followUp({ content, flags: [MessageFlags.Ephemeral] }).catch(() => { });
        } else if (interaction.deferred) {
            await interaction.editReply({ content }).catch((err: any) => {
                if (err.code === 10008) {
                    console.log('[InteractionCreate] Interaction expired (Unknown Message)');
                }
            });
        } else {
            await interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => { });
        }
    } catch { }
}
function isStaleError(error: unknown): boolean {
    const discordError = error as DiscordAPIError;
    const staleErrorCodes = [
        10003,  // Unknown Channel
        10008,  // Unknown Message (interaction expired)
        50027,  // Invalid Webhook Token
        10062,  // Unknown Interaction
        40060,  // Interaction has already been acknowledged 
    ];
    return staleErrorCodes.includes(discordError.code as number);
}
export async function execute(client: PVCClient, interaction: Interaction): Promise<void> {
    try {
        if (isRateLimited(interaction.user.id)) {
            await safeReply(interaction, '⏳ You\'re doing that too fast! Please wait a moment.');
            return;
        }
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) {
                await safeReply(interaction, 'Unknown command.');
                return;
            }
            await command.execute(interaction);
            return;
        }
    } catch (error) {
        console.error(`[InteractionCreate] Error handling interaction:`, {
            type: interaction.type,
            commandName: interaction.isChatInputCommand() ? interaction.commandName : 'N/A',
            customId: (interaction as any).customId || 'N/A',
            userId: interaction.user.id,
            guildId: interaction.guildId,
            error: error instanceof Error ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
            } : error,
        });
        if (!isStaleError(error)) {
            console.error(`[InteractionCreate] Non-stale error occurred:`, error);
            await safeReply(interaction, 'An error occurred while processing this interaction.');
        }
    }
}

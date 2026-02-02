import { MessageFlags, ChannelType, type ChatInputCommandInteraction, type Channel } from 'discord.js';
import { canRunAdminCommand } from './permissions';
export async function validateServerCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return false;
    }
    return true;
}
export async function validateAdminCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return false;
    }
    return true;
}
export async function validateChannelType(
    interaction: ChatInputCommandInteraction,
    channel: Channel | null,
    expectedType: ChannelType,
    errorMessage: string
): Promise<boolean> {
    if (!channel || channel.type !== expectedType) {
        await interaction.reply({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
        return false;
    }
    return true;
}
export async function validateRequiredChannels(
    interaction: ChatInputCommandInteraction,
    validations: Array<{
        channel: Channel | null;
        expectedType: ChannelType;
        errorMessage: string;
    }>
): Promise<boolean> {
    for (const { channel, expectedType, errorMessage } of validations) {
        if (!await validateChannelType(interaction, channel, expectedType, errorMessage)) {
            return false;
        }
    }
    return true;
}

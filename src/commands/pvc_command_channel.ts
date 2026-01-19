import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { invalidateGuildSettings } from '../utils/cache';

const data = new SlashCommandBuilder()
    .setName('pvc_command_channel')
    .setDescription('Set the channel where prefix commands (!au, !ru, !l) work')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('channel')
            .setDescription('The text channel for prefix commands')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    const channel = interaction.options.getChannel('channel', true);

    try {
        await prisma.guildSettings.upsert({
            where: { guildId: interaction.guild.id },
            update: { commandChannelId: channel.id },
            create: {
                guildId: interaction.guild.id,
                commandChannelId: channel.id,
            },
        });

        invalidateGuildSettings(interaction.guild.id);

        await interaction.reply({
            content: `Prefix commands (!au, !ru, !l) will now only work in ${channel}`,
            ephemeral: true,
        });
    } catch {
        await interaction.reply({
            content: 'Failed to set command channel.',
            ephemeral: true,
        });
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

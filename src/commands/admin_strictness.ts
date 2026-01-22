import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { invalidateGuildSettings } from '../utils/cache';
import { canRunAdminCommand } from '../utils/permissions';

const data = new SlashCommandBuilder()
    .setName('admin_strictness')
    .setDescription('Toggle admin strictness for private voice channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
        option
            .setName('mode')
            .setDescription('Enable or disable admin strictness')
            .setRequired(true)
            .addChoices(
                { name: 'on', value: 'on' },
                { name: 'off', value: 'off' }
            )
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Check if user can run admin commands (bot developer or higher role than bot)
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const mode = interaction.options.getString('mode', true);
    const enabled = mode === 'on';

    try {
        await prisma.guildSettings.upsert({
            where: { guildId: interaction.guild.id },
            update: { adminStrictness: enabled },
            create: {
                guildId: interaction.guild.id,
                adminStrictness: enabled,
            },
        });

        invalidateGuildSettings(interaction.guild.id);

        await interaction.reply({
            content: `Admin strictness has been turned **${mode}**.${enabled
                ? '\n\nAdministrators will now be disconnected from private channels they do not have access to.'
                : '\n\nDefault Discord permission hierarchy will now apply.'
                }`,
            flags: [MessageFlags.Ephemeral],
        });
    } catch {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Failed to update admin strictness setting.',
                flags: [MessageFlags.Ephemeral],
            }).catch(() => {});
        }
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

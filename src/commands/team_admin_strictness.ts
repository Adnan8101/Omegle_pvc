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
    .setName('team_admin_strictness')
    .setDescription('Toggle admin strictness for team voice channels (Duo/Trio/Squad)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption(option =>
        option
            .setName('mode')
            .setDescription('Enable or disable admin strictness for team channels')
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
                ? '\n\nAdministrators will now be disconnected from private channels they do not have access to.\n*This setting applies to both PVC and Team channels.*'
                : '\n\nDefault Discord permission hierarchy will now apply.\n*This setting applies to both PVC and Team channels.*'
                }`,
            flags: [MessageFlags.Ephemeral],
        });
    } catch (error) {
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

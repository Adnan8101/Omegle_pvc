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
    .setName('pvc_staff_role')
    .setDescription('Set the staff role that can approve rename requests')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addRoleOption(option =>
        option
            .setName('role')
            .setDescription('The staff role for rename approvals')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Check admin permissions
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const role = interaction.options.getRole('role', true);

    try {
        await prisma.guildSettings.upsert({
            where: { guildId: interaction.guild.id },
            update: { staffRoleId: role.id },
            create: {
                guildId: interaction.guild.id,
                staffRoleId: role.id,
            },
        });

        invalidateGuildSettings(interaction.guild.id);

        await interaction.reply({
            content: `Staff role set to ${role}. Members with this role can approve rename requests.`,
            flags: [MessageFlags.Ephemeral],
        });
    } catch {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Failed to set staff role.',
                flags: [MessageFlags.Ephemeral],
            }).catch(() => {});
        }
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

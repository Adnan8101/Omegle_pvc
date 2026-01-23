import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';

const data = new SlashCommandBuilder()
    .setName('team_vc_command_channel')
    .setDescription('Set the channel where team VC prefix commands (!au, !ru, !l) work')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('channel')
            .setDescription('The text channel for team VC prefix commands (use "all" for all channels)')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
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

    const channel = interaction.options.getChannel('channel', true);

    try {
        await prisma.teamVoiceSettings.upsert({
            where: { guildId: interaction.guild.id },
            update: { commandChannelId: channel.id },
            create: {
                guildId: interaction.guild.id,
                commandChannelId: channel.id,
            },
        });

        await interaction.reply({
            content: `Team VC prefix commands (!au, !ru, !l) will now only work in ${channel}`,
            flags: [MessageFlags.Ephemeral],
        });
    } catch {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Failed to set team command channel.',
                flags: [MessageFlags.Ephemeral],
            }).catch(() => {});
        }
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

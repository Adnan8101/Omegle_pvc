import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    ChannelType,
} from 'discord.js';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
import { isPvcPaused, pausePvc, setPauseMessageId } from '../utils/pauseManager';
import { getGuildSettings } from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';

const data = new SlashCommandBuilder()
    .setName('pvc_pause')
    .setDescription('Pause the PVC system - disables all voice channel creation and interface commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const guildId = interaction.guild.id;
    if (isPvcPaused(guildId)) {
        await interaction.reply({
            content: '⚠️ The PVC system is already paused. Use `/pvc_resume` to resume it.',
            flags: [MessageFlags.Ephemeral]
        });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
        pausePvc(guildId);
        const settings = await getGuildSettings(guildId);
        const pauseEmbed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('⏸️ PVC System Paused')
            .setDescription(
                '**The Private Voice Channel system has been temporarily paused.**\n\n' +
                'While paused, the following features are disabled:\n\n' +
                '• Creating new voice channels (Join to Create)\n' +
                '• All interface button controls\n' +
                '• Text commands (`!au`, `!ru`, `!l`)\n' +
                '• Channel management actions\n\n' +
                '**Existing channels will remain active** but cannot be modified.\n\n' +
                '_The system will be resumed by a server administrator._'
            )
            .setFooter({ text: `Paused by ${interaction.user.tag}` })
            .setTimestamp();

        if (settings?.interfaceTextId) {
            const interfaceChannel = interaction.guild.channels.cache.get(settings.interfaceTextId);
            if (interfaceChannel && interfaceChannel.type === ChannelType.GuildText) {
                const pauseMessage = await interfaceChannel.send({ embeds: [pauseEmbed] });
                setPauseMessageId(guildId, pauseMessage.id);
            }
        }

        await logAction({
            action: LogAction.PVC_SETUP,
            guild: interaction.guild,
            user: interaction.user,
            details: 'PVC System paused',
        });

        await interaction.editReply(
            '✅ **PVC System Paused**\n\n' +
            'All PVC features have been disabled. Users will see a pause notification when trying to use any PVC feature.\n\n' +
            '• Voice channel creation is disabled\n' +
            '• Interface buttons are disabled\n' +
            '• Text commands are disabled\n\n' +
            'Use `/pvc_resume` to resume the system.'
        );
    } catch {
        await interaction.editReply('❌ Failed to pause the PVC system. Please try again.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

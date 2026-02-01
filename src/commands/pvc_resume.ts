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
import { isPvcPaused, resumePvc, getPauseMessageId, clearPauseMessageId } from '../utils/pauseManager';
import { getGuildSettings } from '../utils/cache';
import { logAction, LogAction } from '../utils/logger';
const data = new SlashCommandBuilder()
    .setName('pvc_resume')
    .setDescription('Resume the PVC system - enables all voice channel creation and interface commands')
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
    if (!isPvcPaused(guildId)) {
        await interaction.reply({
            content: '⚠️ The PVC system is not paused. It is already running normally.',
            flags: [MessageFlags.Ephemeral]
        });
        return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
        resumePvc(guildId);
        const settings = await getGuildSettings(guildId);
        if (settings?.interfaceTextId) {
            const interfaceChannel = interaction.guild.channels.cache.get(settings.interfaceTextId);
            if (interfaceChannel && interfaceChannel.type === ChannelType.GuildText) {
                const pauseMessageId = getPauseMessageId(guildId);
                if (pauseMessageId) {
                    try {
                        const pauseMessage = await interfaceChannel.messages.fetch(pauseMessageId);
                        await pauseMessage.delete();
                    } catch (err) {
                        console.log(`[PVC Resume] Could not delete pause message ${pauseMessageId}:`, err);
                    }
                    clearPauseMessageId(guildId);
                }
                const resumeEmbed = new EmbedBuilder()
                    .setColor(0x57F287)
                    .setTitle('▶️ PVC System Resumed')
                    .setDescription(
                        '**The Private Voice Channel system is now active again!**\n\n' +
                        'All features have been restored:\n\n' +
                        '• Join to Create voice channels\n' +
                        '• Interface button controls\n' +
                        '• Text commands (`!au`, `!ru`, `!l`)\n' +
                        '• All channel management actions\n\n' +
                        '_Enjoy your private voice channels!_'
                    )
                    .setFooter({ text: `Resumed by ${interaction.user.tag}` })
                    .setTimestamp();
                const resumeMessage = await interfaceChannel.send({ embeds: [resumeEmbed] });
                setTimeout(async () => {
                    try {
                        await resumeMessage.delete();
                    } catch (err) {
                        console.log(`[PVC Resume] Could not delete resume notification:`, err);
                    }
                }, 30000);
            }
        }
        await logAction({
            action: LogAction.PVC_SETUP,
            guild: interaction.guild,
            user: interaction.user,
            details: 'PVC System resumed',
        });
        await interaction.editReply(
            '✅ **PVC System Resumed**\n\n' +
            'All PVC features have been re-enabled.\n\n' +
            '• Voice channel creation is active\n' +
            '• Interface buttons are working\n' +
            '• Text commands are enabled\n\n' +
            'The system is now fully operational!'
        );
    } catch (err) {
        console.error('[PVC Resume] Failed to resume PVC system:', err);
        await interaction.editReply('❌ Failed to resume the PVC system. Please try again.');
    }
}
export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

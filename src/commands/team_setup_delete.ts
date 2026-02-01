import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import { unregisterTeamChannel, unregisterTeamInterfaceChannel, type TeamType } from '../utils/voiceManager';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
const data = new SlashCommandBuilder()
    .setName('team_setup_delete')
    .setDescription('Delete the entire Team Voice Channel setup')
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
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
        const guild = interaction.guild;
        const guildId = guild.id;
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId },
            include: {
                teamChannels: true,
            },
        });
        if (!teamSettings) {
            await interaction.editReply('No Team Voice Channel setup found for this server.');
            return;
        }
        let channelsDeleted = 0;
        let errors = 0;
        if (teamSettings.duoVcId) {
            const channel = guild.channels.cache.get(teamSettings.duoVcId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[Team Delete] Failed to delete duo VC ${teamSettings.duoVcId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'duo');
        }
        if (teamSettings.trioVcId) {
            const channel = guild.channels.cache.get(teamSettings.trioVcId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[Team Delete] Failed to delete trio VC ${teamSettings.trioVcId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'trio');
        }
        if (teamSettings.squadVcId) {
            const channel = guild.channels.cache.get(teamSettings.squadVcId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[Team Delete] Failed to delete squad VC ${teamSettings.squadVcId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'squad');
        }
        for (const tc of teamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[Team Delete] Failed to delete team channel ${tc.channelId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamChannel(tc.channelId);
        }
        await prisma.teamVoiceSettings.delete({
            where: { guildId },
        });
        await interaction.editReply(
            `✅ Team Voice Channel System successfully deleted!\n` +
            `- Deleted **${channelsDeleted}** channels.\n` +
            (errors > 0 ? `- ⚠️ ${errors} channel(s) could not be deleted (may have been already deleted).` : '')
        );
    } catch (error) {
        await interaction.editReply('❌ Failed to delete Team Voice Channel setup. Please try again.');
    }
}
export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

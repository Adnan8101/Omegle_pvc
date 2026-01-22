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

        // 1. Fetch current team settings
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId },
            include: {
                teamChannels: true, // Get all active team channels
            },
        });

        if (!teamSettings) {
            await interaction.editReply('No Team Voice Channel setup found for this server.');
            return;
        }

        let channelsDeleted = 0;
        let errors = 0;

        // 2. Delete Duo Interface Channel
        if (teamSettings.duoVcId) {
            const channel = guild.channels.cache.get(teamSettings.duoVcId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'duo');
        }

        // 3. Delete Trio Interface Channel
        if (teamSettings.trioVcId) {
            const channel = guild.channels.cache.get(teamSettings.trioVcId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'trio');
        }

        // 4. Delete Squad Interface Channel
        if (teamSettings.squadVcId) {
            const channel = guild.channels.cache.get(teamSettings.squadVcId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamInterfaceChannel(guildId, 'squad');
        }

        // 5. Delete all active Team Voice Channels
        for (const tc of teamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterTeamChannel(tc.channelId);
        }

        // 6. Delete DB Records (cascade deletes TeamVoiceChannel and TeamVoicePermission)
        await prisma.teamVoiceSettings.delete({
            where: { guildId },
        });

        await interaction.editReply(
            `✅ Team Voice Channel System successfully deleted!\n` +
            `- Deleted **${channelsDeleted}** channels.\n` +
            (errors > 0 ? `- ⚠️ ${errors} channel(s) could not be deleted (may have been already deleted).` : '')
        );
    } catch (error) {
        console.error('Team setup delete error:', error);
        await interaction.editReply('❌ Failed to delete Team Voice Channel setup. Please try again.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

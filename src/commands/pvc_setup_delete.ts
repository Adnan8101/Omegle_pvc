import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    ChannelType,
} from 'discord.js';
import prisma from '../utils/database';
import { unregisterInterfaceChannel, unregisterChannel } from '../utils/voiceManager';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';

const data = new SlashCommandBuilder()
    .setName('pvc_setup_delete')
    .setDescription('Delete the entire PVC setup (channels, settings, and database entries)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const guild = interaction.guild;
        const guildId = guild.id;

        // 1. Fetch current settings to get channel IDs
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId },
            include: {
                privateChannels: true, // Get all active PVCs
            },
        });

        if (!settings) {
            await interaction.editReply('No PVC setup found for this server.');
            return;
        }

        let channelsDeleted = 0;
        let errors = 0;

        // 2. Delete Interface Text Channel
        if (settings.interfaceTextId) {
            const channel = guild.channels.cache.get(settings.interfaceTextId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
        }

        // 3. Delete "Join to Create" Voice Channel
        if (settings.interfaceVcId) {
            const channel = guild.channels.cache.get(settings.interfaceVcId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            // Cleanup memory
            unregisterInterfaceChannel(guildId);
        }

        // 4. Delete all active Private Voice Channels
        for (const pvc of settings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel) {
                await channel.delete().catch(() => {
                    errors++;
                });
                channelsDeleted++;
            }
            // Cleanup memory (though DB delete handles sync usually, good to be safe)
            unregisterChannel(pvc.channelId);
        }

        // 5. Delete DB Records
        // Deleting GuildSettings cascades to PrivateVoiceChannel and VoicePermission
        await prisma.guildSettings.delete({
            where: { guildId },
        });

        // 6. Delete Strictness Whitelist (No relation, manual delete)
        await prisma.strictnessWhitelist.deleteMany({
            where: { guildId },
        });

        await interaction.editReply(
            `✅ PVC System successfully deleted!\n` +
            `- Deleted **${channelsDeleted}** channels.\n` +
            `- Removed database settings, active channels, permissions, and whitelist.\n` +
            (errors > 0 ? `⚠️ Encountered **${errors}** errors (some channels might have been already deleted).` : '')
        );

    } catch {
        await interaction.editReply('An error occurred while cleaning up the PVC system.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

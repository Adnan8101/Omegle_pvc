import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
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
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId },
            include: {
                privateChannels: true,
            },
        });
        if (!settings) {
            await interaction.editReply('No PVC setup found for this server.');
            return;
        }
        let channelsDeleted = 0;
        let errors = 0;
        if (settings.interfaceTextId) {
            const channel = guild.channels.cache.get(settings.interfaceTextId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[PVC Delete] Failed to delete interface text channel ${settings.interfaceTextId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
        }
        if (settings.interfaceVcId) {
            const channel = guild.channels.cache.get(settings.interfaceVcId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[PVC Delete] Failed to delete interface VC ${settings.interfaceVcId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterInterfaceChannel(guildId);
        }
        for (const pvc of settings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel) {
                await channel.delete().catch((err) => {
                    console.error(`[PVC Delete] Failed to delete PVC ${pvc.channelId}:`, err);
                    errors++;
                });
                channelsDeleted++;
            }
            unregisterChannel(pvc.channelId);
        }
        await prisma.guildSettings.delete({
            where: { guildId },
        });
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

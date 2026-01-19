import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';

const data = new SlashCommandBuilder()
    .setName('pvc_status')
    .setDescription('Show PVC system status and all setups')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const guild = interaction.guild;

        // Get guild settings
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId: guild.id },
            include: {
                privateChannels: true,
            },
        });

        if (!settings) {
            await interaction.editReply('PVC system is not set up in this server. Use `/pvc_setup` to configure it.');
            return;
        }

        // Get channel info
        const interfaceTextChannel = settings.interfaceTextId
            ? guild.channels.cache.get(settings.interfaceTextId)
            : null;
        const interfaceVcChannel = settings.interfaceVcId
            ? guild.channels.cache.get(settings.interfaceVcId)
            : null;

        // Build status embed
        const embed = new EmbedBuilder()
            .setTitle('PVC System Status')
            .setColor(settings.adminStrictness ? 0x00FF00 : 0xFF0000)
            .addFields(
                {
                    name: 'Admin Strictness',
                    value: settings.adminStrictness ? '**ON** - Non-permitted users will be disconnected' : '**OFF** - Standard Discord permissions apply',
                    inline: false,
                },
                {
                    name: 'Control Panel Channel',
                    value: interfaceTextChannel ? `${interfaceTextChannel}` : 'Not found (deleted?)',
                    inline: true,
                },
                {
                    name: 'Join to Create VC',
                    value: interfaceVcChannel ? `${interfaceVcChannel}` : 'Not found (deleted?)',
                    inline: true,
                },
                {
                    name: 'Active Private Channels',
                    value: `${settings.privateChannels.length} channel(s)`,
                    inline: true,
                },
            )
            .setTimestamp();

        // List active channels if any
        if (settings.privateChannels.length > 0) {
            const channelList = settings.privateChannels.slice(0, 10).map((pvc: { channelId: string; ownerId: string }) => {
                const channel = guild.channels.cache.get(pvc.channelId);
                const owner = guild.members.cache.get(pvc.ownerId);
                return `• ${channel ? channel.name : 'Unknown'} - Owner: ${owner ? owner.displayName : pvc.ownerId}`;
            }).join('\n');

            embed.addFields({
                name: 'Active Channels (showing up to 10)',
                value: channelList || 'None',
                inline: false,
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch {
        await interaction.editReply('Failed to get PVC status.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

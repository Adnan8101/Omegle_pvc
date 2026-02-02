import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    EmbedBuilder,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
import { validateServerCommand, validateAdminCommand } from '../utils/commandValidation';
const data = new SlashCommandBuilder()
    .setName('pvc_status')
    .setDescription('Show PVC system status and all setups')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);
async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!await validateServerCommand(interaction)) return;
    if (!await validateAdminCommand(interaction)) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
        const guild = interaction.guild;
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId: guild.id },
            include: {
                privateChannels: true,
            },
        });
        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
            include: {
                teamChannels: true,
            },
        });
        if (!settings) {
            await interaction.editReply('PVC system is not set up in this server. Use `/pvc_setup` to configure it.');
            return;
        }
        const interfaceTextChannel = settings.interfaceTextId
            ? guild.channels.cache.get(settings.interfaceTextId)
            : null;
        const interfaceVcChannel = settings.interfaceVcId
            ? guild.channels.cache.get(settings.interfaceVcId)
            : null;
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
                {
                    name: 'Active Team Channels',
                    value: teamSettings ? `${teamSettings.teamChannels.length} channel(s)` : 'Team system not set up',
                    inline: true,
                },
            )
            .setTimestamp();
        if (settings.privateChannels.length > 0) {
            const channelList = settings.privateChannels.slice(0, 10).map((pvc: { channelId: string; ownerId: string }) => {
                const channel = guild.channels.cache.get(pvc.channelId);
                const owner = guild.members.cache.get(pvc.ownerId);
                return `• ${channel ? channel.name : 'Unknown'} - Owner: ${owner ? owner.displayName : pvc.ownerId}`;
            }).join('\n');
            embed.addFields({
                name: 'Active PVC Channels (showing up to 10)',
                value: channelList || 'None',
                inline: false,
            });
        }
        if (teamSettings && teamSettings.teamChannels.length > 0) {
            const channelList = teamSettings.teamChannels.slice(0, 10).map((tc: { channelId: string; ownerId: string; teamType: string }) => {
                const channel = guild.channels.cache.get(tc.channelId);
                const owner = guild.members.cache.get(tc.ownerId);
                const typeEmoji = tc.teamType === 'DUO' ? '' : tc.teamType === 'TRIO' ? '' : '';
                return `• ${channel ? channel.name : 'Unknown'} ${typeEmoji} - Owner: ${owner ? owner.displayName : tc.ownerId}`;
            }).join('\n');
            embed.addFields({
                name: 'Active Team Channels (showing up to 10)',
                value: channelList || 'None',
                inline: false,
            });
        }
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[PVC Status] Failed to get status:', err);
        await interaction.editReply('Failed to get PVC status. Check logs for details.');
    }
}
export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

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

const data = new SlashCommandBuilder()
    .setName('team_status')
    .setDescription('Show Team Voice Channel system status')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: 'You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
        const guild = interaction.guild;

        const guildSettings = await prisma.guildSettings.findUnique({
            where: { guildId: guild.id },
        });

        const teamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
            include: {
                teamChannels: true,
            },
        });

        if (!teamSettings) {
            await interaction.editReply('Team Voice Channel system is not set up in this server. Use `/team_setup` to configure it.');
            return;
        }

        const duoInterfaceChannel = teamSettings.duoVcId
            ? guild.channels.cache.get(teamSettings.duoVcId)
            : null;
        const trioInterfaceChannel = teamSettings.trioVcId
            ? guild.channels.cache.get(teamSettings.trioVcId)
            : null;
        const squadInterfaceChannel = teamSettings.squadVcId
            ? guild.channels.cache.get(teamSettings.squadVcId)
            : null;

        const duoCount = teamSettings.teamChannels.filter((c: any) => c.teamType === 'DUO').length;
        const trioCount = teamSettings.teamChannels.filter((c: any) => c.teamType === 'TRIO').length;
        const squadCount = teamSettings.teamChannels.filter((c: any) => c.teamType === 'SQUAD').length;
        const totalCount = duoCount + trioCount + squadCount;

        const adminStrictness = guildSettings?.adminStrictness ?? false;

        const embed = new EmbedBuilder()
            .setTitle('Team Voice Channel System Status')
            .setColor(adminStrictness ? 0x00FF00 : 0xFF0000)
            .addFields(
                {
                    name: 'Admin Strictness',
                    value: adminStrictness ? '**ON** - Non-permitted users will be disconnected' : '**OFF** - Standard Discord permissions apply',
                    inline: false,
                },
                {
                    name: 'Create Duo Channel',
                    value: duoInterfaceChannel ? `${duoInterfaceChannel}` : 'Not found (deleted?)',
                    inline: true,
                },
                {
                    name: 'Create Trio Channel',
                    value: trioInterfaceChannel ? `${trioInterfaceChannel}` : 'Not found (deleted?)',
                    inline: true,
                },
                {
                    name: 'Create Squad Channel',
                    value: squadInterfaceChannel ? `${squadInterfaceChannel}` : 'Not found (deleted?)',
                    inline: true,
                },
                {
                    name: 'Active Duo Channels',
                    value: `${duoCount} channel(s)`,
                    inline: true,
                },
                {
                    name: 'Active Trio Channels',
                    value: `${trioCount} channel(s)`,
                    inline: true,
                },
                {
                    name: 'Active Squad Channels',
                    value: `${squadCount} channel(s)`,
                    inline: true,
                },
            )
            .setTimestamp();

        if (teamSettings.teamChannels.length > 0) {
            const channelList = teamSettings.teamChannels.slice(0, 10).map((tc: { channelId: string; ownerId: string; teamType: string }) => {
                const channel = guild.channels.cache.get(tc.channelId);
                const owner = guild.members.cache.get(tc.ownerId);
                const typeEmoji = tc.teamType === 'DUO' ? '👥' : tc.teamType === 'TRIO' ? '👥' : '👥';
                return `• ${channel ? channel.name : 'Unknown'} ${typeEmoji} - Owner: ${owner ? owner.displayName : tc.ownerId}`;
            }).join('\n');

            embed.addFields({
                name: `Active Team Channels (showing up to 10)`,
                value: channelList || 'None',
                inline: false,
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.editReply('Failed to get team status.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

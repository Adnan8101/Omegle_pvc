import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    ChannelType,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { getChannelByOwner, getTeamChannelByOwner } from '../utils/voiceManager';
const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];
const data = new SlashCommandBuilder()
    .setName('show_access')
    .setDescription('[DEVELOPER] Show information about voice channel and access permissions')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('User to check access for (developer only)')
            .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
    .setDMPermission(false);
async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        await interaction.reply({ content: '❌ This command is restricted to developers only.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const targetUser = interaction.options.getUser('user');
    const userId = targetUser ? targetUser.id : interaction.user.id;
    let channelId = getChannelByOwner(interaction.guild.id, userId);
    let isTeamChannel = false;
    if (!channelId) {
        channelId = getTeamChannelByOwner(interaction.guild.id, userId);
        isTeamChannel = Boolean(channelId);
    }
    if (!channelId) {
        const pvcData = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: interaction.guild.id, ownerId: userId },
        });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: interaction.guild.id, ownerId: userId },
        }) : null;
        channelId = pvcData?.channelId || teamData?.channelId;
        isTeamChannel = Boolean(teamData);
    }
    if (!channelId) {
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: interaction.guild.id, ownerId: userId },
            orderBy: { createdAt: 'desc' },
        });
        if (permanentAccess.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Permanent Access List')
                .setDescription(`${targetUser ? `<@${userId}>` : 'You'} ${targetUser ? 'has' : 'have'} no users with permanent access and no active voice channel.`)
                .setFooter({ text: 'Use /permanent_access add @user to add someone' })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            return;
        }
        const userList = permanentAccess.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`Permanent Access List${targetUser ? ` - ${targetUser.tag}` : ''}`)
            .setDescription(userList)
            .setFooter({ text: `${permanentAccess.length} user(s) • /permanent_access add/remove` })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        return;
    }
    const channel = interaction.guild.channels.cache.get(channelId);
    const pvcData = await prisma.privateVoiceChannel.findUnique({
        where: { channelId },
        include: { permissions: true },
    });
    const teamData = await prisma.teamVoiceChannel.findUnique({
        where: { channelId },
        include: { permissions: true },
    });
    if (!pvcData && !teamData) {
        const embed = new EmbedBuilder()
            .setDescription('Channel data not found.')
            .setColor(0xFF0000);
        await interaction.editReply({ embeds: [embed] });
        return;
    }
    const channelData = pvcData || teamData;
    const owner = interaction.guild.members.cache.get(channelData!.ownerId);
    const permittedUsers = channelData!.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
    const bannedUsers = channelData!.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');
    const permanentCount = await prisma.ownerPermission.count({
        where: { guildId: interaction.guild.id, ownerId: userId },
    });
    const channelTypeDisplay = isTeamChannel
        ? `Team Channel (${teamData!.teamType})`
        : 'Private Voice Channel';
    const embed = new EmbedBuilder()
        .setTitle(`Voice Channel Information${targetUser ? ` - ${targetUser.tag}` : ''}`)
        .setColor(0x5865F2)
        .setDescription(`**Channel:** ${channel?.name || 'Unknown'}\n**Owner:** ${owner ? `${owner}` : `<@${channelData!.ownerId}>`}\n**Type:** ${channelTypeDisplay}\n**Members:** ${channel && channel.type === ChannelType.GuildVoice ? `${channel.members.size}` : '-'}`)
        .addFields(
            { name: 'Permitted Users', value: permittedUsers.length > 0 ? permittedUsers.slice(0, 10).map(p => `<@${p.targetId}>`).join(', ') + (permittedUsers.length > 10 ? ` +${permittedUsers.length - 10} more` : '') : 'None', inline: false },
            { name: 'Blocked Users', value: bannedUsers.length > 0 ? bannedUsers.slice(0, 5).map(p => `<@${p.targetId}>`).join(', ') + (bannedUsers.length > 5 ? ` +${bannedUsers.length - 5} more` : '') : 'None', inline: false },
            { name: 'Permanent Access', value: `${permanentCount} user(s)`, inline: true }
        )
        .setFooter({ text: `Channel ID: ${channelId} • Developer View` })
        .setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`dev_list_normal_${userId}`)
            .setLabel('Channel Info')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`dev_list_permanent_${userId}`)
            .setLabel('Permanent Access')
            .setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
}
export const command: Command = { data: data as any, execute };

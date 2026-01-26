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

    // Check if user is developer
    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        await interaction.reply({ content: '❌ This command is restricted to developers only.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    // Check if developer wants to see another user's access
    const targetUser = interaction.options.getUser('user');
    const userId = targetUser ? targetUser.id : interaction.user.id;

    // Find the user's owned channel (PVC or Team VC)
    let channelId = getChannelByOwner(interaction.guild.id, userId);
    if (!channelId) {
        channelId = getTeamChannelByOwner(interaction.guild.id, userId);
    }

    // If no owned channel, show permanent access list
    if (!channelId) {
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: interaction.guild.id, ownerId: userId },
            orderBy: { createdAt: 'desc' },
        });

        if (permanentAccess.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Permanent Access List')
                .setDescription(`${targetUser ? `<@${userId}>` : 'You'} ${targetUser ? 'has' : 'have'} no users with permanent access.`)
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

    // Get channel data
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
    const isTeamChannel = Boolean(teamData);
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
        .addFields(
            { name: 'Type', value: channelTypeDisplay, inline: true },
            { name: 'Channel', value: channel?.name || 'Unknown', inline: true },
            { name: 'Owner', value: owner ? `${owner}` : `<@${channelData!.ownerId}>`, inline: true },
            { name: 'Members', value: channel && channel.type === ChannelType.GuildVoice ? `${channel.members.size}` : '-', inline: true },
        );

    if (permittedUsers.length > 0) {
        const userMentions = permittedUsers.slice(0, 10).map(p => `<@${p.targetId}>`).join(', ');
        const more = permittedUsers.length > 10 ? ` +${permittedUsers.length - 10} more` : '';
        embed.addFields({ name: `Permitted (${permittedUsers.length})`, value: userMentions + more, inline: false });
    }

    if (bannedUsers.length > 0) {
        const bannedMentions = bannedUsers.slice(0, 5).map(p => `<@${p.targetId}>`).join(', ');
        const more = bannedUsers.length > 5 ? ` +${bannedUsers.length - 5} more` : '';
        embed.addFields({ name: `Blocked (${bannedUsers.length})`, value: bannedMentions + more, inline: false });
    }

    embed.addFields({ name: 'Permanent Access', value: `${permanentCount} user(s)`, inline: true });
    embed.setFooter({ text: 'Use /permanent_access to manage trusted users' }).setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`list_permanent_${userId}_${interaction.user.id}`)
            .setLabel('View Permanent Access')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.editReply({ embeds: [embed], components: [row] });

    // Set up button collector
    const collector = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id && i.customId === `list_permanent_${userId}_${interaction.user.id}`,
        time: 60000,
        max: 1,
    });

    collector.on('collect', async (buttonInteraction) => {
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: interaction.guild!.id, ownerId: userId },
            orderBy: { createdAt: 'desc' },
        });

        const permEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`Permanent Access List${targetUser ? ` - ${targetUser.tag}` : ''}`);

        if (permanentAccess.length === 0) {
            permEmbed.setDescription('No users with permanent access.');
        } else {
            const userList = permanentAccess.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            permEmbed.setDescription(userList);
        }

        permEmbed.setFooter({ text: '/permanent_access add/remove' }).setTimestamp();

        await buttonInteraction.update({ embeds: [permEmbed], components: [] }).catch(() => { });
    });

    collector.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => { });
    });
}

export const command: Command = { data: data as any, execute };

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    EmbedBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';

const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];

const data = new SlashCommandBuilder()
    .setName('show_access')
    .setDescription('Show all access permissions for a user (Bot Developer only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addUserOption(option =>
        option
            .setName('user')
            .setDescription('The user to check')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Only bot developers can use this
    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        await interaction.reply({ content: '❌ This command is only available to bot developers.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const targetUser = interaction.options.getUser('user', true);

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
        // Get all PVCs in this guild first
        const guildPVCs = await prisma.privateVoiceChannel.findMany({
            where: { guildId: interaction.guild.id },
            select: { channelId: true, ownerId: true },
        });
        const pvcChannelIds = guildPVCs.map(p => p.channelId);

        // Get all Team VCs in this guild
        const guildTeamVCs = await prisma.teamVoiceChannel.findMany({
            where: { guildId: interaction.guild.id },
            select: { channelId: true, ownerId: true, teamType: true },
        });
        const teamChannelIds = guildTeamVCs.map(t => t.channelId);

        // Get PVC permissions for this user in guild channels
        const pvcPermissions = await prisma.voicePermission.findMany({
            where: {
                targetId: targetUser.id,
                targetType: 'user',
                channelId: { in: pvcChannelIds },
            },
        });

        // Get Team VC permissions for this user in guild channels
        const teamPermissions = await prisma.teamVoicePermission.findMany({
            where: {
                targetId: targetUser.id,
                targetType: 'user',
                channelId: { in: teamChannelIds },
            },
        });

        // Get permanent access grants
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: {
                guildId: interaction.guild.id,
                targetId: targetUser.id,
                targetType: 'user',
            },
        });

        // Build embed
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`🔍 Access Overview for ${targetUser.username}`)
            .setThumbnail(targetUser.displayAvatarURL())
            .setTimestamp();

        // PVC Permissions
        const pvcPermitList: string[] = [];
        const pvcBanList: string[] = [];

        for (const perm of pvcPermissions) {
            const channelMention = `<#${perm.channelId}>`;
            if (perm.permission === 'permit') {
                pvcPermitList.push(channelMention);
            } else if (perm.permission === 'ban') {
                pvcBanList.push(channelMention);
            }
        }

        if (pvcPermitList.length > 0) {
            embed.addFields({
                name: `✅ PVC Access (${pvcPermitList.length})`,
                value: pvcPermitList.slice(0, 10).join(', ') + (pvcPermitList.length > 10 ? `\n...and ${pvcPermitList.length - 10} more` : ''),
                inline: false,
            });
        }

        if (pvcBanList.length > 0) {
            embed.addFields({
                name: `🚫 PVC Blocked (${pvcBanList.length})`,
                value: pvcBanList.slice(0, 10).join(', ') + (pvcBanList.length > 10 ? `\n...and ${pvcBanList.length - 10} more` : ''),
                inline: false,
            });
        }

        // Team VC Permissions
        const teamPermitList: string[] = [];
        const teamBanList: string[] = [];

        for (const perm of teamPermissions) {
            const channelMention = `<#${perm.channelId}>`;
            if (perm.permission === 'permit') {
                teamPermitList.push(channelMention);
            } else if (perm.permission === 'ban') {
                teamBanList.push(channelMention);
            }
        }

        if (teamPermitList.length > 0) {
            embed.addFields({
                name: `✅ Team VC Access (${teamPermitList.length})`,
                value: teamPermitList.slice(0, 10).join(', ') + (teamPermitList.length > 10 ? `\n...and ${teamPermitList.length - 10} more` : ''),
                inline: false,
            });
        }

        if (teamBanList.length > 0) {
            embed.addFields({
                name: `🚫 Team VC Blocked (${teamBanList.length})`,
                value: teamBanList.slice(0, 10).join(', ') + (teamBanList.length > 10 ? `\n...and ${teamBanList.length - 10} more` : ''),
                inline: false,
            });
        }

        // Permanent Access
        if (permanentAccess.length > 0) {
            const permanentOwners = permanentAccess.map(pa => `<@${pa.ownerId}>`).slice(0, 10);
            embed.addFields({
                name: `⭐ Permanent Access (${permanentAccess.length})`,
                value: `Can access channels owned by:\n${permanentOwners.join(', ')}` + (permanentAccess.length > 10 ? `\n...and ${permanentAccess.length - 10} more` : ''),
                inline: false,
            });
        }

        // Summary
        const totalAccess = pvcPermitList.length + teamPermitList.length;
        const totalBlocked = pvcBanList.length + teamBanList.length;

        if (totalAccess === 0 && totalBlocked === 0 && permanentAccess.length === 0) {
            embed.setDescription('❌ This user has no access permissions, blocks, or permanent access grants.');
        } else {
            embed.setDescription(
                `**Summary:**\n` +
                `• Access: ${totalAccess} channel${totalAccess !== 1 ? 's' : ''}\n` +
                `• Blocked: ${totalBlocked} channel${totalBlocked !== 1 ? 's' : ''}\n` +
                `• Permanent: ${permanentAccess.length} owner${permanentAccess.length !== 1 ? 's' : ''}`
            );
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[ShowAccess] Error:', error);
        await interaction.editReply({ content: '❌ An error occurred while fetching access information.' });
    }
}

export const command: Command = { data: data as any, execute };

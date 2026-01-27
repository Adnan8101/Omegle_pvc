import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
    EmbedBuilder,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';

const data = new SlashCommandBuilder()
    .setName('counting')
    .setDescription('Manage the counting game system')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addSubcommand(subcommand =>
        subcommand
            .setName('enable')
            .setDescription('Enable counting in a channel')
            .addChannelOption(option =>
                option
                    .setName('channel')
                    .setDescription('The channel for counting')
                    .setRequired(true)
                    .addChannelTypes(ChannelType.GuildText)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('disable')
            .setDescription('Disable counting in the current channel')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('show')
            .setDescription('Show counting status for this server')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('reset')
            .setDescription('Reset the counting to start from 1')
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('leaderboard')
            .setDescription('Show top counters in this server')
            .addIntegerOption(option =>
                option
                    .setName('top')
                    .setDescription('Number of users to show (default: 10)')
                    .setMinValue(1)
                    .setMaxValue(25)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('stats')
            .setDescription('Show counting stats for a user')
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('The user to check (default: yourself)')
            )
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'enable') {
        const channel = interaction.options.getChannel('channel', true);

        if (channel.type !== ChannelType.GuildText) {
            await interaction.reply({ content: '❌ Please select a text channel.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        // Check if bot has necessary permissions in the channel
        const botMember = interaction.guild.members.me;
        if (!botMember) {
            await interaction.reply({ content: '❌ Could not find bot member in guild.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        // Fetch the full channel object to check permissions
        const fullChannel = await interaction.guild.channels.fetch(channel.id);
        if (!fullChannel || !fullChannel.isTextBased()) {
            await interaction.reply({ content: '❌ Could not access the channel.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        const permissions = fullChannel.permissionsFor(botMember);
        if (!permissions?.has(['ViewChannel', 'SendMessages', 'ManageMessages', 'AddReactions', 'ReadMessageHistory'])) {
            await interaction.reply({ 
                content: '❌ Bot needs the following permissions in that channel:\n• View Channel\n• Send Messages\n• Manage Messages (to delete wrong counts)\n• Add Reactions (to react with ✅)\n• Read Message History', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        try {
            await prisma.countingSettings.upsert({
                where: { guildId: interaction.guild.id },
                update: {
                    channelId: channel.id,
                    enabled: true,
                    currentCount: 0,
                    lastUserId: null,
                },
                create: {
                    guildId: interaction.guild.id,
                    channelId: channel.id,
                    enabled: true,
                    currentCount: 0,
                },
            });

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`✅ **Counting Enabled**\n\nChannel: ${channel}\nStart from: **1**`)
                .setFooter({ text: 'Users will count starting from 1' });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error enabling counting:', error);
            await interaction.reply({ content: '❌ Failed to enable counting. Check database connection.', flags: [MessageFlags.Ephemeral] });
        }
    } else if (subcommand === 'disable') {
        try {
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: interaction.guild.id },
            });

            if (!settings) {
                await interaction.reply({ content: '❌ Counting is not set up in this server.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            await prisma.countingSettings.update({
                where: { guildId: interaction.guild.id },
                data: { enabled: false },
            });

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setDescription('🔴 **Counting Disabled**\n\nCounting has been turned off.')
                .setFooter({ text: 'Use /counting enable to turn it back on' });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error disabling counting:', error);
            await interaction.reply({ content: '❌ Failed to disable counting.', flags: [MessageFlags.Ephemeral] });
        }
    } else if (subcommand === 'show') {
        try {
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: interaction.guild.id },
            });

            if (!settings) {
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setDescription('❌ **Counting Not Set Up**\n\nUse `/counting enable` to set up the counting game.');

                await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
                return;
            }

            const channel = interaction.guild.channels.cache.get(settings.channelId);
            const status = settings.enabled ? '🟢 Enabled' : '🔴 Disabled';

            const embed = new EmbedBuilder()
                .setColor(settings.enabled ? 0x00FF00 : 0xFF0000)
                .setTitle('📊 Counting Status')
                .addFields(
                    { name: 'Status', value: status, inline: true },
                    { name: 'Channel', value: channel ? `${channel}` : 'Unknown', inline: true },
                    { name: 'Current Count', value: `**${settings.currentCount}**`, inline: true },
                    { name: 'Next Number', value: `**${settings.currentCount + 1}**`, inline: true }
                )
                .setFooter({ text: 'Keep counting!' });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error showing status:', error);
            await interaction.reply({ content: '❌ Failed to get counting status.', flags: [MessageFlags.Ephemeral] });
        }
    } else if (subcommand === 'reset') {
        try {
            const settings = await prisma.countingSettings.findUnique({
                where: { guildId: interaction.guild.id },
            });

            if (!settings) {
                await interaction.reply({ content: '❌ Counting is not set up in this server.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            await prisma.countingSettings.update({
                where: { guildId: interaction.guild.id },
                data: {
                    currentCount: 0,
                    lastUserId: null,
                },
            });

            const embed = new EmbedBuilder()
                .setColor(0xFFAA00)
                .setDescription('🔄 **Counting Reset**\n\nStart from: **1**')
                .setFooter({ text: 'Let\'s count again!' });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error resetting counting:', error);
            await interaction.reply({ content: '❌ Failed to reset counting.', flags: [MessageFlags.Ephemeral] });
        }
    } else if (subcommand === 'leaderboard') {
        try {
            const topCount = interaction.options.getInteger('top') || 10;

            const topUsers = await prisma.countingUserStats.findMany({
                where: { guildId: interaction.guild.id },
                orderBy: { counting: 'desc' },
                take: topCount,
            });

            if (topUsers.length === 0) {
                await interaction.reply({ content: '📊 No counting stats yet. Start counting!', flags: [MessageFlags.Ephemeral] });
                return;
            }

            const leaderboardText = topUsers
                .map((stat, index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                    return `${medal} <@${stat.userId}> - **${stat.counting}** counts`;
                })
                .join('\n');

            const embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('📊 Counting Leaderboard')
                .setDescription(leaderboardText)
                .setFooter({ text: `Top ${topUsers.length} counters` });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error showing leaderboard:', error);
            await interaction.reply({ content: '❌ Failed to get leaderboard.', flags: [MessageFlags.Ephemeral] });
        }
    } else if (subcommand === 'stats') {
        try {
            const targetUser = interaction.options.getUser('user') || interaction.user;

            const stats = await prisma.countingUserStats.findUnique({
                where: {
                    guildId_userId: {
                        guildId: interaction.guild.id,
                        userId: targetUser.id,
                    },
                },
            });

            const countingSettings = await prisma.countingSettings.findUnique({
                where: { guildId: interaction.guild.id },
            });

            if (!stats || stats.counting === 0) {
                await interaction.reply({
                    content: `📊 ${targetUser} hasn't counted any numbers yet.`,
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }

            // Get user's rank
            const allStats = await prisma.countingUserStats.findMany({
                where: { guildId: interaction.guild.id },
                orderBy: { counting: 'desc' },
            });

            const rank = allStats.findIndex(s => s.userId === targetUser.id) + 1;
            const totalCounts = countingSettings?.currentCount || 0;
            const percentage = totalCounts > 0 ? ((stats.counting / totalCounts) * 100).toFixed(1) : '0';

            const embed = new EmbedBuilder()
                .setColor(0x00BFFF)
                .setTitle(`📊 Counting Stats`)
                .setThumbnail(targetUser.displayAvatarURL())
                .addFields(
                    { name: 'User', value: `${targetUser}`, inline: true },
                    { name: 'Total Counts', value: `**${stats.counting}**`, inline: true },
                    { name: 'Rank', value: `**#${rank}**`, inline: true },
                    { name: 'Contribution', value: `**${percentage}%**`, inline: true }
                )
                .setFooter({ text: `Keep counting! Current server count: ${totalCounts}` });

            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            console.error('[Counting] Error showing stats:', error);
            await interaction.reply({ content: '❌ Failed to get stats.', flags: [MessageFlags.Ephemeral] });
        }
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
import { Priority, executeWithRateLimit } from '../utils/rateLimit';

const data: SlashCommandSubcommandsOnlyBuilder = new SlashCommandBuilder()
    .setName('global_vc_block')
    .setDescription('Manage global voice channel blocks (prevents users from joining ANY VC)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(subcommand =>
        subcommand
            .setName('add')
            .setDescription('Block a user from joining any voice channel')
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('The user to block')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName('reason')
                    .setDescription('Reason for the block')
                    .setRequired(false)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('remove')
            .setDescription('Unblock a user from joining voice channels')
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('The user to unblock')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('show')
            .setDescription('Show all globally blocked users')
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Only bot owner, developer, or admins with higher role than bot can use this
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
        if (subcommand === 'add') {
            await handleAdd(interaction);
        } else if (subcommand === 'remove') {
            await handleRemove(interaction);
        } else if (subcommand === 'show') {
            await handleShow(interaction);
        }
    } catch (error) {
        console.error('[GlobalVCBlock] Command error:', error);
        const content = '❌ An error occurred while processing your request.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content, flags: [MessageFlags.Ephemeral] });
        } else {
            await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        }
    }
}

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (user.bot) {
        await interaction.reply({ content: '❌ Cannot block bots.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Check if already blocked
    const existing = await prisma.globalVCBlock.findUnique({
        where: {
            guildId_userId: {
                guildId: interaction.guild!.id,
                userId: user.id,
            },
        },
    });

    if (existing) {
        await interaction.reply({ content: `❌ ${user.tag} is already globally blocked.`, flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Add block
    await prisma.globalVCBlock.create({
        data: {
            guildId: interaction.guild!.id,
            userId: user.id,
            blockedBy: interaction.user.id,
            reason,
        },
    });

    // Kick the user from all voice channels they're currently in
    const member = await interaction.guild!.members.fetch(user.id).catch(() => null);
    if (member?.voice.channelId) {
        await executeWithRateLimit(
            `kick:${member.id}`,
            () => member.voice.disconnect('Globally blocked from all voice channels'),
            Priority.IMMEDIATE
        ).catch(err => {
            console.error(`[GlobalVCBlock] Failed to kick ${user.id}:`, err);
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('🚫 Global VC Block Added')
        .setDescription(`**${user.tag}** has been blocked from joining any voice channel.`)
        .addFields(
            { name: 'User', value: `<@${user.id}>`, inline: true },
            { name: 'Blocked By', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Reason', value: reason, inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    const user = interaction.options.getUser('user', true);

    // Check if blocked
    const existing = await prisma.globalVCBlock.findUnique({
        where: {
            guildId_userId: {
                guildId: interaction.guild!.id,
                userId: user.id,
            },
        },
    });

    if (!existing) {
        await interaction.reply({ content: `❌ ${user.tag} is not globally blocked.`, flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Remove block
    await prisma.globalVCBlock.delete({
        where: {
            guildId_userId: {
                guildId: interaction.guild!.id,
                userId: user.id,
            },
        },
    });

    const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('✅ Global VC Block Removed')
        .setDescription(`**${user.tag}** can now join voice channels again.`)
        .addFields(
            { name: 'User', value: `<@${user.id}>`, inline: true },
            { name: 'Unblocked By', value: `<@${interaction.user.id}>`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
    const blocks = await prisma.globalVCBlock.findMany({
        where: { guildId: interaction.guild!.id },
        orderBy: { createdAt: 'desc' },
    });

    if (blocks.length === 0) {
        await interaction.reply({ content: '✅ No users are currently globally blocked.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('🚫 Globally Blocked Users')
        .setDescription(`Total: ${blocks.length} user${blocks.length !== 1 ? 's' : ''}`)
        .setTimestamp();

    for (const block of blocks.slice(0, 25)) { // Discord limit: 25 fields
        const reason = block.reason || 'No reason';
        const timestamp = `<t:${Math.floor(block.createdAt.getTime() / 1000)}:R>`;
        embed.addFields({
            name: `<@${block.userId}>`,
            value: `**Reason:** ${reason}\n**Blocked:** ${timestamp}\n**By:** <@${block.blockedBy}>`,
            inline: false,
        });
    }

    if (blocks.length > 25) {
        embed.setFooter({ text: `Showing 25 of ${blocks.length} blocked users` });
    }

    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

export const command: Command = { data: data as any, execute };

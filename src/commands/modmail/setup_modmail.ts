import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../../utils/database';
import type { Command } from '../../client';

const data = new SlashCommandBuilder()
    .setName('setup_modmail')
    .setDescription('Set up the ModMail system categories and roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('category')
            .setDescription('Category for Open Tickets')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption(option =>
        option
            .setName('closed_category')
            .setDescription('Category for Closed Tickets')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption(option =>
        option
            .setName('logs_channel')
            .setDescription('Channel for Ticket Logs')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption(option =>
        option
            .setName('staff_role')
            .setDescription('Role that can manage tickets')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const category = interaction.options.getChannel('category', true);
    const closedCategory = interaction.options.getChannel('closed_category', true);
    const logsChannel = interaction.options.getChannel('logs_channel', true);
    const staffRole = interaction.options.getRole('staff_role', true);

    await prisma.modMailSettings.upsert({
        where: { guildId: interaction.guild.id },
        update: {
            categoryId: category.id,
            closedCategoryId: closedCategory.id,
            logsChannelId: logsChannel.id,
            staffRoleId: staffRole.id
        },
        create: {
            guildId: interaction.guild.id,
            categoryId: category.id,
            closedCategoryId: closedCategory.id,
            logsChannelId: logsChannel.id,
            staffRoleId: staffRole.id
        }
    });

    await interaction.reply({ content: '✅ ModMail system configured successfully!', flags: [MessageFlags.Ephemeral] });
}

export const command: Command = {
    data: data as any,
    execute
};

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
const data: SlashCommandSubcommandsOnlyBuilder = new SlashCommandBuilder()
    .setName('wv_allowed_roles')
    .setDescription('Manage roles allowed to use !wv command')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(subcommand =>
        subcommand
            .setName('add')
            .setDescription('Add a role to the allowed list')
            .addRoleOption(option =>
                option
                    .setName('role')
                    .setDescription('The role to allow')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('remove')
            .setDescription('Remove a role from the allowed list')
            .addRoleOption(option =>
                option
                    .setName('role')
                    .setDescription('The role to remove')
                    .setRequired(true)
            )
    )
    .addSubcommand(subcommand =>
        subcommand
            .setName('show')
            .setDescription('Show all allowed roles')
    );
async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }
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
        console.error('[WvAllowedRoles] Command error:', error);
        const content = '❌ An error occurred while processing your request.';
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content, flags: [MessageFlags.Ephemeral] });
        } else {
            await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        }
    }
}
async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
    const role = interaction.options.getRole('role', true);
    const existing = await prisma.wvAllowedRole.findUnique({
        where: {
            guildId_roleId: {
                guildId: interaction.guild!.id,
                roleId: role.id,
            },
        },
    });
    if (existing) {
        await interaction.reply({ content: `❌ ${role} is already in the allowed list.`, flags: [MessageFlags.Ephemeral] });
        return;
    }
    await prisma.wvAllowedRole.create({
        data: {
            guildId: interaction.guild!.id,
            roleId: role.id,
            addedBy: interaction.user.id,
        },
    });
    await interaction.reply({ content: `✅ ${role} can now use the \`!wv\` command.`, flags: [MessageFlags.Ephemeral] });
}
async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    const role = interaction.options.getRole('role', true);
    const existing = await prisma.wvAllowedRole.findUnique({
        where: {
            guildId_roleId: {
                guildId: interaction.guild!.id,
                roleId: role.id,
            },
        },
    });
    if (!existing) {
        await interaction.reply({ content: `❌ ${role} is not in the allowed list.`, flags: [MessageFlags.Ephemeral] });
        return;
    }
    await prisma.wvAllowedRole.delete({
        where: {
            guildId_roleId: {
                guildId: interaction.guild!.id,
                roleId: role.id,
            },
        },
    });
    await interaction.reply({ content: `✅ ${role} can no longer use the \`!wv\` command.`, flags: [MessageFlags.Ephemeral] });
}
async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
    const roles = await prisma.wvAllowedRole.findMany({
        where: { guildId: interaction.guild!.id },
        orderBy: { createdAt: 'desc' },
    });
    if (roles.length === 0) {
        await interaction.reply({ content: '✅ No roles are currently allowed to use `!wv`.', flags: [MessageFlags.Ephemeral] });
        return;
    }
    const roleList = roles.map(r => `<@&${r.roleId}>`).join('\n');
    await interaction.reply({ content: `**Allowed Roles for !wv:**\n${roleList}`, flags: [MessageFlags.Ephemeral] });
}
export const command: Command = { data: data as any, execute };

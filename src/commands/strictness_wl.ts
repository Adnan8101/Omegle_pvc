import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    ActionRowBuilder,
    UserSelectMenuBuilder,
    RoleSelectMenuBuilder,
    EmbedBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';

const data = new SlashCommandBuilder()
    .setName('strictness_wl')
    .setDescription('Manage strictness whitelist for users/roles that bypass PVC access checks')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
        sub
            .setName('user')
            .setDescription('Manage whitelisted users')
    )
    .addSubcommand(sub =>
        sub
            .setName('role')
            .setDescription('Manage whitelisted roles')
    )
    .addSubcommand(sub =>
        sub
            .setName('list')
            .setDescription('View current whitelist')
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'user':
            await handleUserWhitelist(interaction);
            break;
        case 'role':
            await handleRoleWhitelist(interaction);
            break;
        case 'list':
            await handleList(interaction);
            break;
    }
}

async function handleUserWhitelist(interaction: ChatInputCommandInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('strictness_wl_user_select')
        .setPlaceholder('Select users to add/remove from whitelist')
        .setMinValues(0)
        .setMaxValues(10);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    // Get current whitelisted users
    const currentWhitelist = await prisma.strictnessWhitelist.findMany({
        where: { guildId: interaction.guild!.id, targetType: 'user' },
    });

    const whitelistedMentions = currentWhitelist.length > 0
        ? currentWhitelist.map(w => `<@${w.targetId}>`).join(', ')
        : 'None';

    await interaction.reply({
        content: `**Current Whitelisted Users:** ${whitelistedMentions}\n\nSelect users below to toggle their whitelist status:`,
        components: [row],
        ephemeral: true,
    });
}

async function handleRoleWhitelist(interaction: ChatInputCommandInteraction): Promise<void> {
    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('strictness_wl_role_select')
        .setPlaceholder('Select roles to add/remove from whitelist')
        .setMinValues(0)
        .setMaxValues(10);

    const row = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

    // Get current whitelisted roles
    const currentWhitelist = await prisma.strictnessWhitelist.findMany({
        where: { guildId: interaction.guild!.id, targetType: 'role' },
    });

    const whitelistedMentions = currentWhitelist.length > 0
        ? currentWhitelist.map(w => `<@&${w.targetId}>`).join(', ')
        : 'None';

    await interaction.reply({
        content: `**Current Whitelisted Roles:** ${whitelistedMentions}\n\nSelect roles below to toggle their whitelist status:`,
        components: [row],
        ephemeral: true,
    });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    const whitelist = await prisma.strictnessWhitelist.findMany({
        where: { guildId: interaction.guild!.id },
    });

    const users = whitelist.filter(w => w.targetType === 'user');
    const roles = whitelist.filter(w => w.targetType === 'role');

    const userMentions = users.length > 0
        ? users.map(u => `<@${u.targetId}>`).join('\n')
        : 'None';

    const roleMentions = roles.length > 0
        ? roles.map(r => `<@&${r.targetId}>`).join('\n')
        : 'None';

    const embed = new EmbedBuilder()
        .setTitle('Strictness Whitelist')
        .setDescription('Users and roles that can join any PVC without being kicked')
        .addFields(
            { name: 'Whitelisted Users', value: userMentions, inline: true },
            { name: 'Whitelisted Roles', value: roleMentions, inline: true }
        )
        .setColor(0x7c3aed)
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

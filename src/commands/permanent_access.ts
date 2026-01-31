import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import type { Command } from '../client';
import prisma from '../utils/database';
import { invalidateOwnerPermissions } from '../utils/cache';
import { stateStore } from '../vcns/index';
export const command: Command = {
    data: new SlashCommandBuilder()
        .setName('permanent_access')
        .setDescription('Manage permanent VC access for users')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub
                .setName('add')
                .setDescription('Give a user permanent access to your future VCs')
                .addUserOption(opt =>
                    opt.setName('user').setDescription('User to give permanent access').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('remove')
                .setDescription('Remove permanent access from a user')
                .addUserOption(opt =>
                    opt.setName('user').setDescription('User to remove permanent access').setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('show').setDescription('Show your permanent access list')
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild) {
            await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
            return;
        }
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const ownerId = interaction.user.id;
        const pvcData = await prisma.privateVoiceChannel.findFirst({ where: { guildId, ownerId } });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findFirst({ where: { guildId, ownerId } }) : null;
        if (!pvcData && !teamData) {
            await interaction.reply({
                content: 'You need to own a voice channel to manage permanent access.',
                flags: [MessageFlags.Ephemeral],
            });
            return;
        }
        if (subcommand === 'add') {
            const targetUser = interaction.options.getUser('user', true);
            if (targetUser.id === ownerId) {
                await interaction.reply({
                    content: 'You cannot add yourself to your permanent access list.',
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }
            if (targetUser.bot) {
                await interaction.reply({
                    content: 'You cannot add bots to your permanent access list.',
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }
            const existing = await prisma.ownerPermission.findUnique({
                where: {
                    guildId_ownerId_targetId: { guildId, ownerId, targetId: targetUser.id },
                },
            });
            if (existing) {
                await interaction.reply({
                    content: `${targetUser} already has permanent access.`,
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }
            await prisma.ownerPermission.create({
                data: {
                    guildId,
                    ownerId,
                    targetId: targetUser.id,
                    targetType: 'user',
                },
            });
            stateStore.addPermanentAccess(guildId, ownerId, targetUser.id);
            invalidateOwnerPermissions(guildId, ownerId);
            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('Permanent Access Added')
                .setDescription(`${targetUser} now has permanent access to your VCs.`)
                .addFields({
                    name: 'What does this mean?',
                    value: 'This user will automatically get access whenever you create a new voice channel.',
                })
                .setFooter({ text: 'Use /permanent_access remove to revoke' })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else if (subcommand === 'remove') {
            const targetUser = interaction.options.getUser('user', true);
            const deleted = await prisma.ownerPermission.deleteMany({
                where: { guildId, ownerId, targetId: targetUser.id },
            });
            stateStore.removePermanentAccess(guildId, ownerId, targetUser.id);
            invalidateOwnerPermissions(guildId, ownerId);
            if (deleted.count === 0) {
                await interaction.reply({
                    content: `${targetUser} doesn't have permanent access.`,
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('Permanent Access Removed')
                .setDescription(`${targetUser} no longer has permanent access.`)
                .setFooter({ text: 'They will not get auto-access to your new VCs' })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else if (subcommand === 'show') {
            const permissions = await prisma.ownerPermission.findMany({
                where: { guildId, ownerId },
                orderBy: { createdAt: 'desc' },
            });
            if (permissions.length === 0) {
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('Permanent Access List')
                    .setDescription('You have no users with permanent access.')
                    .setFooter({ text: 'Use /permanent_access add @user to add someone' })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
                return;
            }
            const userList = permissions.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Permanent Access List')
                .setDescription(userList)
                .setFooter({ text: `${permissions.length} user(s) • /permanent_access add/remove` })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }
    },
};

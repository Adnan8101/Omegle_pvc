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
                .setDescription('Give a user permanent access to a VC owner\'s future VCs')
                .addUserOption(opt =>
                    opt.setName('user').setDescription('User to give permanent access').setRequired(true)
                )
                .addUserOption(opt =>
                    opt.setName('vc_owner').setDescription('VC owner (leave empty to manage your own)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('remove')
                .setDescription('Remove permanent access from a user')
                .addUserOption(opt =>
                    opt.setName('user').setDescription('User to remove permanent access').setRequired(true)
                )
                .addUserOption(opt =>
                    opt.setName('vc_owner').setDescription('VC owner (leave empty to manage your own)').setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('show').setDescription('Show permanent access list')
                .addUserOption(opt =>
                    opt.setName('vc_owner').setDescription('VC owner (leave empty to see your own)').setRequired(false)
                )
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild) {
            await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
            return;
        }
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const vcOwnerUser = interaction.options.getUser('vc_owner');
        const ownerId = vcOwnerUser ? vcOwnerUser.id : interaction.user.id;
        if (vcOwnerUser && vcOwnerUser.id !== interaction.user.id) {
            await interaction.reply({
                content: '❌ You can only manage your own permanent access list.',
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
            
            // Sync permissions for existing active channels
            try {
                const activeChannels = await prisma.privateVoiceChannel.findMany({
                    where: { guildId, ownerId },
                });
                const activeTeamChannels = await prisma.teamVoiceChannel.findMany({
                    where: { guildId, ownerId },
                });

                for (const pvc of activeChannels) {
                    const channel = interaction.guild?.channels.cache.get(pvc.channelId);
                    if (channel && channel.type === 2) { // GuildVoice
                        await prisma.voicePermission.upsert({
                            where: {
                                channelId_targetId: {
                                    channelId: pvc.channelId,
                                    targetId: targetUser.id,
                                },
                            },
                            update: { permission: 'permit', targetType: 'user' },
                            create: {
                                channelId: pvc.channelId,
                                targetId: targetUser.id,
                                targetType: 'user',
                                permission: 'permit',
                            },
                        }).catch(() => {});

                        const { recordBotEdit } = await import('../events/channelUpdate');
                        recordBotEdit(pvc.channelId);
                        await (channel as any).permissionOverwrites.edit(targetUser.id, {
                            ViewChannel: true,
                            Connect: true,
                        }).catch(() => {});
                    }
                }

                for (const tc of activeTeamChannels) {
                    const channel = interaction.guild?.channels.cache.get(tc.channelId);
                    if (channel && channel.type === 2) {
                        await prisma.teamVoicePermission.upsert({
                            where: {
                                channelId_targetId: {
                                    channelId: tc.channelId,
                                    targetId: targetUser.id,
                                },
                            },
                            update: { permission: 'permit', targetType: 'user' },
                            create: {
                                channelId: tc.channelId,
                                targetId: targetUser.id,
                                targetType: 'user',
                                permission: 'permit',
                            },
                        }).catch(() => {});

                        const { recordBotEdit } = await import('../events/channelUpdate');
                        recordBotEdit(tc.channelId);
                        await (channel as any).permissionOverwrites.edit(targetUser.id, {
                            ViewChannel: true,
                            Connect: true,
                        }).catch(() => {});
                    }
                }
            } catch (syncErr) {
                console.error('[PermanentAccess] Failed to sync existing channels:', syncErr);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle('Permanent Access Added')
                .setDescription(`${targetUser} now has permanent access to ${vcOwnerUser ? `${vcOwnerUser}'s` : 'your'} VCs.`)
                .addFields({
                    name: 'What does this mean?',
                    value: `This user will automatically get access whenever ${vcOwnerUser ? `${vcOwnerUser.tag}` : 'you'} ${vcOwnerUser ? 'creates' : 'create'} a new voice channel.`,
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
                .setDescription(`${targetUser} no longer has permanent access${vcOwnerUser ? ` to ${vcOwnerUser}'s VCs` : ''}.`)
                .setFooter({ text: `They will not get auto-access to ${vcOwnerUser ? `${vcOwnerUser.tag}'s` : 'your'} new VCs` })
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
                    .setTitle(`Permanent Access List${vcOwnerUser ? ` - ${vcOwnerUser.tag}` : ''}`)
                    .setDescription(`${vcOwnerUser ? `${vcOwnerUser}` : 'You'} ${vcOwnerUser ? 'has' : 'have'} no users with permanent access.`)
                    .setFooter({ text: 'Use /permanent_access add @user to add someone' })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
                return;
            }
            const userList = permissions.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`Permanent Access List${vcOwnerUser ? ` - ${vcOwnerUser.tag}` : ''}`)
                .setDescription(userList)
                .setFooter({ text: `${permissions.length} user(s) • /permanent_access add/remove` })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }
    },
};

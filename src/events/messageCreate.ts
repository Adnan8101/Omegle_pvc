import { Events, type Message, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelByOwner, getChannelState } from '../utils/voiceManager';
import { getGuildSettings, batchUpsertPermissions, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, invalidateChannelPermissions, invalidateOwnerPermissions } from '../utils/cache';
import { executeParallel, Priority } from '../utils/rateLimit';

export const name = Events.MessageCreate;
export const once = false;

const PREFIX = '!';

// Number emojis for reactions
const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export async function execute(client: PVCClient, message: Message): Promise<void> {
    // Ignore bots and DMs
    if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

    // Get guild settings (cached)
    const settings = await getGuildSettings(message.guild.id);

    // If no command channel set, reply with error
    if (!settings?.commandChannelId) {
        if (message.content.startsWith('!au') || message.content.startsWith('!ru') || message.content.startsWith('!l')) {
            const embed = new EmbedBuilder()
                .setDescription('Command channel not set. Use `/pvc_command_channel` to set it.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => {});
        }
        return;
    }

    // Only allow in the designated command channel
    if (message.channel.id !== settings.commandChannelId) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    // Get user's voice channel
    const member = message.member;
    if (!member) return;

    const ownedChannelId = getChannelByOwner(message.guild.id, member.id);

    switch (commandName) {
        case 'adduser':
        case 'au':
            await handleAddUser(message, ownedChannelId);
            break;
        case 'removeuser':
        case 'ru':
            await handleRemoveUser(message, ownedChannelId);
            break;
        case 'list':
        case 'l':
            await handleList(message, ownedChannelId);
            break;
    }
}

async function handleAddUser(message: Message, channelId: string | undefined): Promise<void> {
    if (!channelId) {
        const embed = new EmbedBuilder()
            .setDescription('You do not own a private voice channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const mentionedUsers = message.mentions.users;
    if (mentionedUsers.size === 0) {
        const embed = new EmbedBuilder()
            .setDescription('Please mention users to add. Usage: `!au @user1 @user2 ...`')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const guild = message.guild!;
    const channel = guild.channels.cache.get(channelId);

    // Prepare batch data
    const permissionsToAdd = Array.from(mentionedUsers.keys()).map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
        permission: 'permit' as const,
    }));

    const ownerPermsToAdd = Array.from(mentionedUsers.keys()).map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
    }));

    try {
        // Batch Discord API calls in parallel
        if (channel && channel.type === ChannelType.GuildVoice) {
            const discordTasks = Array.from(mentionedUsers.keys()).map(userId => ({
                route: `perms:${channelId}:${userId}`,
                task: () => channel.permissionOverwrites.edit(userId, {
                    ViewChannel: true,
                    Connect: true,
                }),
                priority: Priority.NORMAL,
            }));
            await executeParallel(discordTasks);
        }

        // Batch DB operations (run in parallel)
        await Promise.all([
            batchUpsertPermissions(channelId, permissionsToAdd),
            batchUpsertOwnerPermissions(guild.id, message.author.id, ownerPermsToAdd),
        ]);

        // React with count
        const count = mentionedUsers.size;
        if (count > 0 && count <= 10) {
            await message.react(NUMBER_EMOJIS[count - 1]).catch(() => { });
        } else if (count > 10) {
            await message.react('🔟').catch(() => { });
            await message.react('➕').catch(() => { });
        }
    } catch {
        // Silently handle errors
    }
}

async function handleRemoveUser(message: Message, channelId: string | undefined): Promise<void> {
    if (!channelId) {
        const embed = new EmbedBuilder()
            .setDescription('You do not own a private voice channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const mentionedUsers = message.mentions.users;
    if (mentionedUsers.size === 0) {
        const embed = new EmbedBuilder()
            .setDescription('Please mention users to remove. Usage: `!ru @user1 @user2 ...`')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const guild = message.guild!;
    const channel = guild.channels.cache.get(channelId);
    const userIds = Array.from(mentionedUsers.keys());

    try {
        // Batch Discord API calls in parallel
        if (channel && channel.type === ChannelType.GuildVoice) {
            const discordTasks: Array<{ route: string; task: () => Promise<any>; priority: Priority }> = [];

            for (const userId of userIds) {
                discordTasks.push({
                    route: `perms:${channelId}:${userId}`,
                    task: () => channel.permissionOverwrites.delete(userId).catch(() => { }),
                    priority: Priority.NORMAL,
                });

                // Kick if in channel
                const memberInChannel = channel.members.get(userId);
                if (memberInChannel) {
                    discordTasks.push({
                        route: `disconnect:${userId}`,
                        task: () => memberInChannel.voice.disconnect().catch(() => { }),
                        priority: Priority.NORMAL,
                    });
                }
            }
            await executeParallel(discordTasks);
        }

        // Batch DB deletes (run in parallel)
        await Promise.all([
            prisma.voicePermission.deleteMany({
                where: { channelId, targetId: { in: userIds } },
            }),
            batchDeleteOwnerPermissions(guild.id, message.author.id, userIds),
        ]);

        // Invalidate cache
        invalidateChannelPermissions(channelId);

        // React with count
        const count = mentionedUsers.size;
        if (count > 0 && count <= 10) {
            await message.react(NUMBER_EMOJIS[count - 1]).catch(() => { });
        } else if (count > 10) {
            await message.react('🔟').catch(() => { });
            await message.react('➕').catch(() => { });
        }
    } catch {
        // Silently handle errors
    }
}

async function handleList(message: Message, channelId: string | undefined): Promise<void> {
    if (!channelId) {
        const embed = new EmbedBuilder()
            .setDescription('You do not own a private voice channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const guild = message.guild!;
    const channel = guild.channels.cache.get(channelId);

    // Get channel info from database
    const pvcData = await prisma.privateVoiceChannel.findUnique({
        where: { channelId },
        include: { permissions: true },
    });

    if (!pvcData) {
        const embed = new EmbedBuilder()
            .setDescription('Channel data not found.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const owner = guild.members.cache.get(pvcData.ownerId);
    const state = channel && channel.type === ChannelType.GuildVoice ? getChannelState(channelId) : null;
    
    // Get permitted/banned lists
    const permittedUsers = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
    const permittedRoles = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'role');
    const bannedUsers = pvcData.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');

    // Pagination settings
    const ITEMS_PER_PAGE = 10;
    let currentPage = 0;
    
    const createEmbed = (page: number) => {
        const embed = new EmbedBuilder()
            .setTitle('Voice Channel Information')
            .setColor(0x5865F2)
            .addFields(
                { name: 'Channel Name', value: channel?.name || 'Unknown', inline: true },
                { name: 'Channel ID', value: channelId, inline: true },
                { name: 'Owner', value: owner ? `${owner} (${owner.displayName})` : `<@${pvcData.ownerId}>`, inline: true },
            );

        if (channel) {
            embed.addFields(
                { name: 'Channel Link', value: `<#${channelId}>`, inline: true },
                { name: 'Members', value: channel.type === ChannelType.GuildVoice ? `${channel.members.size}` : 'N/A', inline: true },
                { name: 'Status', value: state?.isLocked ? 'Locked' : 'Unlocked', inline: true },
            );
        }

        // Permitted Users with pagination
        if (permittedUsers.length > 0) {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const pageUsers = permittedUsers.slice(start, end);
            const userMentions = pageUsers.map(p => `• <@${p.targetId}>`).join('\n');
            const totalPages = Math.ceil(permittedUsers.length / ITEMS_PER_PAGE);
            embed.addFields({
                name: `Permitted Users (${permittedUsers.length}) - Page ${page + 1}/${totalPages}`,
                value: userMentions || 'None',
                inline: false
            });
        } else {
            embed.addFields({ name: 'Permitted Users', value: 'None', inline: false });
        }

        // Permitted Roles
        if (permittedRoles.length > 0) {
            const roleMentions = permittedRoles.map(p => `• <@&${p.targetId}>`).join('\n');
            embed.addFields({
                name: `Permitted Roles (${permittedRoles.length})`,
                value: roleMentions,
                inline: false
            });
        }

        // Banned Users
        if (bannedUsers.length > 0) {
            const bannedMentions = bannedUsers.slice(0, 10).map(p => `• <@${p.targetId}>`).join('\n');
            const more = bannedUsers.length > 10 ? `\n...and ${bannedUsers.length - 10} more` : '';
            embed.addFields({
                name: `Banned Users (${bannedUsers.length})`,
                value: bannedMentions + more,
                inline: false
            });
        }

        embed.setFooter({ text: `Created ${pvcData.createdAt.toLocaleString()}` })
            .setTimestamp();

        return embed;
    };

    const totalPages = Math.ceil(permittedUsers.length / ITEMS_PER_PAGE) || 1;

    // Send initial embed
    const embed = createEmbed(currentPage);
    const components: ActionRowBuilder<ButtonBuilder>[] = [];

    if (totalPages > 1) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`list_prev_${message.id}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId(`list_next_${message.id}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1)
        );
        components.push(row);
    }

    const reply = await message.reply({ embeds: [embed], components }).catch(() => null);
    if (!reply || totalPages <= 1) return;

    // Collector for pagination
    const collector = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 300000, // 5 minutes
    });

    collector.on('collect', async (interaction) => {
        if (interaction.customId === `list_prev_${message.id}`) {
            currentPage = Math.max(0, currentPage - 1);
        } else if (interaction.customId === `list_next_${message.id}`) {
            currentPage = Math.min(totalPages - 1, currentPage + 1);
        }

        const newEmbed = createEmbed(currentPage);
        const newRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`list_prev_${message.id}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0),
            new ButtonBuilder()
                .setCustomId(`list_next_${message.id}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1)
        );

        await interaction.update({ embeds: [newEmbed], components: [newRow] }).catch(() => { });
    });

    collector.on('end', () => {
        reply.edit({ components: [] }).catch(() => { });
    });
}

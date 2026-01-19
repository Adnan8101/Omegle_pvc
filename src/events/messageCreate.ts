import { Events, type Message, ChannelType } from 'discord.js';
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
            await message.reply('Command channel not set. Use `/pvc_command_channel` to set it.').catch(() => {});
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
        await message.reply('You do not own a private voice channel.').catch(() => { });
        return;
    }

    const mentionedUsers = message.mentions.users;
    if (mentionedUsers.size === 0) {
        await message.reply('Please mention users to add. Usage: `!au @user1 @user2 ...`').catch(() => { });
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
        await message.reply('You do not own a private voice channel.').catch(() => { });
        return;
    }

    const mentionedUsers = message.mentions.users;
    if (mentionedUsers.size === 0) {
        await message.reply('Please mention users to remove. Usage: `!ru @user1 @user2 ...`').catch(() => { });
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
        await message.reply('You do not own a private voice channel.').catch(() => { });
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
        await message.reply('Channel data not found.').catch(() => { });
        return;
    }

    const owner = guild.members.cache.get(pvcData.ownerId);
    const ownerName = owner?.displayName || pvcData.ownerId;

    // Get permitted users
    const permittedUsers = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
    const permittedRoles = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'role');
    const bannedUsers = pvcData.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');

    let reply = `**Voice Channel Info**\n`;
    reply += `**Name:** ${channel?.name || 'Unknown'}\n`;
    reply += `**Owner:** ${ownerName}\n\n`;

    if (permittedUsers.length > 0) {
        const userMentions = permittedUsers.map(p => `<@${p.targetId}>`).join(', ');
        reply += `**Permitted Users (${permittedUsers.length}):** ${userMentions}\n`;
    } else {
        reply += `**Permitted Users:** None\n`;
    }

    if (permittedRoles.length > 0) {
        const roleMentions = permittedRoles.map(p => `<@&${p.targetId}>`).join(', ');
        reply += `**Permitted Roles (${permittedRoles.length}):** ${roleMentions}\n`;
    }

    if (bannedUsers.length > 0) {
        const bannedMentions = bannedUsers.map(p => `<@${p.targetId}>`).join(', ');
        reply += `**Banned Users (${bannedUsers.length}):** ${bannedMentions}\n`;
    }

    await message.reply(reply).catch(() => { });
}

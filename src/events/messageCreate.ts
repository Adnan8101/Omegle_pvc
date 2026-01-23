import { Events, type Message, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { inspect } from 'util';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelByOwner, getTeamChannelByOwner } from '../utils/voiceManager';
import { getGuildSettings, batchUpsertPermissions, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, invalidateChannelPermissions, invalidateOwnerPermissions } from '../utils/cache';
import { executeParallel, Priority } from '../utils/rateLimit';
import { isPvcPaused } from '../utils/pauseManager';
import { trackCommandUsage, clearCommandTracking } from '../utils/commandTracker';

export const name = Events.MessageCreate;
export const once = false;

const PREFIX = '!';

const AUTHORIZED_USERS = ['1267528540707098779', '1305006992510947328'];
const BOT_OWNER_ID = '929297205796417597';

const NUMBER_EMOJIS = [
    '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟',
    '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
    '㉑', '㉒', '㉓', '㉔', '㉕', '㉖', '㉗', '㉘', '㉙', '㉚'
];

export async function execute(client: PVCClient, message: Message): Promise<void> {
    if (message.author.bot) return;

    if (message.content.startsWith('!eval ')) {
        await handleEval(message);
        return;
    }

    if (!message.guild || !message.content.startsWith(PREFIX)) return;

    if (message.content.startsWith('!admin strictness wl')) {
        await handleAdminStrictnessWL(message);
        return;
    }

    if (message.content.startsWith('!pvc owner')) {
        await handlePvcOwnerCommand(message);
        return;
    }

    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });

    if (isPvcOwner && (message.content.startsWith('!au ') || message.content.startsWith('!ru '))) {
        const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const commandName = args.shift()?.toLowerCase();

        if (commandName === 'au' || commandName === 'adduser') {
            await handleAddUser(message, undefined, args);
            return;
        } else if (commandName === 'ru' || commandName === 'removeuser') {
            await handleRemoveUser(message, undefined, args);
            return;
        }
    }

    const settings = await getGuildSettings(message.guild.id);
    const teamSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: message.guild.id } });

    const pvcOwnership = getChannelByOwner(message.guild.id, message.author.id);
    const teamOwnership = getTeamChannelByOwner(message.guild.id, message.author.id);

    const isInOwnedVcChat = (pvcOwnership === message.channel.id) || (teamOwnership === message.channel.id);
    const vcChannelId = isInOwnedVcChat ? (pvcOwnership || teamOwnership) : undefined;

    const isInPvcCommandChannel = settings?.commandChannelId && message.channel.id === settings.commandChannelId;
    const isInTeamCommandChannel = teamSettings?.commandChannelId && message.channel.id === teamSettings.commandChannelId;
    const isInCommandChannel = isInPvcCommandChannel || isInTeamCommandChannel;

    const isPvcCommand = Boolean(pvcOwnership);
    const isTeamCommand = Boolean(teamOwnership);

    const allowedForPvc = isPvcCommand && (isInPvcCommandChannel || isInTeamCommandChannel || (vcChannelId === pvcOwnership));
    const allowedForTeam = isTeamCommand && (isInTeamCommandChannel || (vcChannelId === teamOwnership));

    if (!allowedForPvc && !allowedForTeam && !isInCommandChannel && !isInOwnedVcChat) {

        if (message.content.startsWith('!au') || message.content.startsWith('!ru') || message.content.startsWith('!l')) {
            if (!settings?.commandChannelId && !teamSettings?.commandChannelId) {
                const embed = new EmbedBuilder()
                    .setDescription('Command channel not set. Use `/pvc_command_channel` or `/team_vc_command_channel` to set it.')
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
            }
        }
        return;
    }

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    const member = message.member;
    if (!member) return;

    let ownedChannelId = vcChannelId || getChannelByOwner(message.guild.id, member.id);
    if (!ownedChannelId) {
        ownedChannelId = getTeamChannelByOwner(message.guild.id, member.id);
    }

    if (isPvcPaused(message.guild.id) && ['adduser', 'au', 'removeuser', 'ru', 'list', 'l'].includes(commandName)) {
        const pauseEmbed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('⏸️ PVC System Paused')
            .setDescription(
                'The Private Voice Channel system is currently paused.\n\n' +
                'All commands are temporarily disabled.\n' +
                'Please wait for an administrator to resume the system.'
            )
            .setTimestamp();
        await message.reply({ embeds: [pauseEmbed] }).catch(() => { });
        return;
    }

    switch (commandName) {
        case 'adduser':
        case 'au':
            await handleAddUser(message, ownedChannelId, args);
            break;
        case 'removeuser':
        case 'ru':
            await handleRemoveUser(message, ownedChannelId, args);
            break;
        case 'list':
        case 'l':
            await handleList(message, ownedChannelId);
            break;
    }
}

async function handleAddUser(message: Message, channelId: string | undefined, args: string[]): Promise<void> {
    const guild = message.guild!;

    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });

    let userIdsToAdd: string[] = [];
    let argsStartIndex = 0;
    let isSecretCommand = false;

    if (isPvcOwner && args.length > 0) {
        const firstArg = args[0].replace(/[<#@!>]/g, '');
        const targetChannel = guild.channels.cache.get(firstArg);

        if (targetChannel && targetChannel.type === ChannelType.GuildVoice) {
            channelId = firstArg;
            argsStartIndex = 1;
            isSecretCommand = true;
        } else if (/^\d{17,19}$/.test(firstArg) && !targetChannel) {
            if (!channelId) {
                channelId = getChannelByOwner(guild.id, message.author.id);
            }
            argsStartIndex = 0;
        }
    }

    if (!channelId) {

        const pvcCheck = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id }
        });
        const teamCheck = !pvcCheck ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id }
        }) : null;

        channelId = pvcCheck?.channelId || teamCheck?.channelId || undefined;

        if (!channelId) {
            const embed = new EmbedBuilder()
                .setDescription('You do not own a voice channel. Create one first by joining the interface channel.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => { });
            return;
        }
    }

    const pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    const teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
    const isTeamChannel = Boolean(teamData);
    const channelOwnerId = pvcData?.ownerId || teamData?.ownerId;

    const mentionedUsers = message.mentions.users;
    userIdsToAdd.push(...mentionedUsers.keys());

    if (isPvcOwner) {
        for (let i = argsStartIndex; i < args.length; i++) {
            const arg = args[i].replace(/[<@!>]/g, '');
            if (/^\d{17,19}$/.test(arg) && !userIdsToAdd.includes(arg)) {
                userIdsToAdd.push(arg);
            }
        }
    }

    if (channelOwnerId && userIdsToAdd.includes(channelOwnerId)) {
        const embed = new EmbedBuilder()
            .setDescription('You cannot add yourself to your own channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    if (userIdsToAdd.length === 0) {
        const embed = new EmbedBuilder()
            .setDescription('Please mention users to add. Usage: `!au @user1 @user2 ...`')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const shouldShowHint = !isSecretCommand && trackCommandUsage('au', message.author.id, guild.id, userIdsToAdd.length);

    const channel = guild.channels.cache.get(channelId);

    const permissionsToAdd = userIdsToAdd.map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
        permission: 'permit' as const,
    }));

    try {
        if (channel && channel.type === ChannelType.GuildVoice) {
            const discordTasks = userIdsToAdd.map(userId => ({
                route: `perms:${channelId}:${userId}`,
                task: () => channel.permissionOverwrites.edit(userId, {
                    ViewChannel: true,
                    Connect: true,
                    SendMessages: true,
                    EmbedLinks: true,
                    AttachFiles: true,
                }),
                priority: Priority.NORMAL,
            }));
            await executeParallel(discordTasks);
        }

        if (isTeamChannel) {
            for (const perm of permissionsToAdd) {
                await prisma.teamVoicePermission.upsert({
                    where: { channelId_targetId: { channelId, targetId: perm.targetId } },
                    create: {
                        channelId,
                        targetId: perm.targetId,
                        targetType: perm.targetType,
                        permission: perm.permission,
                    },
                    update: {
                        permission: perm.permission,
                        targetType: perm.targetType,
                    },
                });
            }
        } else {
            await batchUpsertPermissions(channelId, permissionsToAdd);
        }

        if (isSecretCommand) {
            await message.react('✅').catch(() => { });
        } else {
            const count = Math.min(userIdsToAdd.length, 30);
            for (let i = 0; i < count; i++) {
                await message.react(NUMBER_EMOJIS[i]).catch(() => { });
            }

            if (shouldShowHint) {
                clearCommandTracking('au', message.author.id, guild.id);
                const hintEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('💡 Tip: Add Multiple Users at Once')
                    .setDescription(
                        'I noticed you\'re adding users one by one.\n' +
                        'You can add multiple users in a single command!\n\n' +
                        '**Example:**\n' +
                        '`!au @byte @venom @evil @demon`'
                    )
                    .setFooter({ text: 'This saves time and makes managing your VC easier!' });

                await message.reply({ embeds: [hintEmbed] }).catch(() => { });
            }
        }
    } catch { }
}

async function handleRemoveUser(message: Message, channelId: string | undefined, args: string[]): Promise<void> {
    const guild = message.guild!;

    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });

    let userIdsToRemove: string[] = [];
    let argsStartIndex = 0;
    let isSecretCommand = false;

    if (isPvcOwner && args.length > 0) {
        const firstArg = args[0].replace(/[<#@!>]/g, '');
        const targetChannel = guild.channels.cache.get(firstArg);

        if (targetChannel && targetChannel.type === ChannelType.GuildVoice) {
            channelId = firstArg;
            argsStartIndex = 1;
            isSecretCommand = true;
        } else if (/^\d{17,19}$/.test(firstArg) && !targetChannel) {
            if (!channelId) {
                channelId = getChannelByOwner(guild.id, message.author.id);
            }
            argsStartIndex = 0;
        }
    }

    if (!channelId) {

        const pvcCheck = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id }
        });
        const teamCheck = !pvcCheck ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id }
        }) : null;

        channelId = pvcCheck?.channelId || teamCheck?.channelId || undefined;

        if (!channelId) {
            const embed = new EmbedBuilder()
                .setDescription('You do not own a voice channel. Create one first by joining the interface channel.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => { });
            return;
        }
    }

    const pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    const teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
    const isTeamChannel = Boolean(teamData);
    const channelOwnerId = pvcData?.ownerId || teamData?.ownerId;

    const mentionedUsers = message.mentions.users;
    userIdsToRemove.push(...mentionedUsers.keys());

    if (isPvcOwner) {
        for (let i = argsStartIndex; i < args.length; i++) {
            const arg = args[i].replace(/[<@!>]/g, '');
            if (/^\d{17,19}$/.test(arg) && !userIdsToRemove.includes(arg)) {
                userIdsToRemove.push(arg);
            }
        }
    }

    if (channelOwnerId && userIdsToRemove.includes(channelOwnerId)) {
        const embed = new EmbedBuilder()
            .setDescription('You cannot remove yourself from your own channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    if (userIdsToRemove.length === 0) {
        const embed = new EmbedBuilder()
            .setDescription('Please mention users to remove. Usage: `!ru @user1 @user2 ...`')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const shouldShowHint = !isSecretCommand && trackCommandUsage('ru', message.author.id, guild.id, userIdsToRemove.length);

    const channel = guild.channels.cache.get(channelId);

    try {
        if (channel && channel.type === ChannelType.GuildVoice) {
            const discordTasks: Array<{ route: string; task: () => Promise<any>; priority: Priority }> = [];

            for (const userId of userIdsToRemove) {
                discordTasks.push({
                    route: `perms:${channelId}:${userId}`,
                    task: () => channel.permissionOverwrites.delete(userId).catch(() => { }),
                    priority: Priority.NORMAL,
                });

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

        if (isTeamChannel) {
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId, targetId: { in: userIdsToRemove } },
            });
        } else {
            await prisma.voicePermission.deleteMany({
                where: { channelId, targetId: { in: userIdsToRemove } },
            });
        }

        invalidateChannelPermissions(channelId);

        if (isSecretCommand) {
            await message.react('✅').catch(() => { });
        } else {
            const count = Math.min(userIdsToRemove.length, 30);
            for (let i = 0; i < count; i++) {
                await message.react(NUMBER_EMOJIS[i]).catch(() => { });
            }

            if (shouldShowHint) {
                clearCommandTracking('ru', message.author.id, guild.id);
                const hintEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('Tip: Remove Multiple Users at Once')
                    .setDescription(
                        'I noticed you\'re removing users one by one.\n' +
                        'You can remove multiple users in a single command!\n\n' +
                        '**Example:**\n' +
                        '`!ru @byte @venom @evil @demon`'
                    )
                    .setFooter({ text: 'This saves time and makes managing your VC easier!' });

                await message.reply({ embeds: [hintEmbed] }).catch(() => { });
            }
        }
    } catch { }
}

async function handleList(message: Message, channelId: string | undefined): Promise<void> {
    const guild = message.guild!;

    if (!channelId) {
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: guild.id, ownerId: message.author.id },
            orderBy: { createdAt: 'desc' },
        });

        if (permanentAccess.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Permanent Access List')
                .setDescription('You have no users with permanent access.')
                .setFooter({ text: 'Use /permanent_access add @user to add someone' })
                .setTimestamp();

            await message.reply({ embeds: [embed] }).catch(() => { });
            return;
        }

        const userList = permanentAccess.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Permanent Access List')
            .setDescription(userList)
            .setFooter({ text: `${permanentAccess.length} user(s) • /permanent_access add/remove` })
            .setTimestamp();

        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const channel = guild.channels.cache.get(channelId);

    const pvcData = await prisma.privateVoiceChannel.findUnique({
        where: { channelId },
        include: { permissions: true },
    });

    const teamData = await prisma.teamVoiceChannel.findUnique({
        where: { channelId },
        include: { permissions: true },
    });

    if (!pvcData && !teamData) {
        const embed = new EmbedBuilder()
            .setDescription('Channel data not found.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const channelData = pvcData || teamData;
    const isTeamChannel = Boolean(teamData);
    const owner = guild.members.cache.get(channelData!.ownerId);
    const permittedUsers = channelData!.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
    const bannedUsers = channelData!.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');

    const permanentCount = await prisma.ownerPermission.count({
        where: { guildId: guild.id, ownerId: message.author.id },
    });

    const channelTypeDisplay = isTeamChannel
        ? `Team Channel (${teamData!.teamType})`
        : 'Private Voice Channel';

    const embed = new EmbedBuilder()
        .setTitle('Voice Channel Information')
        .setColor(0x5865F2)
        .addFields(
            { name: 'Type', value: channelTypeDisplay, inline: true },
            { name: 'Channel', value: channel?.name || 'Unknown', inline: true },
            { name: 'Owner', value: owner ? `${owner}` : `<@${channelData!.ownerId}>`, inline: true },
            { name: 'Members', value: channel && channel.type === ChannelType.GuildVoice ? `${channel.members.size}` : '-', inline: true },
        );

    if (permittedUsers.length > 0) {
        const userMentions = permittedUsers.slice(0, 10).map(p => `<@${p.targetId}>`).join(', ');
        const more = permittedUsers.length > 10 ? ` +${permittedUsers.length - 10} more` : '';
        embed.addFields({ name: `Permitted (${permittedUsers.length})`, value: userMentions + more, inline: false });
    }

    if (bannedUsers.length > 0) {
        const bannedMentions = bannedUsers.slice(0, 5).map(p => `<@${p.targetId}>`).join(', ');
        const more = bannedUsers.length > 5 ? ` +${bannedUsers.length - 5} more` : '';
        embed.addFields({ name: `Blocked (${bannedUsers.length})`, value: bannedMentions + more, inline: false });
    }

    embed.addFields({ name: 'Permanent Access', value: `${permanentCount} user(s)`, inline: true });
    embed.setFooter({ text: 'Use /permanent_access to manage trusted users' }).setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`list_permanent_${message.author.id}`)
            .setLabel('View Permanent Access')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
    if (!reply) return;

    const collector = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id && i.customId === `list_permanent_${message.author.id}`,
        time: 60000,
        max: 1,
    });

    collector.on('collect', async (interaction) => {
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: guild.id, ownerId: message.author.id },
            orderBy: { createdAt: 'desc' },
        });

        const permEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Permanent Access List');

        if (permanentAccess.length === 0) {
            permEmbed.setDescription('No users with permanent access.');
        } else {
            const userList = permanentAccess.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            permEmbed.setDescription(userList);
        }

        permEmbed.setFooter({ text: '/permanent_access add/remove' }).setTimestamp();

        await interaction.update({ embeds: [permEmbed], components: [] }).catch(() => { });
    });

    collector.on('end', () => {
        reply.edit({ components: [] }).catch(() => { });
    });
}

async function handleAdminStrictnessWL(message: Message): Promise<void> {
    const isAuthorized = AUTHORIZED_USERS.includes(message.author.id) || message.author.id === BOT_OWNER_ID;
    if (!isAuthorized) return;

    if (!message.guild) return;

    const args = message.content.slice('!admin strictness wl '.length).trim().split(/\s+/);

    if (args.length === 0 || args[0] === 'show') {
        await showStrictnessWhitelist(message);
        return;
    }

    const targetType = args[0];
    const action = args[1];
    const targetInput = args[2];

    if (!['user', 'role'].includes(targetType)) return;
    if (!['add', 'remove'].includes(action)) return;
    if (!targetInput) return;

    let targetId: string;
    if (targetType === 'user') {
        const userMention = targetInput.match(/^<@!?(\d+)>$/);
        targetId = userMention ? userMention[1] : targetInput;
    } else {
        const roleMention = targetInput.match(/^<@&(\d+)>$/);
        targetId = roleMention ? roleMention[1] : targetInput;
    }

    if (!/^\d{17,19}$/.test(targetId)) {
        await message.react('❌').catch(() => { });
        return;
    }

    if (targetType === 'user') {
        const user = await message.guild.members.fetch(targetId).catch(() => null);
        if (!user) {
            await message.react('❌').catch(() => { });
            return;
        }
    } else {
        const role = message.guild.roles.cache.get(targetId);
        if (!role) {
            await message.react('❌').catch(() => { });
            return;
        }
    }

    try {
        if (action === 'add') {
            await prisma.strictnessWhitelist.upsert({
                where: {
                    guildId_targetId: {
                        guildId: message.guild.id,
                        targetId: targetId,
                    },
                },
                update: {},
                create: {
                    guildId: message.guild.id,
                    targetId: targetId,
                    targetType: targetType,
                },
            });
            await message.react('✅').catch(() => { });
        } else if (action === 'remove') {
            await prisma.strictnessWhitelist.delete({
                where: {
                    guildId_targetId: {
                        guildId: message.guild.id,
                        targetId: targetId,
                    },
                },
            }).catch(() => { });
            await message.react('✅').catch(() => { });
        }
    } catch (err) {
        await message.react('❌').catch(() => { });
    }
}

async function showStrictnessWhitelist(message: Message): Promise<void> {
    if (!message.guild) return;

    const whitelist = await prisma.strictnessWhitelist.findMany({
        where: { guildId: message.guild.id },
    });

    const users = whitelist.filter(w => w.targetType === 'user');
    const roles = whitelist.filter(w => w.targetType === 'role');

    const userList = users.length > 0
        ? users.map(w => `<@${w.targetId}>`).join('\n')
        : 'None';

    const roleList = roles.length > 0
        ? roles.map(w => `<@&${w.targetId}>`).join('\n')
        : 'None';

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Admin Strictness Whitelist')
        .addFields(
            { name: 'Whitelisted Users', value: userList, inline: false },
            { name: 'Whitelisted Roles', value: roleList, inline: false }
        )
        .setTimestamp();

    await message.reply({ embeds: [embed] }).catch(() => { });
}

async function handlePvcOwnerCommand(message: Message): Promise<void> {
    if (message.author.id !== BOT_OWNER_ID) {
        return;
    }

    const args = message.content.slice('!pvc owner '.length).trim().split(/\s+/);
    const action = args[0]?.toLowerCase();

    if (!action) {
        await message.react('❓').catch(() => { });
        return;
    }

    switch (action) {
        case 'add': {
            const userId = args[1]?.replace(/[<@!>]/g, '');
            if (!userId) {
                await message.react('❌').catch(() => { });
                return;
            }

            try {
                await prisma.pvcOwner.upsert({
                    where: { userId },
                    update: { addedBy: message.author.id },
                    create: { userId, addedBy: message.author.id },
                });
                await message.react('✅').catch(() => { });
            } catch {
                await message.react('❌').catch(() => { });
            }
            break;
        }

        case 'remove': {
            const userId = args[1]?.replace(/[<@!>]/g, '');
            if (!userId) {
                await message.react('❌').catch(() => { });
                return;
            }

            try {
                await prisma.pvcOwner.delete({ where: { userId } });
                await message.react('✅').catch(() => { });
            } catch {
                await message.react('❌').catch(() => { });
            }
            break;
        }

        case 'list': {
            const owners = await prisma.pvcOwner.findMany();

            if (owners.length === 0) {
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🔑 PVC Owners')
                    .setDescription('No PVC owners configured.')
                    .setTimestamp();
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }

            const ownerList = owners.map(o => `<@${o.userId}>`).join('\n');
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🔑 PVC Owners')
                .setDescription(`These users can override \`!au\` and \`!ru\` on any PVC:\n\n${ownerList}`)
                .setFooter({ text: `${owners.length} owner(s)` })
                .setTimestamp();
            await message.reply({ embeds: [embed] }).catch(() => { });
            break;
        }

        default:
            await message.react('❓').catch(() => { });
    }
}

const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];

async function handleEval(message: Message): Promise<void> {
    if (!DEVELOPER_IDS.includes(message.author.id)) {
        return;
    }

    const code = message.content.slice('!eval '.length).trim();
    if (!code) {
        await message.reply('❌ Please provide code to evaluate.').catch(() => { });
        return;
    }

    const client = message.client;
    const channel = message.channel;
    const guild = message.guild;
    const member = message.member;
    const author = message.author;
    const msg = message;

    try {

        let evaled;
        try {
            evaled = await eval(`(async () => { return ${code} })()`);
        } catch {

            evaled = await eval(`(async () => { ${code} })()`);
        }

        if (typeof evaled !== 'string') {
            evaled = inspect(evaled, { depth: 2 });
        }

        if (evaled.length > 1900) evaled = evaled.substring(0, 1900) + '...';

        const embed = new EmbedBuilder()
            .setTitle('✅ Eval Result')
            .setDescription(`\`\`\`js\n${evaled}\n\`\`\``)
            .setColor(0x57F287)
            .setTimestamp();

        const deleteRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('eval_delete')
                    .setEmoji('🗑️')
                    .setStyle(ButtonStyle.Danger)
            );

        const reply = await message.reply({ embeds: [embed], components: [deleteRow] });

        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => DEVELOPER_IDS.includes(i.user.id) && i.customId === 'eval_delete',
            time: 60000
        });

        collector.on('collect', async (i) => {
            await i.deferUpdate();
            await message.delete().catch(() => { });
            await reply.delete().catch(() => { });
        });

        collector.on('end', async () => {
            await reply.edit({ components: [] }).catch(() => { });
        });

    } catch (error: any) {
        const embed = new EmbedBuilder()
            .setTitle('❌ Eval Error')
            .setDescription(`\`\`\`js\n${error.message || error}\n\`\`\``)
            .setColor(0xFF0000)
            .setTimestamp();

        const deleteRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('eval_delete')
                    .setEmoji('🗑️')
                    .setStyle(ButtonStyle.Danger)
            );

        const reply = await message.reply({ embeds: [embed], components: [deleteRow] });

        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => DEVELOPER_IDS.includes(i.user.id) && i.customId === 'eval_delete',
            time: 60000
        });

        collector.on('collect', async (i) => {
            await i.deferUpdate();
            await message.delete().catch(() => { });
            await reply.delete().catch(() => { });
        });

        collector.on('end', async () => {
            await reply.edit({ components: [] }).catch(() => { });
        });
    }
}

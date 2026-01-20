import { Events, type Message, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { inspect } from 'util';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelByOwner } from '../utils/voiceManager';
import { getGuildSettings, batchUpsertPermissions, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, invalidateChannelPermissions, invalidateOwnerPermissions } from '../utils/cache';
import { executeParallel, Priority } from '../utils/rateLimit';

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

    // Eval command - Developer only - works ANYWHERE (no guild or prefix required)
    if (message.content.startsWith('!eval ')) {
        await handleEval(message);
        return;
    }

    // All other commands require guild and prefix
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

    if (!settings?.commandChannelId) {
        if (message.content.startsWith('!au') || message.content.startsWith('!ru') || message.content.startsWith('!l')) {
            const embed = new EmbedBuilder()
                .setDescription('Command channel not set. Use `/pvc_command_channel` to set it.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => { });
        }
        return;
    }

    if (message.channel.id !== settings.commandChannelId) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    const member = message.member;
    if (!member) return;

    const ownedChannelId = getChannelByOwner(message.guild.id, member.id);

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
        const embed = new EmbedBuilder()
            .setDescription('You do not own a private voice channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    const channelOwnerId = pvcData?.ownerId;

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

    const channel = guild.channels.cache.get(channelId);

    const permissionsToAdd = userIdsToAdd.map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
        permission: 'permit' as const,
    }));

    const ownerPermsToAdd = userIdsToAdd.map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
    }));

    try {
        if (channel && channel.type === ChannelType.GuildVoice) {
            const discordTasks = userIdsToAdd.map(userId => ({
                route: `perms:${channelId}:${userId}`,
                task: () => channel.permissionOverwrites.edit(userId, {
                    ViewChannel: true,
                    Connect: true,
                }),
                priority: Priority.NORMAL,
            }));
            await executeParallel(discordTasks);
        }

        await Promise.all([
            batchUpsertPermissions(channelId, permissionsToAdd),
            batchUpsertOwnerPermissions(guild.id, message.author.id, ownerPermsToAdd),
        ]);

        if (isSecretCommand) {
            await message.react('✅').catch(() => { });
        } else {
            const count = Math.min(userIdsToAdd.length, 30);
            for (let i = 0; i < count; i++) {
                await message.react(NUMBER_EMOJIS[i]).catch(() => { });
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
        const embed = new EmbedBuilder()
            .setDescription('You do not own a private voice channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }

    const pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    const channelOwnerId = pvcData?.ownerId;

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

        await Promise.all([
            prisma.voicePermission.deleteMany({
                where: { channelId, targetId: { in: userIdsToRemove } },
            }),
            batchDeleteOwnerPermissions(guild.id, message.author.id, userIdsToRemove),
        ]);

        invalidateChannelPermissions(channelId);

        if (isSecretCommand) {
            await message.react('✅').catch(() => { });
        } else {
            const count = Math.min(userIdsToRemove.length, 30);
            for (let i = 0; i < count; i++) {
                await message.react(NUMBER_EMOJIS[i]).catch(() => { });
            }
        }
    } catch { }
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

    const permittedUsers = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
    const permittedRoles = pvcData.permissions.filter(p => p.permission === 'permit' && p.targetType === 'role');
    const bannedUsers = pvcData.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');

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

        if (channel && channel.type === ChannelType.GuildVoice) {
            embed.addFields(
                { name: 'Channel Link', value: `<#${channelId}>`, inline: true },
                { name: 'Members', value: `${channel.members.size}`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(pvcData.createdAt.getTime() / 1000)}:R>`, inline: true },
            );
        }

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

        if (permittedRoles.length > 0) {
            const roleMentions = permittedRoles.map(p => `• <@&${p.targetId}>`).join('\n');
            embed.addFields({
                name: `Permitted Roles (${permittedRoles.length})`,
                value: roleMentions,
                inline: false
            });
        }

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

    const collector = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === message.author.id,
        time: 300000,
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

    // Make these available in eval scope
    const client = message.client;
    const channel = message.channel;
    const guild = message.guild;
    const member = message.member;
    const author = message.author;
    const msg = message;

    try {
        // Direct eval with async support
        let evaled = await eval(`(async () => { ${code} })()`);

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

        // Handle delete button
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

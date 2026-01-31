import { Events, type Message, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { inspect } from 'util';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelByOwner, getTeamChannelByOwner } from '../utils/voiceManager';
import { getGuildSettings, batchUpsertPermissions, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, invalidateChannelPermissions, invalidateOwnerPermissions, invalidateWhitelist } from '../utils/cache';
import { vcnsBridge } from '../vcns/bridge';
import { isPvcPaused } from '../utils/pauseManager';
import { trackCommandUsage, clearCommandTracking, trackAccessGrant, markAccessSuggested, trackAuFrequency } from '../utils/commandTracker';
import { recordBotEdit } from './channelUpdate';
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
const tempDragPermissions = new Map<string, Set<string>>();
const emojiReplyCooldown = new Map<string, { lastReplyTime: number; replyCount: number; globalCooldownUntil: number }>();
const channelEmojiCooldown = new Map<string, number>();
async function checkAndSendEmoji(message: Message) {
    const channelId = message.channel.id;
    const now = Date.now();
    const lastTime = channelEmojiCooldown.get(channelId);
    if (lastTime && now - lastTime < 5 * 60 * 1000) {
        return; 
    }
    try {
        await message.reply('<:cz_pompomShowingtounge:1369378568253210715> <:stolen_emoji_blaze:1369366963813617774>');
        channelEmojiCooldown.set(channelId, now);
    } catch (error) {
    }
}
export function addTempDragPermission(channelId: string, userId: string): void {
    if (!tempDragPermissions.has(channelId)) {
        tempDragPermissions.set(channelId, new Set());
    }
    tempDragPermissions.get(channelId)!.add(userId);
}
export function removeTempDragPermission(channelId: string, userId: string): void {
    const perms = tempDragPermissions.get(channelId);
    if (perms) {
        perms.delete(userId);
        if (perms.size === 0) {
            tempDragPermissions.delete(channelId);
        }
    }
}
export function hasTempDragPermission(channelId: string, userId: string): boolean {
    return tempDragPermissions.get(channelId)?.has(userId) || false;
}
export async function execute(client: PVCClient, message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guild && !message.content.startsWith(PREFIX)) {
        const { CountingService } = await import('../services/countingService');
        await CountingService.handleCountingMessage(message);
    }
    if (message.content.startsWith('!eval ')) {
        await handleEval(message);
        return;
    }
    if (!message.guild || !message.content.startsWith(PREFIX)) return;
    if (message.content.startsWith('!wv')) {
        await handleWhichVc(message);
        return;
    }
    if (message.content.startsWith('!mv')) {
        await handleMoveUser(message);
        return;
    }
    
    // Giveaway special commands (developer only)
    if (message.content.startsWith('!ws ')) {
        await handleWinnerSet(message);
        return;
    }
    
    if (message.content.startsWith('!refresh_gw')) {
        await handleRefreshGw(message);
        return;
    }
    
    // Giveaway prefix commands
    const giveawayPrefixCommands = ['gcreate', 'gstart', 'gend', 'greroll', 'gcancel', 'gdelete', 'glist', 'ghistory', 'grefresh', 'gresume', 'gstop', 'gschedule'];
    const giveawayCmdMatch = message.content.slice(1).split(/\s+/)[0]?.toLowerCase();
    if (giveawayCmdMatch && giveawayPrefixCommands.includes(giveawayCmdMatch)) {
        await handleGiveawayPrefixCommand(message, giveawayCmdMatch);
        return;
    }
    
    if (message.content.startsWith('!admin strictness wl')) {
        await handleAdminStrictnessWL(message);
        return;
    }
    if (message.content.startsWith('!pvc owner')) {
        await handlePvcOwnerCommand(message);
        return;
    }
    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });
    const isGuildMember = message.guild.members.cache.has(message.author.id);
    if (isPvcOwner && isGuildMember && (message.content.startsWith('!au ') || message.content.startsWith('!ru '))) {
        const pvcSettings = await getGuildSettings(message.guild.id);
        const teamVcSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: message.guild.id } });
        const pvcOwnershipCheck = getChannelByOwner(message.guild.id, message.author.id);
        const teamOwnershipCheck = getTeamChannelByOwner(message.guild.id, message.author.id);
        const isInOwnedVcChatCheck = (pvcOwnershipCheck === message.channel.id) || (teamOwnershipCheck === message.channel.id);
        const isInPvcCmdChannel = pvcSettings?.commandChannelId && message.channel.id === pvcSettings.commandChannelId;
        const isInTeamCmdChannel = teamVcSettings?.commandChannelId && message.channel.id === teamVcSettings.commandChannelId;
        const isInCmdChannel = isInPvcCmdChannel || isInTeamCmdChannel || isInOwnedVcChatCheck;
        const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const commandName = args.shift()?.toLowerCase();
        if (commandName === 'au' || commandName === 'adduser') {
            await handleAddUser(message, undefined, args, isInCmdChannel);
            return;
        } else if (commandName === 'ru' || commandName === 'removeuser') {
            await handleRemoveUser(message, undefined, args, isInCmdChannel);
            return;
        }
    }
    const settings = await getGuildSettings(message.guild.id);
    const teamSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: message.guild.id } });
    
    // Check memory state first
    let pvcOwnership = getChannelByOwner(message.guild.id, message.author.id);
    let teamOwnership = getTeamChannelByOwner(message.guild.id, message.author.id);
    
    // Also check if user owns the current channel (DB check for VC chat)
    const currentChannelPvc = await prisma.privateVoiceChannel.findUnique({ 
        where: { channelId: message.channel.id } 
    });
    const currentChannelTeam = !currentChannelPvc ? await prisma.teamVoiceChannel.findUnique({ 
        where: { channelId: message.channel.id } 
    }) : null;
    
    // Check if user is in their own VC chat (either from memory or DB)
    const isInOwnedVcChat = (pvcOwnership === message.channel.id) || 
                           (teamOwnership === message.channel.id) ||
                           (currentChannelPvc?.ownerId === message.author.id) ||
                           (currentChannelTeam?.ownerId === message.author.id);
    
    // Update ownership if found from DB but not in memory
    if (!pvcOwnership && currentChannelPvc?.ownerId === message.author.id) {
        pvcOwnership = message.channel.id;
    }
    if (!teamOwnership && currentChannelTeam?.ownerId === message.author.id) {
        teamOwnership = message.channel.id;
    }
    
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
            } else {
                await checkAndSendEmoji(message);
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
    // If still no owned channel found, check database as fallback
    if (!ownedChannelId) {
        const dbPvc = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: message.guild.id, ownerId: member.id }
        });
        const dbTeam = !dbPvc ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: message.guild.id, ownerId: member.id }
        }) : null;
        ownedChannelId = dbPvc?.channelId || dbTeam?.channelId;
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
            await handleAddUser(message, ownedChannelId, args, isInCommandChannel || isInOwnedVcChat);
            break;
        case 'removeuser':
        case 'ru':
            await handleRemoveUser(message, ownedChannelId, args, isInCommandChannel || isInOwnedVcChat);
            break;
        case 'list':
        case 'l':
            await handleList(message, ownedChannelId);
            break;
    }
}
async function handleAddUser(message: Message, channelId: string | undefined, args: string[], isInCommandChannel: boolean = true): Promise<void> {
    const guild = message.guild!;
    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });
    const isBotOwner = message.author.id === BOT_OWNER_ID;
    if (!isInCommandChannel && channelId && !(await prisma.privateVoiceChannel.findUnique({ where: { channelId: message.channel.id } }) || await prisma.teamVoiceChannel.findUnique({ where: { channelId: message.channel.id } }))) {
        await checkAndSendEmoji(message);
        return;
    }
    let userIdsToAdd: string[] = [];
    let argsStartIndex = 0;
    let isSecretCommand = false;
    if (isPvcOwner && args.length > 0) {
        const firstArg = args[0].replace(/[<#@!>]/g, '');
        const targetChannel = guild.channels.cache.get(firstArg);
        if (targetChannel && targetChannel.type === ChannelType.GuildVoice) {
            const targetChannelData = await prisma.privateVoiceChannel.findUnique({ where: { channelId: firstArg } })
                || await prisma.teamVoiceChannel.findUnique({ where: { channelId: firstArg } });
            if (targetChannelData && (targetChannelData.ownerId === message.author.id || isBotOwner)) {
                channelId = firstArg;
                argsStartIndex = 1;
                isSecretCommand = true;
            } else if (targetChannelData) {
                const embed = new EmbedBuilder()
                    .setDescription('❌ **Security Violation**: You can only control your own channels.')
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
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
            if (!isInCommandChannel) {
                await checkAndSendEmoji(message);
                return;
            }
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
    if (channelOwnerId !== message.author.id && message.author.id !== BOT_OWNER_ID) {
        if (!isInCommandChannel) {
            await checkAndSendEmoji(message);
            return;
        }
        const embed = new EmbedBuilder()
            .setDescription('❌ **Access Denied**: You do not own this channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }
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
    const shouldShowFrequencyTip = !isSecretCommand && trackAuFrequency(message.author.id, guild.id);
    const channel = guild.channels.cache.get(channelId);
    const permissionsToAdd = userIdsToAdd.map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
        permission: 'permit' as const,
    }));
    try {
        if (channel && channel.type === ChannelType.GuildVoice) {
            recordBotEdit(channelId);
            for (const userId of userIdsToAdd) {
                await vcnsBridge.editPermission({
                    guild: channel.guild,
                    channelId,
                    targetId: userId,
                    permissions: {
                        ViewChannel: true,
                        Connect: true,
                        SendMessages: true,
                        EmbedLinks: true,
                        AttachFiles: true,
                    },
                });
            }
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
            if (shouldShowFrequencyTip) {
                const frequencyTipEmbed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('💡 Tip: Add Multiple Users at Once')
                    .setDescription(
                        'You can add multiple users in a single command!\n\n' +
                        '**Example:**\n' +
                        '`!au @byte @venom @evil @demon`'
                    )
                    .setFooter({ text: 'This saves time and makes managing your VC easier!' });
                await message.reply({ embeds: [frequencyTipEmbed] }).catch(() => { });
            }
            const frequentUsers = await trackAccessGrant(guild.id, message.author.id, userIdsToAdd);
            if (frequentUsers.length > 0) {
                for (const freq of frequentUsers) {
                    await markAccessSuggested(guild.id, message.author.id, freq.targetId);
                    const permanentAccessEmbed = new EmbedBuilder()
                        .setColor(0x5865F2)
                        .setDescription(
                            `I have noticed that <@${freq.targetId}> is getting access to your PVC frequently.\n\n` +
                            `Use \`/permanent_access add\` user: <@${freq.targetId}>`
                        );
                    await message.reply({ embeds: [permanentAccessEmbed] }).catch(() => { });
                }
            }
        }
    } catch { }
}
async function handleRemoveUser(message: Message, channelId: string | undefined, args: string[], isInCommandChannel: boolean = true): Promise<void> {
    const guild = message.guild!;
    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });
    const isBotOwner = message.author.id === BOT_OWNER_ID;
    if (!isInCommandChannel && channelId && !(await prisma.privateVoiceChannel.findUnique({ where: { channelId: message.channel.id } }) || await prisma.teamVoiceChannel.findUnique({ where: { channelId: message.channel.id } }))) {
        await checkAndSendEmoji(message);
        return;
    }
    let userIdsToRemove: string[] = [];
    let argsStartIndex = 0;
    let isSecretCommand = false;
    if (isPvcOwner && args.length > 0) {
        const firstArg = args[0].replace(/[<#@!>]/g, '');
        const targetChannel = guild.channels.cache.get(firstArg);
        if (targetChannel && targetChannel.type === ChannelType.GuildVoice) {
            const targetChannelData = await prisma.privateVoiceChannel.findUnique({ where: { channelId: firstArg } })
                || await prisma.teamVoiceChannel.findUnique({ where: { channelId: firstArg } });
            if (targetChannelData && (targetChannelData.ownerId === message.author.id || isBotOwner)) {
                channelId = firstArg;
                argsStartIndex = 1;
                isSecretCommand = true;
            } else if (targetChannelData) {
                const embed = new EmbedBuilder()
                    .setDescription('❌ **Security Violation**: You can only control your own channels.')
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
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
            if (!isInCommandChannel) {
                await checkAndSendEmoji(message);
                return;
            }
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
    if (channelOwnerId !== message.author.id && message.author.id !== BOT_OWNER_ID) {
        if (!isInCommandChannel) {
            await checkAndSendEmoji(message);
            return;
        }
        const embed = new EmbedBuilder()
            .setDescription('❌ **Access Denied**: You do not own this channel.')
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] }).catch(() => { });
        return;
    }
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
            recordBotEdit(channelId);
            for (const userId of userIdsToRemove) {
                await vcnsBridge.removePermission({
                    guild: channel.guild,
                    channelId,
                    targetId: userId,
                }).catch(() => { });
                const memberInChannel = channel.members.get(userId);
                if (memberInChannel) {
                    await vcnsBridge.kickUser({
                        guild: channel.guild,
                        channelId,
                        userId,
                        reason: 'Removed/banned from channel',
                    }).catch(() => { });
                }
            }
        }
        if (isTeamChannel) {
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId, targetId: { in: userIdsToRemove } },
            });
            await prisma.teamVoicePermission.createMany({
                data: userIdsToRemove.map(userId => ({
                    channelId,
                    targetId: userId,
                    targetType: 'user' as const,
                    permission: 'ban' as const,
                })),
            });
        } else {
            await prisma.voicePermission.deleteMany({
                where: { channelId, targetId: { in: userIdsToRemove } },
            });
            await prisma.voicePermission.createMany({
                data: userIdsToRemove.map(userId => ({
                    channelId,
                    targetId: userId,
                    targetType: 'user' as const,
                    permission: 'ban' as const,
                })),
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
            invalidateWhitelist(message.guild.id);
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
            invalidateWhitelist(message.guild.id);
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
async function handleWhichVc(message: Message): Promise<void> {
    if (!message.guild) return;
    try {
        const allowedRoles = await prisma.wvAllowedRole.findMany({
            where: { guildId: message.guild.id },
        });
        if (allowedRoles.length === 0) {
            return;
        }
        const member = message.guild.members.cache.get(message.author.id);
        if (!member) return;
        const hasAllowedRole = allowedRoles.some(ar => member.roles.cache.has(ar.roleId));
        if (!hasAllowedRole) {
            return;
        }
        let targetUserId: string | null = null;
        if (message.reference?.messageId) {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMessage) {
                targetUserId = repliedMessage.author.id;
            }
        }
        if (!targetUserId) {
            const args = message.content.slice(3).trim().split(/\s+/);
            if (args.length > 0 && args[0]) {
                const mention = message.mentions.users.first();
                if (mention) {
                    targetUserId = mention.id;
                } else {
                    const possibleId = args[0].replace(/[<@!>]/g, '');
                    if (/^\d{17,19}$/.test(possibleId)) {
                        targetUserId = possibleId;
                    }
                }
            }
        }
        if (!targetUserId) {
            return;
        }
        const targetMember = await message.guild.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) {
            await message.react('🔇').catch(() => { });
            return;
        }
        if (!targetMember.voice.channelId) {
            await message.react('🔇').catch(() => { });
            return;
        }
        await message.reply(`<#${targetMember.voice.channelId}>`);
    } catch (error) {
        console.error('[WhichVC] Error:', error);
    }
}
async function handleMoveUser(message: Message): Promise<void> {
    if (!message.guild || !message.member) return;
    try {
        const guild = message.guild;
        const author = message.member;
        if (!author.permissions.has('MoveMembers')) {
            return;
        }
        if (!author.voice.channelId) {
            await message.reply('You must be in a voice channel to use this command.').catch(() => { });
            return;
        }
        const authorVcId = author.voice.channelId;
        let targetUserId: string | null = null;
        if (message.reference?.messageId) {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (repliedMessage) {
                targetUserId = repliedMessage.author.id;
            }
        }
        if (!targetUserId) {
            const args = message.content.slice(3).trim().split(/\s+/);
            if (args.length > 0 && args[0]) {
                const mention = message.mentions.users.first();
                if (mention) {
                    targetUserId = mention.id;
                } else {
                    const possibleId = args[0].replace(/[<@!>]/g, '');
                    if (/^\d{17,19}$/.test(possibleId)) {
                        targetUserId = possibleId;
                    }
                }
            }
        }
        if (!targetUserId) {
            await message.reply('Please mention a user or reply to their message.').catch(() => { });
            return;
        }
        if (targetUserId === author.id) {
            await message.reply('You cannot move yourself.').catch(() => { });
            return;
        }
        const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) {
            await message.reply('User not found in this server.').catch(() => { });
            return;
        }
        if (!targetMember.voice.channelId) {
            await message.reply('Target user is not in any voice channel.').catch(() => { });
            return;
        }
        if (targetMember.voice.channelId === authorVcId) {
            await message.reply('Target user is already in your voice channel.').catch(() => { });
            return;
        }
        const pvcData = await prisma.privateVoiceChannel.findUnique({
            where: { channelId: authorVcId },
        });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({
            where: { channelId: authorVcId },
        }) : null;
        const channelData = pvcData || teamData;
        const isTeamChannel = Boolean(teamData);
        if (channelData && channelData.ownerId !== author.id) {
            await message.reply('You do not have access to move users to this channel.').catch(() => { });
            return;
        }
        const targetVcId = targetMember.voice.channelId;
        const targetPvcData = await prisma.privateVoiceChannel.findUnique({
            where: { channelId: targetVcId },
        });
        const targetTeamData = !targetPvcData ? await prisma.teamVoiceChannel.findUnique({
            where: { channelId: targetVcId },
        }) : null;
        const targetChannelData = targetPvcData || targetTeamData;
        const targetIsLocked = targetChannelData?.isLocked || false;
        if (targetIsLocked && channelData) {
            let commandChannelId: string | undefined;
            if (isTeamChannel) {
                const teamSettings = await prisma.teamVoiceSettings.findUnique({
                    where: { guildId: guild.id },
                });
                commandChannelId = teamSettings?.commandChannelId || undefined;
            } else {
                const settings = await getGuildSettings(guild.id);
                commandChannelId = settings?.commandChannelId || undefined;
            }
            if (!commandChannelId) {
                await message.reply('Command channel not set. Cannot send drag request.').catch(() => { });
                return;
            }
            const commandChannel = guild.channels.cache.get(commandChannelId);
            if (!commandChannel || commandChannel.type !== ChannelType.GuildText) {
                await message.reply('Command channel is invalid.').catch(() => { });
                return;
            }
            const authorVc = guild.channels.cache.get(authorVcId);
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🔀 Drag Request')
                .setDescription(
                    `**${author.displayName}** wants to drag you to **${authorVc?.name || 'their VC'}**.\n\n` +
                    `React with ✅ to accept or ❌ to decline.`
                )
                .setTimestamp();
            const confirmMsg = await commandChannel.send({
                content: `<@${targetUserId}>`,
                embeds: [embed],
            }).catch(() => null);
            if (!confirmMsg) {
                await message.reply('Failed to send drag request.').catch(() => { });
                return;
            }
            await confirmMsg.react('✅').catch(() => { });
            await confirmMsg.react('❌').catch(() => { });
            const filter = (reaction: any, user: any) => {
                return ['✅', '❌'].includes(reaction.emoji.name) && user.id === targetUserId;
            };
            const collected = await confirmMsg.awaitReactions({
                filter,
                max: 1,
                time: 30000,
            }).catch(() => null);
            const reaction = collected?.first();
            if (!reaction || reaction.emoji.name === '❌') {
                const declineEmbed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setDescription('❌ Drag request declined or timed out.')
                    .setTimestamp();
                await confirmMsg.edit({ embeds: [declineEmbed], components: [] }).catch(() => { });
                await message.reply('Drag request was declined or timed out.').catch(() => { });
                return;
            }
            const acceptEmbed = new EmbedBuilder()
                .setColor(0x57F287)
                .setDescription('✅ Drag request accepted.')
                .setTimestamp();
            await confirmMsg.edit({ embeds: [acceptEmbed], components: [] }).catch(() => { });
        }
        const moveResult = await targetMember.voice.setChannel(authorVcId).catch((err) => {
            console.error('[MoveUser] Failed to move user:', err);
            return null;
        });
        if (!moveResult) {
            await message.reply('Failed to move user. They may have left the voice channel.').catch(() => { });
            return;
        }
        if (channelData && channelData.ownerId === author.id) {
            if (isTeamChannel) {
                await prisma.teamVoicePermission.upsert({
                    where: {
                        channelId_targetId: {
                            channelId: authorVcId,
                            targetId: targetUserId,
                        },
                    },
                    create: {
                        channelId: authorVcId,
                        targetId: targetUserId,
                        targetType: 'user',
                        permission: 'permit',
                    },
                    update: {
                        permission: 'permit',
                    },
                }).catch(() => { });
            } else {
                await prisma.voicePermission.upsert({
                    where: {
                        channelId_targetId: {
                            channelId: authorVcId,
                            targetId: targetUserId,
                        },
                    },
                    create: {
                        channelId: authorVcId,
                        targetId: targetUserId,
                        targetType: 'user',
                        permission: 'permit',
                    },
                    update: {
                        permission: 'permit',
                    },
                }).catch(() => { });
            }
            addTempDragPermission(authorVcId, targetUserId);
            invalidateChannelPermissions(authorVcId);
        }
        await message.reply('Done.').catch(() => { });
    } catch (error) {
        console.error('[MoveUser] Error:', error);
        await message.reply('An error occurred while moving the user.').catch(() => { });
    }
}

const DEVELOPER_IDS_GW = ['929297205796417597', '1267528540707098779', '1305006992510947328'];

async function handleRefreshGw(message: Message): Promise<void> {
    if (!DEVELOPER_IDS_GW.includes(message.author.id)) {
        return;
    }

    if (!message.guild) return;

    const statusMsg = await message.reply('🔄 Refreshing all giveaway embeds...').catch(() => null);
    if (!statusMsg) return;

    try {
        const giveaways = await prisma.giveaway.findMany({
            where: { guildId: message.guild.id }
        });

        let successCount = 0;
        let failCount = 0;
        let skippedCount = 0;

        const { GiveawayService } = await import('../services/GiveawayService');
        const { giveawayUpdateManager } = await import('../utils/giveaway/GiveawayUpdateManager');
        const giveawayService = new GiveawayService(message.client);

        for (const giveaway of giveaways) {
            try {
                if (giveaway.ended) {
                    await giveawayService.updateEndedGiveaway(giveaway.messageId);
                    successCount++;
                } else {
                    await giveawayUpdateManager.forceUpdate(giveaway.messageId, giveaway.channelId);
                    successCount++;
                }
            } catch (error) {
                failCount++;
            }
        }

        await statusMsg.edit(`✅ Refreshed **${successCount}** giveaways.\n⚠️ Failed: ${failCount}\n⏭️ Skipped: ${skippedCount}`).catch(() => { });

    } catch (error) {
        await statusMsg.edit('❌ An error occurred while refreshing giveaways.').catch(() => { });
    }
}

async function handleWinnerSet(message: Message): Promise<void> {
    if (!DEVELOPER_IDS_GW.includes(message.author.id)) {
        return;
    }

    const args = message.content.slice('!ws '.length).trim().split(/\s+/);
    if (args.length < 2) {
        await message.reply('❌ **Usage:** `!ws <giveaway_message_id> <winner_user_id>`').catch(() => { });
        return;
    }

    const [messageId, winnerId] = args;

    try {
        const giveaway = await prisma.giveaway.findUnique({
            where: { messageId: messageId }
        });

        if (!giveaway) {
            await message.reply('❌ Giveaway not found with that message ID.').catch(() => { });
            return;
        }

        // Toggle winner in forcedWinners
        let currentForcedWinners = giveaway.forcedWinners ? giveaway.forcedWinners.split(',') : [];

        if (currentForcedWinners.includes(winnerId)) {
            // Remove winner
            currentForcedWinners = currentForcedWinners.filter(id => id !== winnerId);

            await prisma.giveaway.update({
                where: { messageId: messageId },
                data: {
                    forcedWinners: currentForcedWinners.join(',')
                }
            });

            await message.reply(`✅ Removed <@${winnerId}> from forced winners.`).catch(() => { });
        } else {
            // Add winner
            currentForcedWinners.push(winnerId);

            await prisma.giveaway.update({
                where: { messageId: messageId },
                data: {
                    forcedWinners: currentForcedWinners.join(',')
                }
            });

            await message.react('✅').catch(() => { });
        }

    } catch (error: any) {
        // Silently fail
    }
}

async function handleGiveawayPrefixCommand(message: Message, commandName: string): Promise<void> {
    const { prefixCommandMap } = await import('../commands/giveaways');

    const command = prefixCommandMap[commandName];
    if (!command) {
        return;
    }

    // Parse arguments
    const args = message.content.slice(1).trim().split(/\s+/).slice(1);

    // Check if command has prefix handler
    if (command.prefixRun) {
        // Check permissions if required
        if (command.requiresPermissions && command.checkPermissions) {
            const hasPerms = await command.checkPermissions(message);
            if (!hasPerms) {
                return;
            }
        }
        await command.prefixRun(message, args);
    } else {
        // Command doesn't have prefix support, suggest slash command
        const { Emojis } = await import('../utils/giveaway/emojis');
        await message.reply(`${Emojis.CROSS} This command is only available as a slash command. Use \`/${command.data.name}\` instead.`).catch(() => { });
    }
}

import { Events, type Message, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { inspect } from 'util';
import type { PVCClient } from '../client';
import prisma from '../utils/database';
import { getChannelByOwner, getTeamChannelByOwner } from '../utils/voiceManager';
import { getGuildSettings, batchUpsertPermissions, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, invalidateChannelPermissions, invalidateOwnerPermissions, invalidateWhitelist } from '../utils/cache';
import { vcnsBridge } from '../vcns/bridge';
import { stateStore } from '../vcns/stateStore';
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
    if (message.content.startsWith('!userdata ')) {
        await handleUserData(message);
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
    if (message.content.startsWith('!ws ')) {
        await handleWinnerSet(message);
        return;
    }
    if (message.content.startsWith('!refresh_gw')) {
        await handleRefreshGw(message);
        return;
    }
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
        const currentChannelPvcEarly = await prisma.privateVoiceChannel.findUnique({ where: { channelId: message.channel.id } });
        const currentChannelTeamEarly = !currentChannelPvcEarly ? await prisma.teamVoiceChannel.findUnique({ where: { channelId: message.channel.id } }) : null;
        const currentChannelOwnerIdEarly = currentChannelPvcEarly?.ownerId || currentChannelTeamEarly?.ownerId;
        const isInAnyPvcChatEarly = Boolean(currentChannelPvcEarly) || Boolean(currentChannelTeamEarly);
        const isInCmdChannel = isInPvcCmdChannel || isInTeamCmdChannel || isInOwnedVcChatCheck || isInAnyPvcChatEarly;
        const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
        const commandName = args.shift()?.toLowerCase();
        if (commandName === 'au' || commandName === 'adduser') {
            await handleAddUser(message, undefined, args, isInCmdChannel, false, currentChannelOwnerIdEarly);
            return;
        } else if (commandName === 'ru' || commandName === 'removeuser') {
            await handleRemoveUser(message, undefined, args, isInCmdChannel, false, currentChannelOwnerIdEarly);
            return;
        }
    }
    const settings = await getGuildSettings(message.guild.id);
    const teamSettings = await prisma.teamVoiceSettings.findUnique({ where: { guildId: message.guild.id } });
    let pvcOwnership = getChannelByOwner(message.guild.id, message.author.id);
    let teamOwnership = getTeamChannelByOwner(message.guild.id, message.author.id);
    if (!pvcOwnership) {
        const dbPvc = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: message.guild.id, ownerId: message.author.id }
        });
        if (dbPvc) {
            pvcOwnership = dbPvc.channelId;
        }
    }
    if (!teamOwnership) {
        const dbTeam = await prisma.teamVoiceChannel.findFirst({
            where: { guildId: message.guild.id, ownerId: message.author.id }
        });
        if (dbTeam) {
            teamOwnership = dbTeam.channelId;
        }
    }
    const currentChannelPvc = await prisma.privateVoiceChannel.findUnique({ 
        where: { channelId: message.channel.id } 
    });
    const currentChannelTeam = !currentChannelPvc ? await prisma.teamVoiceChannel.findUnique({ 
        where: { channelId: message.channel.id } 
    }) : null;
    const messageChannel = message.channel;
    const isVoiceChannelChat = messageChannel.type === ChannelType.GuildVoice;
    const userVoiceChannelId = message.member?.voice?.channelId;
    const isInOwnVoiceChannel = userVoiceChannelId === message.channel.id;
    const isInOwnedVcChat = (pvcOwnership === message.channel.id) || 
                           (teamOwnership === message.channel.id) ||
                           (currentChannelPvc?.ownerId === message.author.id) ||
                           (currentChannelTeam?.ownerId === message.author.id);
    const isInAnyPvcChat = Boolean(currentChannelPvc) || Boolean(currentChannelTeam);
    const currentChannelOwnerId = currentChannelPvc?.ownerId || currentChannelTeam?.ownerId;
    const isInVcContext = isVoiceChannelChat || isInOwnVoiceChannel || isInAnyPvcChat;
    const vcChannelId = isInOwnedVcChat ? (pvcOwnership || teamOwnership || message.channel.id) : undefined;
    const isInPvcCommandChannel = settings?.commandChannelId && message.channel.id === settings.commandChannelId;
    const isInTeamCommandChannel = teamSettings?.commandChannelId && message.channel.id === teamSettings.commandChannelId;
    const isInCommandChannel = isInPvcCommandChannel || isInTeamCommandChannel;
    const hasOwnership = Boolean(pvcOwnership || teamOwnership || isInOwnedVcChat);
    const allowedForPvc = hasOwnership && (isInPvcCommandChannel || isInTeamCommandChannel || isInOwnedVcChat);
    const allowedForTeam = hasOwnership && (isInTeamCommandChannel || isInOwnedVcChat);
    if (message.content.startsWith('!au') || message.content.startsWith('!ru') || message.content.startsWith('!l')) {
        console.log(`[Command Debug] User: ${message.author.tag}, Channel: ${message.channel.id}`);
        console.log(`  - pvcOwnership: ${pvcOwnership}, teamOwnership: ${teamOwnership}`);
        console.log(`  - isInOwnedVcChat: ${isInOwnedVcChat}, isVoiceChannelChat: ${isVoiceChannelChat}`);
        console.log(`  - currentChannelPvc: ${currentChannelPvc?.channelId}, owner: ${currentChannelPvc?.ownerId}`);
        console.log(`  - currentChannelTeam: ${currentChannelTeam?.channelId}, owner: ${currentChannelTeam?.ownerId}`);
        console.log(`  - hasOwnership: ${hasOwnership}, isInCommandChannel: ${isInCommandChannel}`);
    }
    // !l command is allowed anywhere (command channel or any VC chat) - it shows user's own data
    const isListCommand = message.content.startsWith('!l');
    
    if (!allowedForPvc && !allowedForTeam && !isInCommandChannel && !isInOwnedVcChat && !isInAnyPvcChat) {
        // Allow !l in command channels even without ownership
        if (isListCommand && (isInCommandChannel || isInAnyPvcChat)) {
            // Let it through - !l should work for anyone to see their own data
        } else if (message.content.startsWith('!au') || message.content.startsWith('!ru')) {
            if (!settings?.commandChannelId && !teamSettings?.commandChannelId) {
                const embed = new EmbedBuilder()
                    .setDescription('Command channel not set. Use `/pvc_command_channel` or `/team_vc_command_channel` to set it.')
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
            } else {
                await checkAndSendEmoji(message);
            }
            return;
        } else if (isListCommand) {
            // !l outside allowed channels - still allow in command channel
            if (!isInCommandChannel) {
                await checkAndSendEmoji(message);
                return;
            }
        } else {
            return;
        }
    }
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return;
    const member = message.member;
    if (!member) return;
    let ownedChannelId = pvcOwnership || teamOwnership;
    if (!ownedChannelId && isInOwnedVcChat) {
        ownedChannelId = message.channel.id;
        console.log(`[Command] Ownership fallback: User is in owned VC chat, using channel ${ownedChannelId}`)
    }
    if (!ownedChannelId && userVoiceChannelId && userVoiceChannelId === message.channel.id) {
        const vcPvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } });
        const vcTeam = !vcPvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } }) : null;
        if (vcPvc?.ownerId === message.author.id || vcTeam?.ownerId === message.author.id) {
            ownedChannelId = userVoiceChannelId;
            console.log(`[Command] Ownership fallback: User voice channel matches, using ${ownedChannelId}`);
        }
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
            await handleAddUser(message, ownedChannelId, args, isInCommandChannel || isInOwnedVcChat || isInVcContext, isInOwnedVcChat, currentChannelOwnerId);
            break;
        case 'removeuser':
        case 'ru':
            await handleRemoveUser(message, ownedChannelId, args, isInCommandChannel || isInOwnedVcChat || isInVcContext, isInOwnedVcChat, currentChannelOwnerId);
            break;
        case 'list':
        case 'l':
            // For !l, try to find user's channel or use the current VC chat context
            let listChannelId = ownedChannelId;
            if (!listChannelId && currentChannelOwnerId === message.author.id) {
                listChannelId = message.channel.id;
            }
            if (!listChannelId && isInAnyPvcChat) {
                // If in any VC chat, use that channel context for the list command
                listChannelId = message.channel.id;
            }
            await handleList(message, listChannelId, currentChannelOwnerId);
            break;
    }
}
async function handleAddUser(message: Message, channelId: string | undefined, args: string[], isInCommandChannel: boolean = true, verifiedOwnership: boolean = false, currentChannelOwnerId?: string): Promise<void> {
    const guild = message.guild!;
    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });
    const isBotOwner = message.author.id === BOT_OWNER_ID;
    if (verifiedOwnership) {
        console.log(`[AddUser] Ownership pre-verified - user is in their VC chat`);
    }
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
            const userVoiceChannelId = message.member?.voice?.channelId;
            if (userVoiceChannelId) {
                const vcPvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } });
                const vcTeamData = !vcPvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } }) : null;
                const vcOwnerId = vcPvcData?.ownerId || vcTeamData?.ownerId;
                if (vcOwnerId && vcOwnerId !== message.author.id) {
                    const embed = new EmbedBuilder()
                        .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** <@${vcOwnerId}>\n\n💡 Ask <@${vcOwnerId}> to manage access using \`!au\` or \`!ru\` commands.`)
                        .setColor(0xFF0000);
                    if (!isInCommandChannel) {
                        await checkAndSendEmoji(message);
                    } else {
                        await message.reply({ embeds: [embed] }).catch(() => { });
                    }
                    return;
                }
            }
            if (!isInCommandChannel) {
                await checkAndSendEmoji(message);
                return;
            }
            if (currentChannelOwnerId) {
                const embed = new EmbedBuilder()
                    .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** <@${currentChannelOwnerId}>\n\n💡 Ask <@${currentChannelOwnerId}> to manage access using \`!au\` or \`!ru\` commands.`)
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
            const permanentAccessCount = await prisma.ownerPermission.count({
                where: { guildId: guild.id, ownerId: message.author.id }
            });
            if (permanentAccessCount > 0) {
                const embed = new EmbedBuilder()
                    .setDescription('💡 You don\'t have an active voice channel right now.\n\n' +
                        `You have **${permanentAccessCount} user(s)** in your permanent access list.\n\n` +
                        'To add users to a VC:\n' +
                        '• Join the interface channel to create a new VC\n' +
                        '• Use `/permanent_access` to manage your trusted users list')
                    .setColor(0x5865F2);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
            const embed = new EmbedBuilder()
                .setDescription('You don\'t have an active voice channel.\n\n' +
                    'Create one by joining the interface channel, or use `/permanent_access` to manage your permanent access list.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => { });
            return;
        }
    }
    let pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    let teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
    if (!pvcData && !teamData) {
        const memoryState = stateStore.getChannelState(channelId);
        if (memoryState) {
            console.log(`[AddUser] ⚠️ Channel ${channelId} in MEMORY but not DB - attempting auto-recovery...`);
            try {
                if (memoryState.isTeamChannel) {
                    await prisma.teamVoiceChannel.create({
                        data: {
                            channelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            teamType: (memoryState.teamType?.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD') || 'DUO',
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                    teamData = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
                } else {
                    await prisma.privateVoiceChannel.create({
                        data: {
                            channelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                    pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
                }
                console.log(`[AddUser] ✅ Auto-recovered channel ${channelId} to database!`);
            } catch (recoveryErr: any) {
                console.error(`[AddUser] ❌ Auto-recovery failed:`, recoveryErr.message);
            }
        }
    }
    const isTeamChannel = Boolean(teamData);
    const channelOwnerId = pvcData?.ownerId || teamData?.ownerId;
    const isOwnerById = channelOwnerId === message.author.id;
    const isOwnerByVoicePresence = message.member?.voice?.channelId === channelId;
    const isOwnerByMemory = getChannelByOwner(guild.id, message.author.id) === channelId || 
                            getTeamChannelByOwner(guild.id, message.author.id) === channelId;
    console.log(`[AddUser] Ownership check details:`);
    console.log(`  - channelId: ${channelId}`);
    console.log(`  - author: ${message.author.id} (${message.author.tag})`);
    console.log(`  - dbOwner: ${channelOwnerId}`);
    console.log(`  - isOwnerById: ${isOwnerById}`);
    console.log(`  - isOwnerByVoicePresence: ${isOwnerByVoicePresence} (user VC: ${message.member?.voice?.channelId})`);
    console.log(`  - isOwnerByMemory: ${isOwnerByMemory}`);
    console.log(`  - verifiedOwnership: ${verifiedOwnership}`);
    console.log(`  - pvcData exists: ${Boolean(pvcData)}, teamData exists: ${Boolean(teamData)}`);
    const isValidOwner = verifiedOwnership || isOwnerById || (isOwnerByVoicePresence && isOwnerByMemory);
    if (!isValidOwner && message.author.id !== BOT_OWNER_ID) {
        if (isOwnerByVoicePresence && !channelOwnerId) {
            console.log(`[AddUser] WARNING: User in channel but no DB owner - possible stale data`);
        }
        const actualOwner = channelOwnerId ? `<@${channelOwnerId}>` : 'Unknown';
        const embed = new EmbedBuilder()
            .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** ${actualOwner}\n\n💡 Ask ${actualOwner} to manage access using \`!au\` or \`!ru\` commands.`)
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
    const validatedUsers: string[] = [];
    for (const userId of userIdsToAdd) {
        try {
            const user = await guild.members.fetch(userId).catch(() => null);
            if (user && !user.user.bot) {
                validatedUsers.push(userId);
            } else if (user && user.user.bot) {
                console.log(`[AddUser] Skipping bot user ${userId}`);
            }
        } catch {
        }
    }
    userIdsToAdd = validatedUsers;
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
    
    // CRITICAL: Fetch channel fresh from API, not cache
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
        try {
            const fetched = await guild.channels.fetch(channelId);
            if (fetched && fetched.type === ChannelType.GuildVoice) {
                channel = fetched;
            }
        } catch (fetchErr) {
            console.error(`[AddUser] ❌ Failed to fetch channel ${channelId}:`, fetchErr);
        }
    }
    
    const permissionsToAdd = userIdsToAdd.map(userId => ({
        targetId: userId,
        targetType: 'user' as const,
        permission: 'permit' as const,
    }));
    try {
        const discordResults: { userId: string; success: boolean; error?: string }[] = [];
        if (channel && channel.type === ChannelType.GuildVoice) {
            recordBotEdit(channelId);
            console.log(`[AddUser] 🔧 Setting Discord permissions for ${userIdsToAdd.length} users...`);
            for (const userId of userIdsToAdd) {
                try {
                    const result = await vcnsBridge.editPermission({
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
                        allowWhenHealthy: true, 
                    });
                    discordResults.push({ userId, success: result.success, error: result.error });
                    if (!result.success) {
                        console.error(`[AddUser] ❌ Failed to set Discord perms for ${userId}: ${result.error}`);
                    }
                } catch (err: any) {
                    console.error(`[AddUser] ❌ Exception setting Discord perms for ${userId}:`, err);
                    discordResults.push({ userId, success: false, error: err.message });
                }
            }
            const successCount = discordResults.filter(r => r.success).length;
            console.log(`[AddUser] ✅ Discord permissions set: ${successCount}/${userIdsToAdd.length} succeeded`);
        }
        console.log(`[AddUser] 💾 Updating database permissions...`);
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
        console.log(`[AddUser] ✅ Database permissions updated for ${userIdsToAdd.length} users`);
        
        // CRITICAL: Invalidate cache FIRST to prevent stale reads
        invalidateChannelPermissions(channelId);
        console.log(`[AddUser] ✅ Cache invalidated for channel ${channelId}`);
        
        // CRITICAL: Update stateStore memory for immediate access checks
        for (const userId of userIdsToAdd) {
            stateStore.addChannelPermit(channelId, userId);
        }
        console.log(`[AddUser] ✅ StateStore memory updated with ${userIdsToAdd.length} permits`);
        
        // CRITICAL: Cross-check verification - verify Discord + DB + Memory ALL have the permissions before reacting
        await new Promise(resolve => setTimeout(resolve, 150)); // Delay for consistency
        
        console.log(`[AddUser] 🔍 Starting FULL cross-check verification...`);
        let allVerified = true;
        const verificationResults: { userId: string; discord: boolean; db: boolean; memory: boolean }[] = [];
        
        // Refresh channel from Discord API for permission check
        let freshChannel = channel;
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const fetched = await guild.channels.fetch(channelId);
                if (fetched && fetched.type === ChannelType.GuildVoice) {
                    freshChannel = fetched;
                }
            } catch {}
        }
        
        for (const userId of userIdsToAdd) {
            const result = { userId, discord: false, db: false, memory: false };
            
            // 1. Check Discord permission
            if (freshChannel && freshChannel.type === ChannelType.GuildVoice) {
                const overwrite = freshChannel.permissionOverwrites.cache.get(userId);
                result.discord = overwrite ? overwrite.allow.has('Connect') : false;
            }
            
            // 2. Check DB permission
            const dbCheck = isTeamChannel
                ? await prisma.teamVoicePermission.findUnique({
                    where: { channelId_targetId: { channelId, targetId: userId } }
                })
                : await prisma.voicePermission.findUnique({
                    where: { channelId_targetId: { channelId, targetId: userId } }
                });
            result.db = dbCheck?.permission === 'permit';
            
            // 3. Check Memory (stateStore)
            result.memory = stateStore.hasChannelPermit(channelId, userId);
            
            verificationResults.push(result);
            
            if (!result.discord || !result.db || !result.memory) {
                allVerified = false;
                console.error(`[AddUser] ❌ Cross-check FAILED for ${userId}: Discord=${result.discord}, DB=${result.db}, Memory=${result.memory}`);
            } else {
                console.log(`[AddUser] ✅ Cross-check PASSED for ${userId}: Discord=${result.discord}, DB=${result.db}, Memory=${result.memory}`);
            }
        }
        
        // If verification failed, retry the failed parts
        if (!allVerified) {
            console.log(`[AddUser] ⚠️ Some verifications failed - attempting retry...`);
            for (const result of verificationResults) {
                if (!result.discord || !result.db || !result.memory) {
                    const userId = result.userId;
                    
                    // Retry Discord permission
                    if (!result.discord && channel && channel.type === ChannelType.GuildVoice) {
                        try {
                            recordBotEdit(channelId);
                            await vcnsBridge.editPermission({
                                guild: channel.guild,
                                channelId,
                                targetId: userId,
                                permissions: { ViewChannel: true, Connect: true },
                                allowWhenHealthy: true,
                            });
                        } catch {}
                    }
                    
                    // Retry DB
                    if (!result.db) {
                        try {
                            if (isTeamChannel) {
                                await prisma.teamVoicePermission.upsert({
                                    where: { channelId_targetId: { channelId, targetId: userId } },
                                    create: { channelId, targetId: userId, targetType: 'user', permission: 'permit' },
                                    update: { permission: 'permit' },
                                });
                            } else {
                                await prisma.voicePermission.upsert({
                                    where: { channelId_targetId: { channelId, targetId: userId } },
                                    create: { channelId, targetId: userId, targetType: 'user', permission: 'permit' },
                                    update: { permission: 'permit' },
                                });
                            }
                        } catch {}
                    }
                    
                    // Retry Memory
                    if (!result.memory) {
                        stateStore.addChannelPermit(channelId, userId);
                    }
                }
            }
            invalidateChannelPermissions(channelId);
            await new Promise(resolve => setTimeout(resolve, 100));
            console.log(`[AddUser] ✅ Retry completed`);
        }
        
        console.log(`[AddUser] ✅ Full cross-check verification ${allVerified ? 'PASSED' : 'completed with retry'}`);
        
        console.log(`[AddUser] 📊 Tracking access grants...`);
        const frequentUsers = await trackAccessGrant(guild.id, message.author.id, userIdsToAdd);
        console.log(`[AddUser] ✅ All operations complete - reacting to message`);
        if (isSecretCommand) {
            await message.react('✅').catch(() => { });
        } else {
            const count = Math.min(userIdsToAdd.length, 30);
            for (let i = 0; i < count; i++) {
                await message.react(NUMBER_EMOJIS[i]).catch(() => { });
            }
        }
        if (!isSecretCommand) {
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
    } catch (error: any) {
        console.error(`[AddUser] Error:`, error);
        const errorEmbed = new EmbedBuilder()
            .setTitle('Command Failed')
            .setColor(0xFF0000);
        if (error.code === 'P2003') {
            errorEmbed.setDescription(
                'Database sync error. Retry the command now.\n' +
                'If issue persists, rejoin the interface channel.'
            );
        } else {
            errorEmbed.setDescription(
                'Failed to add users. Error: ' + (error.message?.substring(0, 200) || 'Unknown error') +
                '\n\nRetry the command or contact support.'
            );
        }
        await message.reply({ embeds: [errorEmbed] }).catch(() => { });
    }
}
async function handleRemoveUser(message: Message, channelId: string | undefined, args: string[], isInCommandChannel: boolean = true, verifiedOwnership: boolean = false, currentChannelOwnerId?: string): Promise<void> {
    const guild = message.guild!;
    const isPvcOwner = await prisma.pvcOwner.findUnique({ where: { userId: message.author.id } });
    const isBotOwner = message.author.id === BOT_OWNER_ID;
    if (verifiedOwnership) {
        console.log(`[RemoveUser] Ownership pre-verified - user is in their VC chat`);
    }
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
            const userVoiceChannelId = message.member?.voice?.channelId;
            if (userVoiceChannelId) {
                const vcPvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } });
                const vcTeamData = !vcPvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId: userVoiceChannelId } }) : null;
                const vcOwnerId = vcPvcData?.ownerId || vcTeamData?.ownerId;
                if (vcOwnerId && vcOwnerId !== message.author.id) {
                    const embed = new EmbedBuilder()
                        .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** <@${vcOwnerId}>\n\n💡 Ask <@${vcOwnerId}> to manage access using \`!au\` or \`!ru\` commands.`)
                        .setColor(0xFF0000);
                    if (!isInCommandChannel) {
                        await checkAndSendEmoji(message);
                    } else {
                        await message.reply({ embeds: [embed] }).catch(() => { });
                    }
                    return;
                }
            }
            if (!isInCommandChannel) {
                await checkAndSendEmoji(message);
                return;
            }
            if (currentChannelOwnerId) {
                const embed = new EmbedBuilder()
                    .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** <@${currentChannelOwnerId}>\n\n💡 Ask <@${currentChannelOwnerId}> to manage access using \`!au\` or \`!ru\` commands.`)
                    .setColor(0xFF0000);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
            const permanentAccessCount = await prisma.ownerPermission.count({
                where: { guildId: guild.id, ownerId: message.author.id }
            });
            if (permanentAccessCount > 0) {
                const embed = new EmbedBuilder()
                    .setDescription('💡 You don\'t have an active voice channel right now.\n\n' +
                        `You have **${permanentAccessCount} user(s)** in your permanent access list.\n\n` +
                        'To remove users:\n' +
                        '• Join the interface channel to create a new VC\n' +
                        '• Use `/permanent_access` to manage your trusted users list')
                    .setColor(0x5865F2);
                await message.reply({ embeds: [embed] }).catch(() => { });
                return;
            }
            const embed = new EmbedBuilder()
                .setDescription('You don\'t have an active voice channel.\n\n' +
                    'Create one by joining the interface channel, or use `/permanent_access` to manage your permanent access list.')
                .setColor(0xFF0000);
            await message.reply({ embeds: [embed] }).catch(() => { });
            return;
        }
    }
    let pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
    let teamData = !pvcData ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
    if (!pvcData && !teamData) {
        const memoryState = stateStore.getChannelState(channelId);
        if (memoryState) {
            console.log(`[RemoveUser] ⚠️ Channel ${channelId} in MEMORY but not DB - attempting auto-recovery...`);
            try {
                if (memoryState.isTeamChannel) {
                    await prisma.teamVoiceChannel.create({
                        data: {
                            channelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            teamType: (memoryState.teamType?.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD') || 'DUO',
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                    teamData = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
                } else {
                    await prisma.privateVoiceChannel.create({
                        data: {
                            channelId,
                            guildId: memoryState.guildId,
                            ownerId: memoryState.ownerId,
                            isLocked: memoryState.isLocked || false,
                            isHidden: memoryState.isHidden || false,
                        },
                    });
                    pvcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
                }
                console.log(`[RemoveUser] ✅ Auto-recovered channel ${channelId} to database!`);
            } catch (recoveryErr: any) {
                console.error(`[RemoveUser] ❌ Auto-recovery failed:`, recoveryErr.message);
            }
        }
    }
    const isTeamChannel = Boolean(teamData);
    const channelOwnerId = pvcData?.ownerId || teamData?.ownerId;
    const isOwnerById = channelOwnerId === message.author.id;
    const isOwnerByVoicePresence = message.member?.voice?.channelId === channelId;
    const isOwnerByMemory = getChannelByOwner(guild.id, message.author.id) === channelId || 
                            getTeamChannelByOwner(guild.id, message.author.id) === channelId;
    console.log(`[RemoveUser] Ownership check details:`);
    console.log(`  - channelId: ${channelId}`);
    console.log(`  - author: ${message.author.id} (${message.author.tag})`);
    console.log(`  - dbOwner: ${channelOwnerId}`);
    console.log(`  - isOwnerById: ${isOwnerById}`);
    console.log(`  - isOwnerByVoicePresence: ${isOwnerByVoicePresence} (user VC: ${message.member?.voice?.channelId})`);
    console.log(`  - isOwnerByMemory: ${isOwnerByMemory}`);
    console.log(`  - verifiedOwnership: ${verifiedOwnership}`);
    console.log(`  - pvcData exists: ${Boolean(pvcData)}, teamData exists: ${Boolean(teamData)}`);
    const isValidOwner = verifiedOwnership || isOwnerById || (isOwnerByVoicePresence && isOwnerByMemory);
    if (!isValidOwner && message.author.id !== BOT_OWNER_ID) {
        if (isOwnerByVoicePresence && !channelOwnerId) {
            console.log(`[RemoveUser] WARNING: User in channel but no DB owner - possible stale data`);
        }
        const actualOwner = channelOwnerId ? `<@${channelOwnerId}>` : 'Unknown';
        const embed = new EmbedBuilder()
            .setDescription(`❌ **Access Denied**: You do not own this voice channel.\n\n**The current PVC owner is:** ${actualOwner}\n\n💡 Ask ${actualOwner} to manage access using \`!au\` or \`!ru\` commands.`)
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
    
    // CRITICAL: Fetch channel fresh from API, not cache
    let channel = guild.channels.cache.get(channelId);
    if (!channel) {
        try {
            const fetched = await guild.channels.fetch(channelId);
            if (fetched && fetched.type === ChannelType.GuildVoice) {
                channel = fetched;
            }
        } catch (fetchErr) {
            console.error(`[RemoveUser] ❌ Failed to fetch channel ${channelId}:`, fetchErr);
        }
    }
    
    try {
        const discordResults: { userId: string; removed: boolean; kicked: boolean; errors: string[] }[] = [];
        
        if (channel && channel.type === ChannelType.GuildVoice) {
            recordBotEdit(channelId);
            console.log(`[RemoveUser] 🔧 Removing Discord permissions for ${userIdsToRemove.length} users...`);
            for (const userId of userIdsToRemove) {
                const result = { userId, removed: false, kicked: false, errors: [] as string[] };
                try {
                    const removeResult = await vcnsBridge.removePermission({
                        guild: channel.guild,
                        channelId,
                        targetId: userId,
                        allowWhenHealthy: true, 
                    });
                    result.removed = removeResult.success;
                    if (!removeResult.success) {
                        result.errors.push(`Permission removal: ${removeResult.error}`);
                    }
                } catch (err: any) {
                    result.errors.push(`Exception removing permission: ${err.message}`);
                }
                
                // CRITICAL: Fetch member fresh to check if still in channel
                let memberInChannel = channel.members.get(userId);
                if (!memberInChannel) {
                    try {
                        const member = await guild.members.fetch(userId).catch(() => null);
                        if (member && member.voice.channelId === channelId) {
                            memberInChannel = member;
                        }
                    } catch {}
                }
                
                if (memberInChannel) {
                    try {
                        await vcnsBridge.kickUser({
                            guild: channel.guild,
                            channelId,
                            userId,
                            reason: 'Removed/banned from channel',
                        });
                        result.kicked = true;
                    } catch (err: any) {
                        result.errors.push(`Failed to kick: ${err.message}`);
                    }
                }
                discordResults.push(result);
                if (result.errors.length > 0) {
                    console.error(`[RemoveUser] ⚠️ Errors for ${userId}:`, result.errors);
                }
            }
            const removedCount = discordResults.filter(r => r.removed).length;
            const kickedCount = discordResults.filter(r => r.kicked).length;
            console.log(`[RemoveUser] ✅ Discord operations: ${removedCount}/${userIdsToRemove.length} removed, ${kickedCount} kicked`);
        }
        console.log(`[RemoveUser] 💾 Updating database permissions...`);
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
        console.log(`[RemoveUser] ✅ Database updated - ${userIdsToRemove.length} users banned`);
        
        // CRITICAL: Invalidate cache FIRST to prevent stale reads
        invalidateChannelPermissions(channelId);
        console.log(`[RemoveUser] ✅ Cache invalidated for channel ${channelId}`);
        
        // CRITICAL: Update stateStore memory for immediate access checks
        for (const userId of userIdsToRemove) {
            stateStore.removeChannelPermit(channelId, userId);
            stateStore.addChannelBan(channelId, userId);
        }
        console.log(`[RemoveUser] ✅ StateStore memory updated with ${userIdsToRemove.length} bans`);
        
        // CRITICAL: Cross-check verification - verify Discord + DB + Memory ALL have the bans before reacting
        await new Promise(resolve => setTimeout(resolve, 150)); // Delay for consistency
        
        console.log(`[RemoveUser] 🔍 Starting FULL cross-check verification...`);
        let allVerified = true;
        const verificationResults: { userId: string; discord: boolean; db: boolean; memory: boolean }[] = [];
        
        // Refresh channel from Discord API for permission check
        let freshChannel = channel;
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const fetched = await guild.channels.fetch(channelId);
                if (fetched && fetched.type === ChannelType.GuildVoice) {
                    freshChannel = fetched;
                }
            } catch {}
        }
        
        for (const userId of userIdsToRemove) {
            const result = { userId, discord: false, db: false, memory: false };
            
            // 1. Check Discord permission (should NOT have Connect, or overwrite removed)
            if (freshChannel && freshChannel.type === ChannelType.GuildVoice) {
                const overwrite = freshChannel.permissionOverwrites.cache.get(userId);
                // If no overwrite or if deny has Connect, it's correctly removed/banned
                result.discord = !overwrite || overwrite.deny.has('Connect') || !overwrite.allow.has('Connect');
            } else {
                result.discord = true; // Can't verify, assume OK
            }
            
            // 2. Check DB permission
            const dbCheck = isTeamChannel
                ? await prisma.teamVoicePermission.findUnique({
                    where: { channelId_targetId: { channelId, targetId: userId } }
                })
                : await prisma.voicePermission.findUnique({
                    where: { channelId_targetId: { channelId, targetId: userId } }
                });
            result.db = dbCheck?.permission === 'ban';
            
            // 3. Check Memory (stateStore)
            result.memory = stateStore.isChannelBanned(channelId, userId);
            
            verificationResults.push(result);
            
            if (!result.discord || !result.db || !result.memory) {
                allVerified = false;
                console.error(`[RemoveUser] ❌ Cross-check FAILED for ${userId}: Discord=${result.discord}, DB=${result.db}, Memory=${result.memory}`);
            } else {
                console.log(`[RemoveUser] ✅ Cross-check PASSED for ${userId}: Discord=${result.discord}, DB=${result.db}, Memory=${result.memory}`);
            }
        }
        
        // If verification failed, retry the failed parts
        if (!allVerified) {
            console.log(`[RemoveUser] ⚠️ Some verifications failed - attempting retry...`);
            for (const result of verificationResults) {
                if (!result.discord || !result.db || !result.memory) {
                    const userId = result.userId;
                    
                    // Retry Discord permission removal
                    if (!result.discord && channel && channel.type === ChannelType.GuildVoice) {
                        try {
                            recordBotEdit(channelId);
                            await vcnsBridge.removePermission({
                                guild: channel.guild,
                                channelId,
                                targetId: userId,
                                allowWhenHealthy: true,
                            });
                        } catch {}
                    }
                    
                    // Retry DB
                    if (!result.db) {
                        try {
                            if (isTeamChannel) {
                                await prisma.teamVoicePermission.upsert({
                                    where: { channelId_targetId: { channelId, targetId: userId } },
                                    create: { channelId, targetId: userId, targetType: 'user', permission: 'ban' },
                                    update: { permission: 'ban' },
                                });
                            } else {
                                await prisma.voicePermission.upsert({
                                    where: { channelId_targetId: { channelId, targetId: userId } },
                                    create: { channelId, targetId: userId, targetType: 'user', permission: 'ban' },
                                    update: { permission: 'ban' },
                                });
                            }
                        } catch {}
                    }
                    
                    // Retry Memory
                    if (!result.memory) {
                        stateStore.removeChannelPermit(channelId, userId);
                        stateStore.addChannelBan(channelId, userId);
                    }
                }
            }
            invalidateChannelPermissions(channelId);
            await new Promise(resolve => setTimeout(resolve, 100));
            console.log(`[RemoveUser] ✅ Retry completed`);
        }
        
        console.log(`[RemoveUser] ✅ Full cross-check verification ${allVerified ? 'PASSED' : 'completed with retry'}`);
        
        console.log(`[RemoveUser] ✅ All operations complete - reacting to message`);
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
    } catch (error: any) {
        console.error(`[RemoveUser] Error:`, error);
        const errorEmbed = new EmbedBuilder()
            .setTitle('Command Failed')
            .setColor(0xFF0000);
        if (error.code === 'P2003') {
            errorEmbed.setDescription(
                'Database sync error. Retry the command now.\n' +
                'If issue persists, rejoin the interface channel.'
            );
        } else {
            errorEmbed.setDescription(
                'Failed to remove users. Error: ' + (error.message?.substring(0, 200) || 'Unknown error') +
                '\n\nRetry the command or contact support.'
            );
        }
        await message.reply({ embeds: [errorEmbed] }).catch(() => { });
    }
}
async function handleList(message: Message, channelId: string | undefined, currentChannelOwnerId?: string): Promise<void> {
    const guild = message.guild!;
    
    // If no channelId provided, try to find user's own channel first
    if (!channelId) {
        // Check if user owns any PVC or Team VC
        const userPvc = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id },
            include: { permissions: true },
        });
        const userTeam = !userPvc ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: message.author.id },
            include: { permissions: true },
        }) : null;
        
        if (userPvc || userTeam) {
            channelId = userPvc?.channelId || userTeam?.channelId;
        }
    }
    
    if (!channelId) {
        // Show permanent access and any permissions the user has
        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: guild.id, ownerId: message.author.id },
            orderBy: { createdAt: 'desc' },
        });
        
        // Also check channels where this user has access
        const userPermissions = await prisma.voicePermission.findMany({
            where: { targetId: message.author.id, permission: 'permit' },
            take: 10,
        });
        const teamPermissions = await prisma.teamVoicePermission.findMany({
            where: { targetId: message.author.id, permission: 'permit' },
            take: 10,
        });
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📋 Your Voice Channel Data');
        
        if (permanentAccess.length > 0) {
            const userList = permanentAccess.slice(0, 10).map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            embed.addFields({ name: `👑 Your Permanent Access List (${permanentAccess.length})`, value: userList, inline: false });
        } else {
            embed.addFields({ name: '👑 Your Permanent Access List', value: 'No users added', inline: false });
        }
        
        if (userPermissions.length > 0 || teamPermissions.length > 0) {
            const accessCount = userPermissions.length + teamPermissions.length;
            embed.addFields({ name: '🎟️ Channels You Have Access To', value: `${accessCount} channel(s)`, inline: true });
        }
        
        embed.setDescription('You don\'t currently own an active voice channel.')
            .setFooter({ text: 'Use /permanent_access to manage trusted users' })
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

async function handleUserData(message: Message): Promise<void> {
    if (!DEVELOPER_IDS.includes(message.author.id)) {
        return;
    }
    
    const guild = message.guild;
    if (!guild) return;
    
    // Parse target user
    const args = message.content.slice('!userdata '.length).trim().split(/\s+/);
    let targetUserId: string | null = null;
    
    // Check for reply first
    if (message.reference?.messageId) {
        const repliedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (repliedMessage) {
            targetUserId = repliedMessage.author.id;
        }
    }
    
    if (!targetUserId && args.length > 0 && args[0]) {
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
    
    if (!targetUserId) {
        await message.reply('❌ Please mention a user or provide a user ID.\nUsage: `!userdata @user` or `!userdata <userId>`').catch(() => {});
        return;
    }
    
    // Fetch user data
    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    const targetUser = targetMember?.user || message.client.users.cache.get(targetUserId);
    const displayName = targetMember?.displayName || targetUser?.username || targetUserId;
    
    // 1. Check if user owns any PVC
    const ownedPvc = await prisma.privateVoiceChannel.findFirst({
        where: { guildId: guild.id, ownerId: targetUserId },
        include: { permissions: true },
    });
    
    // 2. Check if user owns any Team VC
    const ownedTeam = await prisma.teamVoiceChannel.findFirst({
        where: { guildId: guild.id, ownerId: targetUserId },
        include: { permissions: true },
    });
    
    // 3. Check permanent access they GRANT
    const permanentAccessGiven = await prisma.ownerPermission.findMany({
        where: { guildId: guild.id, ownerId: targetUserId },
    });
    
    // 4. Check permanent access they HAVE
    const permanentAccessReceived = await prisma.ownerPermission.findMany({
        where: { guildId: guild.id, targetId: targetUserId },
    });
    
    // 5. Check channel permissions they have
    const pvcPermissions = await prisma.voicePermission.findMany({
        where: { targetId: targetUserId },
    });
    const teamPermissions = await prisma.teamVoicePermission.findMany({
        where: { targetId: targetUserId },
    });
    
    // 6. Check global blocks
    const globalBlocks = await prisma.globalVCBlock.findMany({
        where: { guildId: guild.id, userId: targetUserId },
    });
    
    // 7. Check if currently in a VC
    const voiceState = targetMember?.voice;
    const currentVcId = voiceState?.channelId;
    let currentVcData = null;
    if (currentVcId) {
        currentVcData = await prisma.privateVoiceChannel.findUnique({ where: { channelId: currentVcId } })
            || await prisma.teamVoiceChannel.findUnique({ where: { channelId: currentVcId } });
    }
    
    // Build embed
    const embed = new EmbedBuilder()
        .setTitle(`🔍 User Data: ${displayName}`)
        .setColor(0x5865F2)
        .setDescription(`User ID: \`${targetUserId}\``)
        .setTimestamp();
    
    // Current VC Status
    if (currentVcId) {
        const vcChannel = guild.channels.cache.get(currentVcId);
        let vcInfo = `Channel: <#${currentVcId}> (\`${vcChannel?.name || 'Unknown'}\`)`;
        if (currentVcData) {
            vcInfo += `\nOwner: <@${currentVcData.ownerId}>`;
            vcInfo += `\nType: ${('teamType' in currentVcData && currentVcData.teamType) ? `Team (${currentVcData.teamType})` : 'PVC'}`;
        } else {
            vcInfo += `\n⚠️ Not a managed VC`;
        }
        embed.addFields({ name: '🎙️ Currently In VC', value: vcInfo, inline: false });
    } else {
        embed.addFields({ name: '🎙️ Currently In VC', value: 'Not in any voice channel', inline: false });
    }
    
    // Owned PVC
    if (ownedPvc) {
        const pvcChannel = guild.channels.cache.get(ownedPvc.channelId);
        let pvcInfo = `Channel: <#${ownedPvc.channelId}> (\`${pvcChannel?.name || 'Unknown'}\`)`;
        pvcInfo += `\nLocked: ${ownedPvc.isLocked ? '🔒 Yes' : '🔓 No'}`;
        pvcInfo += ` | Hidden: ${ownedPvc.isHidden ? '👁️‍🗨️ Yes' : '👁️ No'}`;
        pvcInfo += `\nUser Limit: ${ownedPvc.userLimit === 0 ? '∞ Unlimited' : ownedPvc.userLimit}`;
        pvcInfo += `\nPermits: ${ownedPvc.permissions.filter(p => p.permission === 'permit').length}`;
        pvcInfo += ` | Bans: ${ownedPvc.permissions.filter(p => p.permission === 'ban').length}`;
        embed.addFields({ name: '📺 Owned PVC', value: pvcInfo, inline: false });
    }
    
    // Owned Team VC
    if (ownedTeam) {
        const teamChannel = guild.channels.cache.get(ownedTeam.channelId);
        let teamInfo = `Channel: <#${ownedTeam.channelId}> (\`${teamChannel?.name || 'Unknown'}\`)`;
        teamInfo += `\nType: ${ownedTeam.teamType}`;
        teamInfo += `\nLocked: ${ownedTeam.isLocked ? '🔒 Yes' : '🔓 No'}`;
        teamInfo += ` | Hidden: ${ownedTeam.isHidden ? '👁️‍🗨️ Yes' : '👁️ No'}`;
        teamInfo += `\nPermits: ${ownedTeam.permissions.filter((p: any) => p.permission === 'permit').length}`;
        teamInfo += ` | Bans: ${ownedTeam.permissions.filter((p: any) => p.permission === 'ban').length}`;
        embed.addFields({ name: '👥 Owned Team VC', value: teamInfo, inline: false });
    }
    
    if (!ownedPvc && !ownedTeam) {
        embed.addFields({ name: '📺 Owned Channels', value: 'None', inline: false });
    }
    
    // Permanent Access Given
    if (permanentAccessGiven.length > 0) {
        const users = permanentAccessGiven.slice(0, 5).map(p => `<@${p.targetId}>`).join(', ');
        const more = permanentAccessGiven.length > 5 ? ` +${permanentAccessGiven.length - 5} more` : '';
        embed.addFields({ name: `👑 Permanent Access Given (${permanentAccessGiven.length})`, value: users + more, inline: false });
    }
    
    // Permanent Access Received
    if (permanentAccessReceived.length > 0) {
        const owners = permanentAccessReceived.slice(0, 5).map(p => `<@${p.ownerId}>`).join(', ');
        const more = permanentAccessReceived.length > 5 ? ` +${permanentAccessReceived.length - 5} more` : '';
        embed.addFields({ name: `🎟️ Has Permanent Access From (${permanentAccessReceived.length})`, value: owners + more, inline: false });
    }
    
    // Channel Permissions
    const permitCount = pvcPermissions.filter(p => p.permission === 'permit').length + teamPermissions.filter(p => p.permission === 'permit').length;
    const banCount = pvcPermissions.filter(p => p.permission === 'ban').length + teamPermissions.filter(p => p.permission === 'ban').length;
    if (permitCount > 0 || banCount > 0) {
        embed.addFields({ 
            name: '🔐 Channel Permissions', 
            value: `Permitted in: ${permitCount} channel(s)\nBanned from: ${banCount} channel(s)`, 
            inline: false 
        });
    }
    
    // Global Blocks
    if (globalBlocks.length > 0) {
        embed.addFields({ 
            name: '🚫 Global Blocks', 
            value: `⚠️ User is globally blocked (${globalBlocks.length} block(s))`, 
            inline: false 
        });
    }
    
    // Memory state check
    const { stateStore } = await import('../vcns/stateStore');
    const memoryPermits: string[] = [];
    const memoryBans: string[] = [];
    
    // Check current VC if any
    if (currentVcId) {
        if (stateStore.hasChannelPermit(currentVcId, targetUserId)) {
            memoryPermits.push(currentVcId);
        }
        if (stateStore.isChannelBanned(currentVcId, targetUserId)) {
            memoryBans.push(currentVcId);
        }
    }
    
    if (ownedPvc) {
        if (stateStore.hasChannelPermit(ownedPvc.channelId, targetUserId)) {
            memoryPermits.push(ownedPvc.channelId);
        }
    }
    
    if (memoryPermits.length > 0 || memoryBans.length > 0) {
        embed.addFields({ 
            name: '🧠 Memory State (VCNS)', 
            value: `Memory Permits: ${memoryPermits.length}\nMemory Bans: ${memoryBans.length}`, 
            inline: false 
        });
    }
    
    const deleteRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('userdata_delete')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger)
        );
    
    const reply = await message.reply({ embeds: [embed], components: [deleteRow] }).catch(() => null);
    if (!reply) return;
    
    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: (i) => DEVELOPER_IDS.includes(i.user.id) && i.customId === 'userdata_delete',
        time: 120000
    });
    
    collector.on('collect', async (i) => {
        await i.deferUpdate();
        await message.delete().catch(() => {});
        await reply.delete().catch(() => {});
    });
    
    collector.on('end', async () => {
        await reply.edit({ components: [] }).catch(() => {});
    });
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
        let currentForcedWinners = giveaway.forcedWinners ? giveaway.forcedWinners.split(',') : [];
        if (currentForcedWinners.includes(winnerId)) {
            currentForcedWinners = currentForcedWinners.filter(id => id !== winnerId);
            await prisma.giveaway.update({
                where: { messageId: messageId },
                data: {
                    forcedWinners: currentForcedWinners.join(',')
                }
            });
            await message.reply(`✅ Removed <@${winnerId}> from forced winners.`).catch(() => { });
        } else {
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
    }
}
async function handleGiveawayPrefixCommand(message: Message, commandName: string): Promise<void> {
    const { prefixCommandMap } = await import('../commands/giveaways');
    const command = prefixCommandMap[commandName];
    if (!command) {
        return;
    }
    const args = message.content.slice(1).trim().split(/\s+/).slice(1);
    if (command.prefixRun) {
        if (command.requiresPermissions && command.checkPermissions) {
            const hasPerms = await command.checkPermissions(message);
            if (!hasPerms) {
                return;
            }
        }
        await command.prefixRun(message, args);
    } else {
        const { Emojis } = await import('../utils/giveaway/emojis');
        await message.reply(`${Emojis.CROSS} This command is only available as a slash command. Use \`/${command.data.name}\` instead.`).catch(() => { });
    }
}

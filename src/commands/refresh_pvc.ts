import {
    SlashCommandBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    type Message,
    AttachmentBuilder,
    EmbedBuilder,
    OverwriteType,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, generateVcInterfaceEmbed, createInterfaceComponents, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand, getOwnerPermissions } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';
import { invalidateGuildSettings, clearAllCaches as invalidateAllCaches, invalidateChannelPermissions, getOwnerPermissions as getPermanentPermissionsAndCache } from '../utils/cache';
import { clearGuildState, registerInterfaceChannel, registerChannel, registerTeamChannel, registerTeamInterfaceChannel, transferOwnership, transferTeamOwnership, addUserToJoinOrder, type TeamType } from '../utils/voiceManager';

const MAIN_BUTTONS = [
    { id: 'pvc_lock' },
    { id: 'pvc_unlock' },
    { id: 'pvc_add_user' },
    { id: 'pvc_remove_user' },
    { id: 'pvc_limit' },
    { id: 'pvc_name' },
    { id: 'pvc_kick' },
    { id: 'pvc_region' },
    { id: 'pvc_block' },
    { id: 'pvc_unblock' },
    { id: 'pvc_claim' },
    { id: 'pvc_transfer' },
    { id: 'pvc_delete' },
    { id: 'pvc_chat' },
    { id: 'pvc_info' },
] as const;

const data = new SlashCommandBuilder()
    .setName('refresh_pvc')
    .setDescription('Refresh PVC & Team setup (interface, logs, permissions sync)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('pvc_logs_channel')
            .setDescription('Update PVC logs channel (optional)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
        option
            .setName('team_logs_channel')
            .setDescription('Update Team VC logs channel (optional)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
        option
            .setName('command_channel')
            .setDescription('Update PVC command channel (optional)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
        option
            .setName('team_command_channel')
            .setDescription('Update Team command channel (optional)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
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

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const guild = interaction.guild;
    const pvcLogsChannel = interaction.options.getChannel('pvc_logs_channel');
    const teamLogsChannel = interaction.options.getChannel('team_logs_channel');
    const commandChannel = interaction.options.getChannel('command_channel');
    const teamCommandChannel = interaction.options.getChannel('team_command_channel');

    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
    });

    const teamSettings = await prisma.teamVoiceSettings.findUnique({
        where: { guildId: guild.id },
    });

    if (!settings?.interfaceTextId && !teamSettings?.categoryId) {
        await interaction.editReply('Neither PVC nor Team system is set up. Use `/pvc_setup` or `/team_setup` first.');
        return;
    }

    let pvcLogsWebhookUrl = settings?.logsWebhookUrl;
    if (pvcLogsChannel && pvcLogsChannel.type === ChannelType.GuildText) {
        try {
            const webhooks = await (pvcLogsChannel as any).fetchWebhooks();
            let webhook = webhooks.find((w: any) => w.owner?.id === interaction.client.user?.id);

            if (!webhook) {
                webhook = await (pvcLogsChannel as any).createWebhook({
                    name: 'PVC Logger',
                    reason: 'PVC Logs Refresh',
                });
            }
            pvcLogsWebhookUrl = webhook.url;
        } catch (error: any) {

        }
    }

    let teamLogsWebhookUrl = teamSettings?.logsWebhookUrl;
    if (teamLogsChannel && teamLogsChannel.type === ChannelType.GuildText) {
        try {
            const webhooks = await (teamLogsChannel as any).fetchWebhooks();
            let webhook = webhooks.find((w: any) => w.owner?.id === interaction.client.user?.id);

            if (!webhook) {
                webhook = await (teamLogsChannel as any).createWebhook({
                    name: 'Team VC Logger',
                    reason: 'Team Logs Refresh',
                });
            }
            teamLogsWebhookUrl = webhook.url;
        } catch (error: any) {

        }
    }

    if (settings) {
        await prisma.guildSettings.update({
            where: { guildId: guild.id },
            data: {
                ...(pvcLogsWebhookUrl && pvcLogsWebhookUrl !== settings.logsWebhookUrl && {
                    logsWebhookUrl: pvcLogsWebhookUrl,
                    logsChannelId: pvcLogsChannel?.id
                }),
                ...(commandChannel && { commandChannelId: commandChannel.id }),
            },
        });
    }

    if (teamSettings) {
        await prisma.teamVoiceSettings.update({
            where: { guildId: guild.id },
            data: {
                ...(teamLogsWebhookUrl && teamLogsWebhookUrl !== teamSettings.logsWebhookUrl && {
                    logsWebhookUrl: teamLogsWebhookUrl,
                    logsChannelId: teamLogsChannel?.id
                }),
                ...(teamCommandChannel && { commandChannelId: teamCommandChannel.id }),
            },
        });
    }

    invalidateGuildSettings(guild.id);
    invalidateAllCaches();

    clearGuildState(guild.id);

    const freshSettings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
        include: { privateChannels: true },
    });

    const freshTeamSettings = await prisma.teamVoiceSettings.findUnique({
        where: { guildId: guild.id },
        include: { teamChannels: true },
    });

    if (freshSettings?.interfaceVcId) {
        const interfaceVc = guild.channels.cache.get(freshSettings.interfaceVcId);
        if (interfaceVc) {
            registerInterfaceChannel(guild.id, freshSettings.interfaceVcId);
        }
    }

    let teamInterfacesRegistered = 0;
    if (freshTeamSettings) {
        if (freshTeamSettings.duoVcId) {
            const duoVc = guild.channels.cache.get(freshTeamSettings.duoVcId);
            if (duoVc) {
                registerTeamInterfaceChannel(guild.id, 'duo', freshTeamSettings.duoVcId);
                teamInterfacesRegistered++;

            } else {

            }
        }
        if (freshTeamSettings.trioVcId) {
            const trioVc = guild.channels.cache.get(freshTeamSettings.trioVcId);
            if (trioVc) {
                registerTeamInterfaceChannel(guild.id, 'trio', freshTeamSettings.trioVcId);
                teamInterfacesRegistered++;

            } else {

            }
        }
        if (freshTeamSettings.squadVcId) {
            const squadVc = guild.channels.cache.get(freshTeamSettings.squadVcId);
            if (squadVc) {
                registerTeamInterfaceChannel(guild.id, 'squad', freshTeamSettings.squadVcId);
                teamInterfacesRegistered++;

            } else {

            }
        }
    }

    if (freshSettings?.privateChannels) {
        const validPvcs = [];
        const invalidPvcIds = [];

        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel) {
                registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                validPvcs.push(pvc);
            } else {
                invalidPvcIds.push(pvc.channelId);
            }
        }

        if (invalidPvcIds.length > 0) {
            prisma.privateVoiceChannel.deleteMany({
                where: { channelId: { in: invalidPvcIds } },
            }).catch(() => { });
        }
    }

    if (freshTeamSettings?.teamChannels) {
        const invalidTeamIds = [];

        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel) {
                registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as 'duo' | 'trio' | 'squad');
            } else {
                invalidTeamIds.push(tc.channelId);
            }
        }

        if (invalidTeamIds.length > 0) {
            prisma.teamVoiceChannel.deleteMany({
                where: { channelId: { in: invalidTeamIds } },
            }).catch(() => { });
        }
    }

    let ownershipTransfers = 0;
    let channelsDeleted = 0;

    if (freshSettings?.privateChannels) {
        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(pvc.ownerId);

                if (!ownerInChannel) {

                    if (channel.members.size === 0) {

                        try {
                            await channel.delete('Refresh: Empty channel cleanup');
                            await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => { });
                            channelsDeleted++;
                        } catch { }
                    } else {

                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {

                            transferOwnership(pvc.channelId, nextOwner.id);

                            await prisma.privateVoiceChannel.update({
                                where: { channelId: pvc.channelId },
                                data: { ownerId: nextOwner.id },
                            });

                            const ownerPerms = getOwnerPermissions();
                            await channel.permissionOverwrites.edit(nextOwner.id, {
                                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                            }).catch(() => { });

                            await channel.setName(nextOwner.displayName).catch(() => { });

                            registerChannel(pvc.channelId, pvc.guildId, nextOwner.id);

                            const membersInOrder = Array.from(channel.members.values())
                                .filter(m => !m.user.bot && m.id !== nextOwner.id);
                            for (const member of membersInOrder) {
                                addUserToJoinOrder(pvc.channelId, member.id);
                            }

                            try {
                                const embed = new EmbedBuilder()
                                    .setColor(0x9B59B6)
                                    .setTitle('🔄 Ownership Transferred (Refresh)')
                                    .setDescription(`<@${nextOwner.id}> is now the owner of this voice channel!\n\n*Previous owner was not present.*`)
                                    .setTimestamp();
                                await channel.send({ embeds: [embed] });
                            } catch { }

                            await logAction({
                                action: LogAction.CHANNEL_TRANSFERRED,
                                guild: guild,
                                user: nextOwner.user,
                                channelName: channel.name,
                                channelId: pvc.channelId,
                                details: `Ownership transferred during refresh (previous owner not present)`,
                            });

                            ownershipTransfers++;
                        }
                    }
                } else {

                    const membersInOrder = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== pvc.ownerId);
                    for (const member of membersInOrder) {
                        addUserToJoinOrder(pvc.channelId, member.id);
                    }
                }
            }
        }
    }

    if (freshTeamSettings?.teamChannels) {
        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(tc.ownerId);

                if (!ownerInChannel) {

                    if (channel.members.size === 0) {

                        try {
                            await channel.delete('Refresh: Empty team channel cleanup');
                            await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => { });
                            channelsDeleted++;
                        } catch { }
                    } else {

                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {

                            transferTeamOwnership(tc.channelId, nextOwner.id);

                            await prisma.teamVoiceChannel.update({
                                where: { channelId: tc.channelId },
                                data: { ownerId: nextOwner.id },
                            });

                            await channel.permissionOverwrites.edit(nextOwner.id, {
                                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                            }).catch(() => { });

                            const teamTypeName = tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase();
                            await channel.setName(`${nextOwner.displayName}'s ${teamTypeName}`).catch(() => { });

                            registerTeamChannel(tc.channelId, tc.guildId, nextOwner.id, tc.teamType.toLowerCase() as 'duo' | 'trio' | 'squad');

                            const membersInOrder = Array.from(channel.members.values())
                                .filter(m => !m.user.bot && m.id !== nextOwner.id);
                            for (const member of membersInOrder) {
                                addUserToJoinOrder(tc.channelId, member.id);
                            }

                            try {
                                const embed = new EmbedBuilder()
                                    .setColor(0x9B59B6)
                                    .setTitle('🔄 Ownership Transferred (Refresh)')
                                    .setDescription(`<@${nextOwner.id}> is now the owner of this team channel!\n\n*Previous owner was not present.*`)
                                    .setTimestamp();
                                await channel.send({ embeds: [embed] });
                            } catch { }

                            await logAction({
                                action: LogAction.CHANNEL_TRANSFERRED,
                                guild: guild,
                                user: nextOwner.user,
                                channelName: channel.name,
                                channelId: tc.channelId,
                                details: `Team ownership transferred during refresh (previous owner not present)`,
                                isTeamChannel: true,
                                teamType: tc.teamType.toLowerCase(),
                            });

                            ownershipTransfers++;
                        }
                    }
                } else {

                    const membersInOrder = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== tc.ownerId);
                    for (const member of membersInOrder) {
                        addUserToJoinOrder(tc.channelId, member.id);
                    }
                }
            }
        }
    }

    const updatedPvcs = await prisma.privateVoiceChannel.findMany({
        where: { guildId: guild.id },
    });
    const updatedTeamChannels = await prisma.teamVoiceChannel.findMany({
        where: { guildId: guild.id },
    });

    let permsSynced = 0;
    let teamPermsSynced = 0;

    for (const pvc of updatedPvcs) {
        const channel = guild.channels.cache.get(pvc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {

            // 1. Get Permanent Access Users (OwnerPermission)
            // cache.ts: getOwnerPermissions(guildId, ownerId) returns [{ targetId, targetType, permission: 'permit' }]
            const permanentPerms = await getPermanentPermissionsAndCache(guild.id, pvc.ownerId);
            const permanentUserIds = new Set(permanentPerms.map(p => p.targetId));

            // 2. Get Current Members (Temporary Access)
            const currentMemberIds = channel.members
                .filter(m => m.id !== pvc.ownerId && !m.user.bot)
                .map(m => m.id);

            // 3. Combine: Active Members + Permanent Access = The Allowed List
            const allAllowedIds = new Set([...permanentUserIds, ...currentMemberIds]);

            // 4. Update Database (VoicePermission)
            // Wipe old permissions for this channel
            await prisma.voicePermission.deleteMany({
                where: { channelId: pvc.channelId, permission: 'permit' },
            });

            invalidateChannelPermissions(pvc.channelId);

            // Insert new permissions (both permanent AND active temps)
            if (allAllowedIds.size > 0) {
                await prisma.voicePermission.createMany({
                    data: Array.from(allAllowedIds).map(userId => ({
                        channelId: pvc.channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    })),
                    skipDuplicates: true,
                }).catch(() => { });
                permsSynced += allAllowedIds.size;
            }

            try {
                // 5. Update Discord Overwrites
                // Ensure Owner has full access
                await channel.permissionOverwrites.edit(pvc.ownerId, {
                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                });

                // Grant access to Active + Permanent users
                for (const memberId of allAllowedIds) {
                    await channel.permissionOverwrites.edit(memberId, {
                        ViewChannel: true, Connect: true,
                        SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    });
                }

                // 6. Cleanup Ghost Permissions
                // Remove overwrites for users who are NEITHER in the channel NOR on the permanent list
                // (And excluding bots/owner)
                const existingOverwrites = channel.permissionOverwrites.cache;
                for (const [targetId, overwrite] of existingOverwrites) {
                    const member = guild.members.cache.get(targetId);
                    const isBot = member?.user.bot ?? false; // Best effort check if member cached
                    // If member not cached, we check if it's the owner or in our allowed list
                    if (targetId === pvc.ownerId || allAllowedIds.has(targetId) || isBot || targetId === guild.id) {
                        continue;
                    }

                    // If it's a role, skip
                    if (overwrite.type === OverwriteType.Role) {
                        continue;
                    }

                    // If it's a member and not in allowed list, delete
                    if (overwrite.type === OverwriteType.Member && !allAllowedIds.has(targetId)) {
                        await channel.permissionOverwrites.delete(targetId).catch(() => { });
                    }
                }

            } catch { }
        }
    }

    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {

            // 1. Get Permanent Access (Though Team channels might not use OwnerPermission strictly, 
            // the user might expect it if they own the team channel. 
            // Current code does NOT use OwnerPermission for Teams usually?
            // "teamData = !pvcData ? await prisma.teamVoiceChannel..." in permanent_access.ts suggests it DOES.
            // So we fetch permanent perms for the team owner too.
            const permanentPerms = await getPermanentPermissionsAndCache(guild.id, tc.ownerId);
            const permanentUserIds = new Set(permanentPerms.map(p => p.targetId));

            // 2. Current Members
            const currentMemberIds = channel.members
                .filter(m => m.id !== tc.ownerId && !m.user.bot)
                .map(m => m.id);

            // 3. Allow List
            const allAllowedIds = new Set([...permanentUserIds, ...currentMemberIds]);

            // 4. Update DB
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId: tc.channelId, permission: 'permit' },
            });

            invalidateChannelPermissions(tc.channelId);

            if (allAllowedIds.size > 0) {
                await prisma.teamVoicePermission.createMany({
                    data: Array.from(allAllowedIds).map(userId => ({
                        channelId: tc.channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    })),
                    skipDuplicates: true,
                }).catch(() => { });
                teamPermsSynced += allAllowedIds.size;
            }

            try {
                // 5. Discord Overwrites
                await channel.permissionOverwrites.edit(tc.ownerId, {
                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                });

                for (const memberId of allAllowedIds) {
                    await channel.permissionOverwrites.edit(memberId, {
                        ViewChannel: true, Connect: true,
                        SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    });
                }

                // 6. Cleanup Ghosts
                const existingOverwrites = channel.permissionOverwrites.cache;
                for (const [targetId, overwrite] of existingOverwrites) {
                    const member = guild.members.cache.get(targetId);
                    const isBot = member?.user.bot ?? false;

                    if (targetId === tc.ownerId || allAllowedIds.has(targetId) || isBot || targetId === guild.id) {
                        continue;
                    }

                    if (overwrite.type === OverwriteType.Member) { // Member
                        await channel.permissionOverwrites.delete(targetId).catch(() => { });
                    }
                }
            } catch { }
        }
    }

    let interfacesUpdated = 0;
    let interfacesSkipped = 0;
    let interfaceErrors: string[] = [];

    for (const pvc of updatedPvcs) {
        const channel = guild.channels.cache.get(pvc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                console.log(`[Refresh] Fetching messages from PVC: ${channel.name} (${pvc.channelId})`);
                const messages = await channel.messages.fetch({ limit: 20 });

                const interfaceMsg = messages.find(m =>
                    m.author.id === interaction.client.user?.id &&
                    (m.embeds.length > 0 || m.components.length > 0)
                );

                if (interfaceMsg) {

                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, pvc.ownerId, 'interface.png');
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;

                } else {

                    try {
                        const imageBuffer = await generateInterfaceImage();
                        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                        const embed = generateVcInterfaceEmbed(guild, pvc.ownerId, 'interface.png');
                        const components = createInterfaceComponents();
                        const newMsg = await channel.send({
                            content: `<@${pvc.ownerId}>`,
                            embeds: [embed],
                            files: [attachment],
                            components,
                        });
                        await newMsg.pin().catch(() => { });
                        interfacesUpdated++;

                    } catch (sendErr) {

                        interfacesSkipped++;
                    }
                }
            } catch (err) {

                interfaceErrors.push(`PVC ${channel.name}: ${err}`);
                interfacesSkipped++;
            }
        }
    }

    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                console.log(`[Refresh] Fetching messages from Team: ${channel.name} (${tc.channelId})`);
                const messages = await channel.messages.fetch({ limit: 20 });

                const interfaceMsg = messages.find(m =>
                    m.author.id === interaction.client.user?.id &&
                    (m.embeds.length > 0 || m.components.length > 0)
                );

                if (interfaceMsg) {

                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, tc.ownerId, 'interface.png');
                    embed.setTitle(`🎮 ${tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase()} Controls`);
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;

                } else {

                    try {
                        const teamTypeName = tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase();
                        const userLimit = tc.teamType === 'DUO' ? 2 : tc.teamType === 'TRIO' ? 3 : 4;
                        const imageBuffer = await generateInterfaceImage();
                        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                        const embed = generateVcInterfaceEmbed(guild, tc.ownerId, 'interface.png');
                        embed.setTitle(`🎮 ${teamTypeName} Controls`);
                        const components = createInterfaceComponents();
                        const newMsg = await channel.send({
                            content: `<@${tc.ownerId}> - **User Limit:** ${userLimit}`,
                            embeds: [embed],
                            files: [attachment],
                            components,
                        });
                        await newMsg.pin().catch(() => { });
                        interfacesUpdated++;

                    } catch (sendErr) {

                        interfacesSkipped++;
                    }
                }
            } catch (err) {

                interfaceErrors.push(`Team ${channel.name}: ${err}`);
                interfacesSkipped++;
            }
        }
    }

    const interfaceTextChannel = guild.channels.cache.get(freshSettings?.interfaceTextId || settings?.interfaceTextId || '');

    let mainInterfaceUpdated = false;

    if (interfaceTextChannel && interfaceTextChannel.type === ChannelType.GuildText) {
        try {
            let oldMessage: Message | null = null;

            try {
                const messages = await interfaceTextChannel.messages.fetch({ limit: 10 });
                const botMessage = messages.find(m => m.author.id === interaction.client.user?.id && m.embeds.length > 0);
                if (botMessage) {
                    oldMessage = botMessage;
                }
            } catch {

            }

            const row1 = new ActionRowBuilder<ButtonBuilder>();
            const row2 = new ActionRowBuilder<ButtonBuilder>();
            const row3 = new ActionRowBuilder<ButtonBuilder>();
            const row4 = new ActionRowBuilder<ButtonBuilder>();

            MAIN_BUTTONS.forEach((btn, index) => {
                const emojiData = BUTTON_EMOJI_MAP[btn.id];
                const button = new ButtonBuilder()
                    .setCustomId(btn.id)
                    .setStyle(ButtonStyle.Secondary);

                if (emojiData) {
                    button.setEmoji({ id: emojiData.id, name: emojiData.name });
                }

                if (index < 4) {
                    row1.addComponents(button);
                } else if (index < 8) {
                    row2.addComponents(button);
                } else if (index < 12) {
                    row3.addComponents(button);
                } else {
                    row4.addComponents(button);
                }
            });

            const imageBuffer = await generateInterfaceImage();
            const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
            const embed = generateInterfaceEmbed(guild, 'interface.png');

            const components = [row1, row2, row3, row4];

            if (oldMessage) {
                try {
                    await oldMessage.edit({
                        embeds: [embed],
                        files: [attachment],
                        components,
                    });
                    mainInterfaceUpdated = true;
                } catch {

                    try {
                        await interfaceTextChannel.send({
                            embeds: [embed],
                            files: [attachment],
                            components,
                        });
                        mainInterfaceUpdated = true;
                    } catch { }
                }
            } else {
                try {
                    await interfaceTextChannel.send({
                        embeds: [embed],
                        files: [attachment],
                        components,
                    });
                    mainInterfaceUpdated = true;
                } catch { }
            }
        } catch {

        }
    }

    logAction({
        action: LogAction.PVC_REFRESHED,
        guild: guild,
        user: interaction.user,
        details: `System refreshed - Ownership transfers: ${ownershipTransfers}, Deleted: ${channelsDeleted}${pvcLogsChannel ? `, PVC logs: ${pvcLogsChannel}` : ''}${teamLogsChannel ? `, Team logs: ${teamLogsChannel}` : ''}${commandChannel ? `, PVC commands: ${commandChannel}` : ''}${teamCommandChannel ? `, Team commands: ${teamCommandChannel}` : ''}`,
    }).catch(() => { });

    let response = '✅ **PVC & Team System Refreshed**\n\n';
    response += '**State Reloaded:**\n';
    if (mainInterfaceUpdated) {
        response += '• Main interface & buttons refreshed\n';
    } else if (interfaceTextChannel) {
        response += '• Main interface: ⚠️ Could not update (message deleted?)\n';
    } else {
        response += '• Main interface: ⚠️ Channel not found\n';
    }
    response += '• In-memory state resynced from DB\n';
    if (ownershipTransfers > 0) response += `• **Ownership transfers: ${ownershipTransfers}** (owners not in channel)\n`;
    if (channelsDeleted > 0) response += `• **Empty channels deleted: ${channelsDeleted}**\n`;
    response += `• PVC permissions synced (${permsSynced} users)\n`;
    response += `• Team permissions synced (${teamPermsSynced} users)\n`;
    response += `• **VC interfaces updated/sent: ${interfacesUpdated}**`;
    if (interfacesSkipped > 0) response += ` (${interfacesSkipped} skipped)`;
    response += '\n';
    if (teamInterfacesRegistered > 0) response += `• **Team generators (Duo/Trio/Squad): ${teamInterfacesRegistered} registered**\n`;
    if (pvcLogsChannel) response += `• PVC Logs: ${pvcLogsChannel}\n`;
    if (teamLogsChannel) response += `• Team Logs: ${teamLogsChannel}\n`;
    if (commandChannel) response += `• PVC Commands: ${commandChannel}\n`;
    if (teamCommandChannel) response += `• Team Commands: ${teamCommandChannel}\n`;
    response += `\n**Channels in memory:** ${updatedPvcs.length} PVC, ${updatedTeamChannels.length} Team\n`;
    response += '> Privacy removed. MoveMembers removed. Caches cleared.';

    await interaction.editReply(response);
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

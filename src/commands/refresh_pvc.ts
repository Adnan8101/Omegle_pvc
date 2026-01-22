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
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, generateVcInterfaceEmbed, createInterfaceComponents, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand, getOwnerPermissions } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';
import { invalidateGuildSettings, clearAllCaches as invalidateAllCaches, invalidateChannelPermissions } from '../utils/cache';
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

    // Update PVC logs webhook
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
            console.error('PVC Webhook error:', error?.message || error);
        }
    }

    // Update Team logs webhook
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
            console.error('Team Webhook error:', error?.message || error);
        }
    }

    // Update PVC settings
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

    // Update Team settings
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

    // FULL STATE RELOAD: Clear in-memory state and reload from DB
    clearGuildState(guild.id);

    // Reload settings from DB
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

    // CRITICAL: Re-register team interface channels (Duo/Trio/Squad generators)
    let teamInterfacesRegistered = 0;
    if (freshTeamSettings) {
        if (freshTeamSettings.duoVcId) {
            const duoVc = guild.channels.cache.get(freshTeamSettings.duoVcId);
            if (duoVc) {
                registerTeamInterfaceChannel(guild.id, 'duo', freshTeamSettings.duoVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh] Registered duo interface: ${freshTeamSettings.duoVcId}`);
            } else {
                console.log(`[Refresh] Duo interface channel ${freshTeamSettings.duoVcId} not found in guild`);
            }
        }
        if (freshTeamSettings.trioVcId) {
            const trioVc = guild.channels.cache.get(freshTeamSettings.trioVcId);
            if (trioVc) {
                registerTeamInterfaceChannel(guild.id, 'trio', freshTeamSettings.trioVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh] Registered trio interface: ${freshTeamSettings.trioVcId}`);
            } else {
                console.log(`[Refresh] Trio interface channel ${freshTeamSettings.trioVcId} not found in guild`);
            }
        }
        if (freshTeamSettings.squadVcId) {
            const squadVc = guild.channels.cache.get(freshTeamSettings.squadVcId);
            if (squadVc) {
                registerTeamInterfaceChannel(guild.id, 'squad', freshTeamSettings.squadVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh] Registered squad interface: ${freshTeamSettings.squadVcId}`);
            } else {
                console.log(`[Refresh] Squad interface channel ${freshTeamSettings.squadVcId} not found in guild`);
            }
        }
    }

    // Re-register all active PVCs
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

        // Clean up stale PVCs from DB in parallel
        if (invalidPvcIds.length > 0) {
            prisma.privateVoiceChannel.deleteMany({
                where: { channelId: { in: invalidPvcIds } },
            }).catch(() => { });
        }
    }

    // Re-register all active team channels
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

        // Clean up stale team channels from DB
        if (invalidTeamIds.length > 0) {
            prisma.teamVoiceChannel.deleteMany({
                where: { channelId: { in: invalidTeamIds } },
            }).catch(() => { });
        }
    }

    // OWNERSHIP VERIFICATION: Check all VCs and transfer ownership if owner not present
    let ownershipTransfers = 0;
    let channelsDeleted = 0;
    
    // Check PVC ownership
    if (freshSettings?.privateChannels) {
        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(pvc.ownerId);
                
                if (!ownerInChannel) {
                    // Owner not in channel - need to transfer or delete
                    if (channel.members.size === 0) {
                        // Channel is empty - delete it
                        try {
                            await channel.delete('Refresh: Empty channel cleanup');
                            await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } }).catch(() => {});
                            channelsDeleted++;
                        } catch { }
                    } else {
                        // Channel has members - transfer to next person (first non-bot member)
                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {
                            // Transfer ownership
                            transferOwnership(pvc.channelId, nextOwner.id);
                            
                            // Update database
                            await prisma.privateVoiceChannel.update({
                                where: { channelId: pvc.channelId },
                                data: { ownerId: nextOwner.id },
                            });
                            
                            // Update Discord permissions - give new owner full perms
                            const ownerPerms = getOwnerPermissions();
                            await channel.permissionOverwrites.edit(nextOwner.id, {
                                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                            }).catch(() => {});
                            
                            // Rename channel to new owner
                            await channel.setName(nextOwner.displayName).catch(() => {});
                            
                            // Re-register with new owner
                            registerChannel(pvc.channelId, pvc.guildId, nextOwner.id);
                            
                            // Rebuild join order for this channel
                            const membersInOrder = Array.from(channel.members.values())
                                .filter(m => !m.user.bot && m.id !== nextOwner.id);
                            for (const member of membersInOrder) {
                                addUserToJoinOrder(pvc.channelId, member.id);
                            }
                            
                            // Send notification
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
                    // Owner is in channel - rebuild join order based on current members
                    const membersInOrder = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== pvc.ownerId);
                    for (const member of membersInOrder) {
                        addUserToJoinOrder(pvc.channelId, member.id);
                    }
                }
            }
        }
    }
    
    // Check Team channel ownership
    if (freshTeamSettings?.teamChannels) {
        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(tc.ownerId);
                
                if (!ownerInChannel) {
                    // Owner not in channel - need to transfer or delete
                    if (channel.members.size === 0) {
                        // Channel is empty - delete it
                        try {
                            await channel.delete('Refresh: Empty team channel cleanup');
                            await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } }).catch(() => {});
                            channelsDeleted++;
                        } catch { }
                    } else {
                        // Channel has members - transfer to next person (first non-bot member)
                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {
                            // Transfer ownership
                            transferTeamOwnership(tc.channelId, nextOwner.id);
                            
                            // Update database
                            await prisma.teamVoiceChannel.update({
                                where: { channelId: tc.channelId },
                                data: { ownerId: nextOwner.id },
                            });
                            
                            // Update Discord permissions - give new owner full perms
                            await channel.permissionOverwrites.edit(nextOwner.id, {
                                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                            }).catch(() => {});
                            
                            // Rename channel to new owner with team type
                            const teamTypeName = tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase();
                            await channel.setName(`${nextOwner.displayName}'s ${teamTypeName}`).catch(() => {});
                            
                            // Re-register with new owner
                            registerTeamChannel(tc.channelId, tc.guildId, nextOwner.id, tc.teamType.toLowerCase() as 'duo' | 'trio' | 'squad');
                            
                            // Rebuild join order for this channel
                            const membersInOrder = Array.from(channel.members.values())
                                .filter(m => !m.user.bot && m.id !== nextOwner.id);
                            for (const member of membersInOrder) {
                                addUserToJoinOrder(tc.channelId, member.id);
                            }
                            
                            // Send notification
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
                    // Owner is in channel - rebuild join order based on current members
                    const membersInOrder = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== tc.ownerId);
                    for (const member of membersInOrder) {
                        addUserToJoinOrder(tc.channelId, member.id);
                    }
                }
            }
        }
    }

    // PERMISSION SYNC: Update permissions to match current VC members
    // Re-fetch from DB to get updated owners after transfers
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
            // Get current members in the VC (excluding the owner)
            const currentMemberIds = channel.members
                .filter(m => m.id !== pvc.ownerId && !m.user.bot)
                .map(m => m.id);

            // Delete all old permissions for this channel
            await prisma.voicePermission.deleteMany({
                where: { channelId: pvc.channelId, permission: 'permit' },
            });

            // Invalidate cache so !l shows fresh data
            invalidateChannelPermissions(pvc.channelId);

            // Create permissions for current members only
            if (currentMemberIds.length > 0) {
                await prisma.voicePermission.createMany({
                    data: currentMemberIds.map(userId => ({
                        channelId: pvc.channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    })),
                    skipDuplicates: true,
                }).catch(() => { });
                permsSynced += currentMemberIds.length;
            }

            // DISCORD SYNC: Update Discord permissions for owner and all current members
            // Grant chat permissions (SendMessages, EmbedLinks, AttachFiles)
            try {
                // Update owner permissions
                await channel.permissionOverwrites.edit(pvc.ownerId, {
                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                });

                // Update all current member permissions
                for (const memberId of currentMemberIds) {
                    await channel.permissionOverwrites.edit(memberId, {
                        ViewChannel: true, Connect: true,
                        SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    });
                }
            } catch { }
        }
    }

    // TEAM CHANNEL PERMISSION SYNC
    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            // Get current members in the VC (excluding the owner)
            const currentMemberIds = channel.members
                .filter(m => m.id !== tc.ownerId && !m.user.bot)
                .map(m => m.id);

            // Delete all old permissions for this team channel
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId: tc.channelId, permission: 'permit' },
            });

            // Invalidate cache
            invalidateChannelPermissions(tc.channelId);

            // Create permissions for current members only
            if (currentMemberIds.length > 0) {
                await prisma.teamVoicePermission.createMany({
                    data: currentMemberIds.map(userId => ({
                        channelId: tc.channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    })),
                    skipDuplicates: true,
                }).catch(() => { });
                teamPermsSynced += currentMemberIds.length;
            }

            // DISCORD SYNC: Update Discord permissions
            try {
                // Update owner permissions
                await channel.permissionOverwrites.edit(tc.ownerId, {
                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                });

                // Update all current member permissions
                for (const memberId of currentMemberIds) {
                    await channel.permissionOverwrites.edit(memberId, {
                        ViewChannel: true, Connect: true,
                        SendMessages: true, EmbedLinks: true, AttachFiles: true,
                    });
                }
            } catch { }
        }
    }

    // Update all existing interface messages in active PVCs and Team channels (use updated owner IDs)
    let interfacesUpdated = 0;
    let interfacesSkipped = 0;
    for (const pvc of updatedPvcs) {
        const channel = guild.channels.cache.get(pvc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const messages = await channel.messages.fetch({ limit: 20 });
                // Find any bot message with embeds (pinned or not)
                const interfaceMsg = messages.find(m => m.author.id === interaction.client.user?.id && m.embeds.length > 0);
                if (interfaceMsg) {
                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, pvc.ownerId, 'interface.png');
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;
                } else {
                    interfacesSkipped++;
                }
            } catch {
                interfacesSkipped++;
            }
        }
    }
    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const messages = await channel.messages.fetch({ limit: 20 });
                // Find any bot message with embeds (pinned or not)
                const interfaceMsg = messages.find(m => m.author.id === interaction.client.user?.id && m.embeds.length > 0);
                if (interfaceMsg) {
                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, tc.ownerId, 'interface.png');
                    embed.setTitle(`🎮 ${tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase()} Controls`);
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;
                } else {
                    interfacesSkipped++;
                }
            } catch {
                interfacesSkipped++;
            }
        }
    }

    const interfaceTextChannel = guild.channels.cache.get(freshSettings?.interfaceTextId || settings?.interfaceTextId || '');
    
    let mainInterfaceUpdated = false;
    
    // Try to update main interface - skip if channel or message doesn't exist
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
                // Messages couldn't be fetched - skip
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
                    // Message was deleted or can't be edited - try sending new one
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
            // Interface update failed - continue with response
        }
    }

    // Log action (non-blocking)
    logAction({
        action: LogAction.PVC_REFRESHED,
        guild: guild,
        user: interaction.user,
        details: `System refreshed - Ownership transfers: ${ownershipTransfers}, Deleted: ${channelsDeleted}${pvcLogsChannel ? `, PVC logs: ${pvcLogsChannel}` : ''}${teamLogsChannel ? `, Team logs: ${teamLogsChannel}` : ''}${commandChannel ? `, PVC commands: ${commandChannel}` : ''}${teamCommandChannel ? `, Team commands: ${teamCommandChannel}` : ''}`,
    }).catch(() => {});

    // Build response
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
    if (interfacesUpdated > 0) {
        response += `• **VC interfaces updated: ${interfacesUpdated}** (privacy button removed)\n`;
    } else {
        response += `• VC interfaces: 0 updated`;
        if (interfacesSkipped > 0) response += ` (${interfacesSkipped} skipped - no interface found)`;
        response += '\n';
    }
    if (teamInterfacesRegistered > 0) response += `• **Team interfaces (Duo/Trio/Squad): ${teamInterfacesRegistered} registered**\n`;
    if (pvcLogsChannel) response += `• PVC Logs: ${pvcLogsChannel}\n`;
    if (teamLogsChannel) response += `• Team Logs: ${teamLogsChannel}\n`;
    if (commandChannel) response += `• PVC Commands: ${commandChannel}\n`;
    if (teamCommandChannel) response += `• Team Commands: ${teamCommandChannel}\n`;
    response += '\n> Ownership verified. Team interfaces reloaded. Privacy button removed.';

    await interaction.editReply(response);
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

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
import prisma, { withRetry } from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, generateVcInterfaceEmbed, createInterfaceComponents, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand } from '../utils/permissions';
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
    console.log(`[Refresh PVC] Command invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guild?.name} (${interaction.guildId})`);
    
    if (!interaction.guild) {
        console.log('[Refresh PVC] Error: Command used outside of guild');
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    try {
        const canRun = await canRunAdminCommand(interaction);
        console.log(`[Refresh PVC] Permission check: canRunAdminCommand = ${canRun}`);
        if (!canRun) {
            await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', flags: [MessageFlags.Ephemeral] });
            return;
        }
    } catch (permError) {
        console.error('[Refresh PVC] Error checking permissions:', permError);
        await interaction.reply({ content: '❌ Error checking permissions. Please try again.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        console.log('[Refresh PVC] Reply deferred successfully');
    } catch (deferError) {
        console.error('[Refresh PVC] Error deferring reply:', deferError);
        return;
    }

    const guild = interaction.guild;
    const pvcLogsChannel = interaction.options.getChannel('pvc_logs_channel');
    const teamLogsChannel = interaction.options.getChannel('team_logs_channel');
    const commandChannel = interaction.options.getChannel('command_channel');
    const teamCommandChannel = interaction.options.getChannel('team_command_channel');

    console.log(`[Refresh PVC] Options - pvcLogs: ${pvcLogsChannel?.id}, teamLogs: ${teamLogsChannel?.id}, cmdChannel: ${commandChannel?.id}, teamCmdChannel: ${teamCommandChannel?.id}`);

    let settings;
    let teamSettings;
    
    try {
        console.log('[Refresh PVC] Fetching guild settings from database...');
        settings = await withRetry(() => prisma.guildSettings.findUnique({
            where: { guildId: guild.id },
        }));
        console.log(`[Refresh PVC] Guild settings found: ${!!settings}, interfaceTextId: ${settings?.interfaceTextId}, interfaceVcId: ${settings?.interfaceVcId}`);
    } catch (dbError: any) {
        console.error('[Refresh PVC] Error fetching guild settings:', dbError);
        const isConnectionError = dbError?.message?.includes("Can't reach database") || dbError?.code === 'P1001';
        if (isConnectionError) {
            await interaction.editReply('❌ **Database Connection Error**\n\nCannot reach the database server. Please check:\n• Database server is running\n• Network connectivity\n• DATABASE_URL in .env is correct\n\nTry again in a few moments.');
        } else {
            await interaction.editReply('❌ Database error while fetching settings. Please try again.');
        }
        return;
    }

    try {
        console.log('[Refresh PVC] Fetching team settings from database...');
        teamSettings = await withRetry(() => prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
        }));
        console.log(`[Refresh PVC] Team settings found: ${!!teamSettings}, categoryId: ${teamSettings?.categoryId}`);
    } catch (dbError: any) {
        console.error('[Refresh PVC] Error fetching team settings:', dbError);
        const isConnectionError = dbError?.message?.includes("Can't reach database") || dbError?.code === 'P1001';
        if (isConnectionError) {
            await interaction.editReply('❌ **Database Connection Error**\n\nCannot reach the database server. Please check your database configuration.');
        } else {
            await interaction.editReply('❌ Database error while fetching team settings. Please try again.');
        }
        return;
    }

    if (!settings?.interfaceTextId && !teamSettings?.categoryId) {
        console.log('[Refresh PVC] Neither PVC nor Team system is set up');
        await interaction.editReply('Neither PVC nor Team system is set up. Use `/pvc_setup` or `/team_setup` first.');
        return;
    }

    console.log('[Refresh PVC] Setting up webhooks...');
    let pvcLogsWebhookUrl = settings?.logsWebhookUrl;
    if (pvcLogsChannel && pvcLogsChannel.type === ChannelType.GuildText) {
        try {
            console.log(`[Refresh PVC] Fetching webhooks for PVC logs channel: ${pvcLogsChannel.id}`);
            const webhooks = await (pvcLogsChannel as any).fetchWebhooks();
            const botWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id && w.name === 'PVC Logger');
            
            let webhook = botWebhooks.first();

            if (!webhook) {
                console.log('[Refresh PVC] No existing webhook found, creating new PVC webhook...');
                
                // Clean up old bot webhooks if we're at the limit
                const allBotWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id);
                if (webhooks.size >= 15 && allBotWebhooks.size > 0) {
                    console.log('[Refresh PVC] Webhook limit reached, cleaning up old bot webhooks...');
                    for (const oldWebhook of allBotWebhooks.values()) {
                        try {
                            await oldWebhook.delete('Cleaning up old webhooks');
                            console.log('[Refresh PVC] Deleted old webhook:', oldWebhook.name);
                        } catch {}
                    }
                }
                
                webhook = await (pvcLogsChannel as any).createWebhook({
                    name: 'PVC Logger',
                    reason: 'PVC Logs Refresh',
                });
            } else if (botWebhooks.size > 1) {
                // Clean up duplicates, keep the first one
                console.log(`[Refresh PVC] Found ${botWebhooks.size} duplicate webhooks, cleaning up...`);
                const duplicates = botWebhooks.filter((w: any) => w.id !== webhook.id);
                for (const dup of duplicates.values()) {
                    try {
                        await dup.delete('Removing duplicate webhook');
                        console.log('[Refresh PVC] Deleted duplicate webhook');
                    } catch {}
                }
            }
            pvcLogsWebhookUrl = webhook.url;
            console.log('[Refresh PVC] PVC webhook ready');
        } catch (error: any) {
            console.error('[Refresh PVC] Error setting up PVC webhook:', error?.message || error);
        }
    }

    let teamLogsWebhookUrl = teamSettings?.logsWebhookUrl;
    if (teamLogsChannel && teamLogsChannel.type === ChannelType.GuildText) {
        try {
            console.log(`[Refresh PVC] Fetching webhooks for Team logs channel: ${teamLogsChannel.id}`);
            const webhooks = await (teamLogsChannel as any).fetchWebhooks();
            const botWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id && w.name === 'Team VC Logger');
            
            let webhook = botWebhooks.first();

            if (!webhook) {
                console.log('[Refresh PVC] No existing webhook found, creating new Team webhook...');
                
                // Clean up old bot webhooks if we're at the limit
                const allBotWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id);
                if (webhooks.size >= 15 && allBotWebhooks.size > 0) {
                    console.log('[Refresh PVC] Webhook limit reached, cleaning up old bot webhooks...');
                    for (const oldWebhook of allBotWebhooks.values()) {
                        try {
                            await oldWebhook.delete('Cleaning up old webhooks');
                            console.log('[Refresh PVC] Deleted old webhook:', oldWebhook.name);
                        } catch {}
                    }
                }
                
                webhook = await (teamLogsChannel as any).createWebhook({
                    name: 'Team VC Logger',
                    reason: 'Team Logs Refresh',
                });
            } else if (botWebhooks.size > 1) {
                // Clean up duplicates
                console.log(`[Refresh PVC] Found ${botWebhooks.size} duplicate webhooks, cleaning up...`);
                const duplicates = botWebhooks.filter((w: any) => w.id !== webhook.id);
                for (const dup of duplicates.values()) {
                    try {
                        await dup.delete('Removing duplicate webhook');
                        console.log('[Refresh PVC] Deleted duplicate webhook');
                    } catch {}
                }
            }
            teamLogsWebhookUrl = webhook.url;
            console.log('[Refresh PVC] Team webhook ready');
        } catch (error: any) {
            console.error('[Refresh PVC] Error setting up Team webhook:', error?.message || error);
        }
    }

    try {
        console.log('[Refresh PVC] Updating database settings...');
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
            console.log('[Refresh PVC] Guild settings updated');
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
            console.log('[Refresh PVC] Team settings updated');
        }
    } catch (updateError) {
        console.error('[Refresh PVC] Error updating database settings:', updateError);
        await interaction.editReply('❌ Failed to update settings in database. Please try again.');
        return;
    }

    console.log('[Refresh PVC] Invalidating caches...');
    invalidateGuildSettings(guild.id);
    invalidateAllCaches();

    console.log('[Refresh PVC] Clearing guild state...');
    clearGuildState(guild.id);

    let freshSettings;
    let freshTeamSettings;
    
    try {
        console.log('[Refresh PVC] Fetching fresh settings from database...');
        freshSettings = await prisma.guildSettings.findUnique({
            where: { guildId: guild.id },
            include: { privateChannels: true },
        });

        freshTeamSettings = await prisma.teamVoiceSettings.findUnique({
            where: { guildId: guild.id },
            include: { teamChannels: true },
        });
        console.log(`[Refresh PVC] Fresh settings loaded - PVC channels: ${freshSettings?.privateChannels?.length || 0}, Team channels: ${freshTeamSettings?.teamChannels?.length || 0}`);
    } catch (fetchError) {
        console.error('[Refresh PVC] Error fetching fresh settings:', fetchError);
        await interaction.editReply('❌ Failed to reload settings from database. Please try again.');
        return;
    }

    console.log('[Refresh PVC] Registering interface channels...');
    if (freshSettings?.interfaceVcId) {
        const interfaceVc = guild.channels.cache.get(freshSettings.interfaceVcId);
        if (interfaceVc) {
            registerInterfaceChannel(guild.id, freshSettings.interfaceVcId);
            console.log(`[Refresh PVC] Registered PVC interface channel: ${freshSettings.interfaceVcId}`);
        } else {
            console.log(`[Refresh PVC] PVC interface VC not found in cache: ${freshSettings.interfaceVcId}`);
        }
    }

    let teamInterfacesRegistered = 0;
    if (freshTeamSettings) {
        console.log('[Refresh PVC] Registering team interface channels...');
        if (freshTeamSettings.duoVcId) {
            const duoVc = guild.channels.cache.get(freshTeamSettings.duoVcId);
            if (duoVc) {
                registerTeamInterfaceChannel(guild.id, 'duo', freshTeamSettings.duoVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh PVC] Registered duo interface: ${freshTeamSettings.duoVcId}`);
            } else {
                console.log(`[Refresh PVC] Duo interface VC not found in cache: ${freshTeamSettings.duoVcId}`);
            }
        }
        if (freshTeamSettings.trioVcId) {
            const trioVc = guild.channels.cache.get(freshTeamSettings.trioVcId);
            if (trioVc) {
                registerTeamInterfaceChannel(guild.id, 'trio', freshTeamSettings.trioVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh PVC] Registered trio interface: ${freshTeamSettings.trioVcId}`);
            } else {
                console.log(`[Refresh PVC] Trio interface VC not found in cache: ${freshTeamSettings.trioVcId}`);
            }
        }
        if (freshTeamSettings.squadVcId) {
            const squadVc = guild.channels.cache.get(freshTeamSettings.squadVcId);
            if (squadVc) {
                registerTeamInterfaceChannel(guild.id, 'squad', freshTeamSettings.squadVcId);
                teamInterfacesRegistered++;
                console.log(`[Refresh PVC] Registered squad interface: ${freshTeamSettings.squadVcId}`);
            } else {
                console.log(`[Refresh PVC] Squad interface VC not found in cache: ${freshTeamSettings.squadVcId}`);
            }
        }
    }

    console.log('[Refresh PVC] Validating and registering PVC channels...');
    if (freshSettings?.privateChannels) {
        const validPvcs = [];
        const invalidPvcIds: string[] = [];

        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel) {
                registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
                validPvcs.push(pvc);
            } else {
                invalidPvcIds.push(pvc.channelId);
                console.log(`[Refresh PVC] PVC channel not found in Discord: ${pvc.channelId}`);
            }
        }
        console.log(`[Refresh PVC] Registered ${validPvcs.length} PVC channels, ${invalidPvcIds.length} invalid`);

        if (invalidPvcIds.length > 0) {
            try {
                await prisma.privateVoiceChannel.deleteMany({
                    where: { channelId: { in: invalidPvcIds } },
                });
                console.log(`[Refresh PVC] Deleted ${invalidPvcIds.length} invalid PVC records from database`);
            } catch (deleteError) {
                console.error('[Refresh PVC] Error deleting invalid PVC records:', deleteError);
            }
        }
    }

    console.log('[Refresh PVC] Validating and registering Team channels...');
    if (freshTeamSettings?.teamChannels) {
        const invalidTeamIds: string[] = [];
        let validTeamCount = 0;

        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel) {
                registerTeamChannel(tc.channelId, tc.guildId, tc.ownerId, tc.teamType.toLowerCase() as 'duo' | 'trio' | 'squad');
                validTeamCount++;
            } else {
                invalidTeamIds.push(tc.channelId);
                console.log(`[Refresh PVC] Team channel not found in Discord: ${tc.channelId}`);
            }
        }
        console.log(`[Refresh PVC] Registered ${validTeamCount} Team channels, ${invalidTeamIds.length} invalid`);

        if (invalidTeamIds.length > 0) {
            try {
                await prisma.teamVoiceChannel.deleteMany({
                    where: { channelId: { in: invalidTeamIds } },
                });
                console.log(`[Refresh PVC] Deleted ${invalidTeamIds.length} invalid Team records from database`);
            } catch (deleteError) {
                console.error('[Refresh PVC] Error deleting invalid Team records:', deleteError);
            }
        }
    }

    let ownershipTransfers = 0;
    let channelsDeleted = 0;

    console.log('[Refresh PVC] Processing PVC ownership and empty channels...');
    if (freshSettings?.privateChannels) {
        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(pvc.ownerId);

                if (!ownerInChannel) {
                    console.log(`[Refresh PVC] Owner ${pvc.ownerId} not in channel ${pvc.channelId}`);

                    if (channel.members.size === 0) {
                        console.log(`[Refresh PVC] Channel ${pvc.channelId} is empty, deleting...`);
                        try {
                            await channel.delete('Refresh: Empty channel cleanup');
                            await prisma.privateVoiceChannel.delete({ where: { channelId: pvc.channelId } });
                            channelsDeleted++;
                            console.log(`[Refresh PVC] Deleted empty channel ${pvc.channelId}`);
                        } catch (deleteErr) {
                            console.error(`[Refresh PVC] Error deleting empty channel ${pvc.channelId}:`, deleteErr);
                        }
                    } else {
                        console.log(`[Refresh PVC] Channel ${pvc.channelId} has ${channel.members.size} members, transferring ownership...`);
                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {
                            console.log(`[Refresh PVC] Transferring ownership to ${nextOwner.id}`);
                            try {
                                transferOwnership(pvc.channelId, nextOwner.id);

                                await prisma.privateVoiceChannel.update({
                                    where: { channelId: pvc.channelId },
                                    data: { ownerId: nextOwner.id },
                                });

                                const { recordBotEdit } = await import('../events/channelUpdate');
                                recordBotEdit(pvc.channelId);

                                await channel.permissionOverwrites.edit(nextOwner.id, {
                                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                                });

                                await channel.setName(nextOwner.displayName);

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
                                } catch (sendErr) {
                                    console.error(`[Refresh PVC] Error sending transfer message:`, sendErr);
                                }

                                await logAction({
                                    action: LogAction.CHANNEL_TRANSFERRED,
                                    guild: guild,
                                    user: nextOwner.user,
                                    channelName: channel.name,
                                    channelId: pvc.channelId,
                                    details: `Ownership transferred during refresh (previous owner not present)`,
                                });

                                ownershipTransfers++;
                                console.log(`[Refresh PVC] Successfully transferred ownership of ${pvc.channelId}`);
                            } catch (transferErr) {
                                console.error(`[Refresh PVC] Error transferring ownership of ${pvc.channelId}:`, transferErr);
                            }
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

    console.log('[Refresh PVC] Processing Team channel ownership and empty channels...');
    if (freshTeamSettings?.teamChannels) {
        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                const ownerInChannel = channel.members.has(tc.ownerId);

                if (!ownerInChannel) {
                    console.log(`[Refresh PVC] Team owner ${tc.ownerId} not in channel ${tc.channelId}`);

                    if (channel.members.size === 0) {
                        console.log(`[Refresh PVC] Team channel ${tc.channelId} is empty, deleting...`);
                        try {
                            await channel.delete('Refresh: Empty team channel cleanup');
                            await prisma.teamVoiceChannel.delete({ where: { channelId: tc.channelId } });
                            channelsDeleted++;
                            console.log(`[Refresh PVC] Deleted empty team channel ${tc.channelId}`);
                        } catch (deleteErr) {
                            console.error(`[Refresh PVC] Error deleting empty team channel ${tc.channelId}:`, deleteErr);
                        }
                    } else {
                        console.log(`[Refresh PVC] Team channel ${tc.channelId} has ${channel.members.size} members, transferring ownership...`);
                        const nextOwner = channel.members.find(m => !m.user.bot);
                        if (nextOwner) {
                            console.log(`[Refresh PVC] Transferring team ownership to ${nextOwner.id}`);
                            try {
                                transferTeamOwnership(tc.channelId, nextOwner.id);

                                await prisma.teamVoiceChannel.update({
                                    where: { channelId: tc.channelId },
                                    data: { ownerId: nextOwner.id },
                                });

                                const { recordBotEdit } = await import('../events/channelUpdate');
                                recordBotEdit(tc.channelId);

                                await channel.permissionOverwrites.edit(nextOwner.id, {
                                    ViewChannel: true, Connect: true, Speak: true, Stream: true,
                                    SendMessages: true, EmbedLinks: true, AttachFiles: true,
                                    MuteMembers: true, DeafenMembers: true, ManageChannels: true,
                                });

                                const teamTypeName = tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase();
                                await channel.setName(`${nextOwner.displayName}'s ${teamTypeName}`);

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
                                } catch (sendErr) {
                                    console.error(`[Refresh PVC] Error sending team transfer message:`, sendErr);
                                }

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
                                console.log(`[Refresh PVC] Successfully transferred team ownership of ${tc.channelId}`);
                            } catch (transferErr) {
                                console.error(`[Refresh PVC] Error transferring team ownership of ${tc.channelId}:`, transferErr);
                            }
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

    console.log('[Refresh PVC] Fetching updated channel lists...');
    let updatedPvcs;
    let updatedTeamChannels;
    
    try {
        updatedPvcs = await prisma.privateVoiceChannel.findMany({
            where: { guildId: guild.id },
        });
        updatedTeamChannels = await prisma.teamVoiceChannel.findMany({
            where: { guildId: guild.id },
        });
        console.log(`[Refresh PVC] Found ${updatedPvcs.length} PVCs and ${updatedTeamChannels.length} Team channels for permission sync`);
    } catch (fetchErr) {
        console.error('[Refresh PVC] Error fetching updated channel lists:', fetchErr);
        await interaction.editReply('❌ Failed to fetch channel list for permission sync. Please try again.');
        return;
    }

    let permsSynced = 0;
    let teamPermsSynced = 0;

    console.log('[Refresh PVC] Syncing PVC permissions...');
    for (const pvc of updatedPvcs) {
        const channel = guild.channels.cache.get(pvc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const permanentPerms = await getPermanentPermissionsAndCache(guild.id, pvc.ownerId);
                const permanentUserIds = new Set(permanentPerms.map(p => p.targetId));

                const currentMemberIds = channel.members
                    .filter(m => m.id !== pvc.ownerId && !m.user.bot)
                    .map(m => m.id);

                const allAllowedIds = new Set([...permanentUserIds, ...currentMemberIds]);

                await prisma.voicePermission.deleteMany({
                    where: { channelId: pvc.channelId, permission: 'permit' },
                });

                invalidateChannelPermissions(pvc.channelId);

                if (allAllowedIds.size > 0) {
                    await prisma.voicePermission.createMany({
                        data: Array.from(allAllowedIds).map(userId => ({
                            channelId: pvc.channelId,
                            targetId: userId,
                            targetType: 'user',
                            permission: 'permit',
                        })),
                        skipDuplicates: true,
                    });
                    permsSynced += allAllowedIds.size;
                }

                const { recordBotEdit } = await import('../events/channelUpdate');
                recordBotEdit(pvc.channelId);

                await channel.permissionOverwrites.edit(pvc.ownerId, {
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

                const existingOverwrites = channel.permissionOverwrites.cache;
                for (const [targetId, overwrite] of existingOverwrites) {
                    const member = guild.members.cache.get(targetId);
                    const isBot = member?.user.bot ?? false;

                    if (targetId === pvc.ownerId || allAllowedIds.has(targetId) || isBot || targetId === guild.id) {
                        continue;
                    }

                    if (overwrite.type === OverwriteType.Role) {
                        continue;
                    }

                    if (overwrite.type === OverwriteType.Member && !allAllowedIds.has(targetId)) {
                        await channel.permissionOverwrites.delete(targetId).catch(() => { });
                    }
                }
            } catch (permErr) {
                console.error(`[Refresh PVC] Error syncing permissions for PVC ${pvc.channelId}:`, permErr);
            }
        }
    }
    console.log(`[Refresh PVC] PVC permissions synced: ${permsSynced} users`);

    console.log('[Refresh PVC] Syncing Team permissions...');
    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                const permanentPerms = await getPermanentPermissionsAndCache(guild.id, tc.ownerId);
                const permanentUserIds = new Set(permanentPerms.map(p => p.targetId));

                const currentMemberIds = channel.members
                    .filter(m => m.id !== tc.ownerId && !m.user.bot)
                    .map(m => m.id);

                const allAllowedIds = new Set([...permanentUserIds, ...currentMemberIds]);

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
                    });
                    teamPermsSynced += allAllowedIds.size;
                }

                const { recordBotEdit } = await import('../events/channelUpdate');
                recordBotEdit(tc.channelId);

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

                const existingOverwrites = channel.permissionOverwrites.cache;
                for (const [targetId, overwrite] of existingOverwrites) {
                    const member = guild.members.cache.get(targetId);
                    const isBot = member?.user.bot ?? false;

                    if (targetId === tc.ownerId || allAllowedIds.has(targetId) || isBot || targetId === guild.id) {
                        continue;
                    }

                    if (overwrite.type === OverwriteType.Member) {
                        await channel.permissionOverwrites.delete(targetId).catch(() => { });
                    }
                }
            } catch (permErr) {
                console.error(`[Refresh PVC] Error syncing permissions for Team ${tc.channelId}:`, permErr);
            }
        }
    }
    console.log(`[Refresh PVC] Team permissions synced: ${teamPermsSynced} users`);

    let interfacesUpdated = 0;
    let interfacesSkipped = 0;
    let interfaceErrors: string[] = [];

    console.log('[Refresh PVC] Updating PVC interfaces...');
    for (const pvc of updatedPvcs) {
        const channel = guild.channels.cache.get(pvc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                console.log(`[Refresh PVC] Fetching messages from PVC: ${channel.name} (${pvc.channelId})`);
                const messages = await channel.messages.fetch({ limit: 20 });

                const interfaceMsg = messages.find(m =>
                    m.author.id === interaction.client.user?.id &&
                    (m.embeds.length > 0 || m.components.length > 0)
                );

                if (interfaceMsg) {
                    console.log(`[Refresh PVC] Updating existing interface in ${pvc.channelId}`);
                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, pvc.ownerId, 'interface.png');
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;
                    console.log(`[Refresh PVC] Interface updated for ${pvc.channelId}`);
                } else {
                    console.log(`[Refresh PVC] No interface found, creating new one in ${pvc.channelId}`);
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
                        console.log(`[Refresh PVC] New interface created for ${pvc.channelId}`);
                    } catch (sendErr) {
                        console.error(`[Refresh PVC] Error sending interface to ${pvc.channelId}:`, sendErr);
                        interfacesSkipped++;
                    }
                }
            } catch (err) {
                console.error(`[Refresh PVC] Error processing interface for PVC ${channel.name}:`, err);
                interfaceErrors.push(`PVC ${channel.name}: ${err}`);
                interfacesSkipped++;
            }
        }
    }

    console.log('[Refresh PVC] Updating Team interfaces...');
    for (const tc of updatedTeamChannels) {
        const channel = guild.channels.cache.get(tc.channelId);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                console.log(`[Refresh PVC] Fetching messages from Team: ${channel.name} (${tc.channelId})`);
                const messages = await channel.messages.fetch({ limit: 20 });

                const interfaceMsg = messages.find(m =>
                    m.author.id === interaction.client.user?.id &&
                    (m.embeds.length > 0 || m.components.length > 0)
                );

                if (interfaceMsg) {
                    console.log(`[Refresh PVC] Updating existing team interface in ${tc.channelId}`);
                    const imageBuffer = await generateInterfaceImage();
                    const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                    const embed = generateVcInterfaceEmbed(guild, tc.ownerId, 'interface.png');
                    embed.setTitle(`🎮 ${tc.teamType.charAt(0) + tc.teamType.slice(1).toLowerCase()} Controls`);
                    const components = createInterfaceComponents();
                    await interfaceMsg.edit({ embeds: [embed], files: [attachment], components });
                    interfacesUpdated++;
                    console.log(`[Refresh PVC] Team interface updated for ${tc.channelId}`);
                } else {
                    console.log(`[Refresh PVC] No team interface found, creating new one in ${tc.channelId}`);
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
                        console.log(`[Refresh PVC] New team interface created for ${tc.channelId}`);

                    } catch (sendErr) {
                        console.error(`[Refresh PVC] Error sending team interface to ${tc.channelId}:`, sendErr);
                        interfacesSkipped++;
                    }
                }
            } catch (err) {
                console.error(`[Refresh PVC] Error processing team interface for ${channel.name}:`, err);
                interfaceErrors.push(`Team ${channel.name}: ${err}`);
                interfacesSkipped++;
            }
        }
    }
    console.log(`[Refresh PVC] Total interfaces updated: ${interfacesUpdated}, skipped: ${interfacesSkipped}`);

    console.log('[Refresh PVC] Updating main interface channel...');
    const interfaceTextChannel = guild.channels.cache.get(freshSettings?.interfaceTextId || settings?.interfaceTextId || '');

    let mainInterfaceUpdated = false;

    if (interfaceTextChannel && interfaceTextChannel.type === ChannelType.GuildText) {
        try {
            let oldMessage: Message | null = null;

            try {
                console.log('[Refresh PVC] Fetching main interface messages...');
                const messages = await interfaceTextChannel.messages.fetch({ limit: 10 });
                const botMessage = messages.find(m => m.author.id === interaction.client.user?.id && m.embeds.length > 0);
                if (botMessage) {
                    oldMessage = botMessage;
                    console.log(`[Refresh PVC] Found existing main interface message: ${botMessage.id}`);
                } else {
                    console.log('[Refresh PVC] No existing main interface message found');
                }
            } catch (fetchErr) {
                console.error('[Refresh PVC] Error fetching main interface messages:', fetchErr);
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
                    console.log('[Refresh PVC] Editing existing main interface message...');
                    await oldMessage.edit({
                        embeds: [embed],
                        files: [attachment],
                        components,
                    });
                    mainInterfaceUpdated = true;
                    console.log('[Refresh PVC] Main interface message edited successfully');
                } catch (editErr) {
                    console.error('[Refresh PVC] Error editing main interface, creating new one:', editErr);
                    try {
                        await interfaceTextChannel.send({
                            embeds: [embed],
                            files: [attachment],
                            components,
                        });
                        mainInterfaceUpdated = true;
                        console.log('[Refresh PVC] New main interface message sent successfully');
                    } catch (sendErr) {
                        console.error('[Refresh PVC] Error sending new main interface:', sendErr);
                    }
                }
            } else {
                try {
                    console.log('[Refresh PVC] Sending new main interface message...');
                    await interfaceTextChannel.send({
                        embeds: [embed],
                        files: [attachment],
                        components,
                    });
                    mainInterfaceUpdated = true;
                    console.log('[Refresh PVC] New main interface message sent successfully');
                } catch (sendErr) {
                    console.error('[Refresh PVC] Error sending main interface:', sendErr);
                }
            }
        } catch (mainErr) {
            console.error('[Refresh PVC] Error in main interface update:', mainErr);
        }
    } else {
        console.log(`[Refresh PVC] Main interface text channel not found: ${freshSettings?.interfaceTextId || settings?.interfaceTextId || 'none'}`);
    }

    console.log('[Refresh PVC] Logging action...');
    logAction({
        action: LogAction.PVC_REFRESHED,
        guild: guild,
        user: interaction.user,
        details: `System refreshed - Ownership transfers: ${ownershipTransfers}, Deleted: ${channelsDeleted}${pvcLogsChannel ? `, PVC logs: ${pvcLogsChannel}` : ''}${teamLogsChannel ? `, Team logs: ${teamLogsChannel}` : ''}${commandChannel ? `, PVC commands: ${commandChannel}` : ''}${teamCommandChannel ? `, Team commands: ${teamCommandChannel}` : ''}`,
    }).catch((logErr) => {
        console.error('[Refresh PVC] Error logging action:', logErr);
    });

    console.log('[Refresh PVC] Building response...');
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

    console.log('[Refresh PVC] Sending response to user...');
    try {
        await interaction.editReply(response);
        console.log('[Refresh PVC] Command completed successfully!');
    } catch (replyErr) {
        console.error('[Refresh PVC] Error sending final response:', replyErr);
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

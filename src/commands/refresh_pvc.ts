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
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';
import { invalidateGuildSettings, clearAllCaches as invalidateAllCaches, invalidateChannelPermissions } from '../utils/cache';
import { clearGuildState, registerInterfaceChannel, registerChannel, registerTeamChannel } from '../utils/voiceManager';

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
            .setName('logs_channel')
            .setDescription('Update logs channel (optional)')
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
        option
            .setName('command_channel')
            .setDescription('Update command channel (optional)')
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
    const logsChannel = interaction.options.getChannel('logs_channel');
    const commandChannel = interaction.options.getChannel('command_channel');

    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
    });

    if (!settings?.interfaceTextId) {
        await interaction.editReply('PVC system is not set up. Use `/pvc_setup` first.');
        return;
    }

    let logsWebhookUrl = settings.logsWebhookUrl;
    if (logsChannel && logsChannel.type === ChannelType.GuildText) {
        try {
            // Try to find existing webhook first
            const webhooks = await (logsChannel as any).fetchWebhooks();
            let webhook = webhooks.find((w: any) => w.owner?.id === interaction.client.user?.id);

            if (!webhook) {
                // Create new webhook only if none exists
                webhook = await (logsChannel as any).createWebhook({
                    name: 'PVC Logger',
                    reason: 'PVC Logs Refresh',
                });
            }
            logsWebhookUrl = webhook.url;
        } catch (error: any) {
            // Non-fatal - continue without webhook
            console.error('Webhook error:', error?.message || error);
        }
    }

    await prisma.guildSettings.update({
        where: { guildId: guild.id },
        data: {
            ...(logsWebhookUrl && logsWebhookUrl !== settings.logsWebhookUrl && {
                logsWebhookUrl,
                logsChannelId: logsChannel?.id
            }),
            ...(commandChannel && { commandChannelId: commandChannel.id }),
        },
    });

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

    // PERMISSION SYNC: Update permissions to match current VC members
    let permsSynced = 0;
    let teamPermsSynced = 0;
    if (freshSettings?.privateChannels) {
        for (const pvc of freshSettings.privateChannels) {
            const channel = guild.channels.cache.get(pvc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                // Get current members in the VC (excluding the owner)
                const currentMemberIds = channel.members
                    .filter(m => m.id !== pvc.ownerId)
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
                        MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
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
    }

    // TEAM CHANNEL PERMISSION SYNC
    if (freshTeamSettings?.teamChannels) {
        for (const tc of freshTeamSettings.teamChannels) {
            const channel = guild.channels.cache.get(tc.channelId);
            if (channel && channel.type === ChannelType.GuildVoice) {
                // Get current members in the VC (excluding the owner)
                const currentMemberIds = channel.members
                    .filter(m => m.id !== tc.ownerId)
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
                        MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
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
    }

    const interfaceTextChannel = guild.channels.cache.get(freshSettings?.interfaceTextId || settings.interfaceTextId);
    if (!interfaceTextChannel || interfaceTextChannel.type !== ChannelType.GuildText) {
        await interaction.editReply('Interface text channel not found. Run `/pvc_setup` again.');
        return;
    }

    let oldMessage: Message | null = null;

    try {
        const messages = await interfaceTextChannel.messages.fetch({ limit: 10 });
        const botMessage = messages.find(m => m.author.id === interaction.client.user?.id && m.embeds.length > 0);

        if (botMessage) {
            oldMessage = botMessage;
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
            await oldMessage.edit({
                embeds: [embed],
                files: [attachment],
                components,
            });
        } else {
            await interfaceTextChannel.send({
                embeds: [embed],
                files: [attachment],
                components,
            });
        }


        await logAction({
            action: LogAction.PVC_REFRESHED,
            guild: guild,
            user: interaction.user,
            details: `PVC setup refreshed${logsChannel ? `, logs: ${logsChannel}` : ''}${commandChannel ? `, commands: ${commandChannel}` : ''}`,
        });

        let response = '✅ **PVC & Team System Refreshed**\n\n';
        response += '**State Reloaded:**\n';
        response += '• Interface & buttons refreshed\n';
        response += '• In-memory state resynced from DB\n';
        response += `• PVC permissions synced (${permsSynced} users)\n`;
        response += `• Team permissions synced (${teamPermsSynced} users)\n`;
        if (logsChannel) response += `• Logs: ${logsChannel}\n`;
        if (commandChannel) response += `• Commands: ${commandChannel}\n`;
        response += '\n> Only current VC members retain access. All stale permissions cleared.';

        await interaction.editReply(response);

    } catch {
        await interaction.editReply('Failed to refresh PVC interface. No changes were made.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

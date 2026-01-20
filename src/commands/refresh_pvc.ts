import {
    SlashCommandBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    type Message,
    AttachmentBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';
import { invalidateGuildSettings, clearAllCaches as invalidateAllCaches } from '../utils/cache';
import { clearGuildState, registerInterfaceChannel, registerChannel } from '../utils/voiceManager';

const MAIN_BUTTONS = [
    { id: 'pvc_lock' },
    { id: 'pvc_unlock' },
    { id: 'pvc_privacy' },
    { id: 'pvc_add_user' },
    { id: 'pvc_remove_user' },
    { id: 'pvc_invite' },
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
    .setDescription('Refresh the entire PVC setup (interface, logs webhook, command channel)')
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
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

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
            const webhook = await (logsChannel as any).createWebhook({
                name: 'PVC Logger',
                reason: 'PVC Logs Refresh',
            });
            logsWebhookUrl = webhook.url;
        } catch {
            await interaction.editReply('Failed to create logs webhook. Check bot permissions.');
            return;
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

        let response = '✅ PVC System refreshed successfully!\n\n';
        response += '**Updated:**\n';
        response += '- Interface message and buttons\n';
        if (logsChannel) response += `- Logs channel: ${logsChannel}\n`;
        if (commandChannel) response += `- Command channel: ${commandChannel}\n`;

        await interaction.editReply(response);

    } catch {
        await interaction.editReply('Failed to refresh PVC interface. No changes were made.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

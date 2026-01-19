import {
    SlashCommandBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
    AttachmentBuilder,
    type ChatInputCommandInteraction,
    type Message,
} from 'discord.js';
import prisma from '../utils/database';
import type { Command } from '../client';
import { generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { canRunAdminCommand } from '../utils/permissions';

const MAIN_BUTTONS = [
    { id: 'pvc_lock' },
    { id: 'pvc_unlock' },
    { id: 'pvc_hide' },
    { id: 'pvc_unhide' },
    { id: 'pvc_add_user' },
    { id: 'pvc_claim' },
    { id: 'pvc_settings' },
    { id: 'pvc_delete' },
] as const;

const data = new SlashCommandBuilder()
    .setName('refresh_pvc')
    .setDescription('Refresh the PVC interface with latest buttons, embeds, and image')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    // Check admin permissions
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;

    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
    });

    if (!settings?.interfaceTextId) {
        await interaction.editReply('PVC system is not set up. Use `/pvc_setup` first.');
        return;
    }

    const interfaceTextChannel = guild.channels.cache.get(settings.interfaceTextId);
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

        MAIN_BUTTONS.forEach((btn, index) => {
            const emojiData = BUTTON_EMOJI_MAP[btn.id];
            const button = new ButtonBuilder()
                .setCustomId(btn.id)
                .setStyle(ButtonStyle.Secondary);

            if (emojiData) {
                button.setEmoji({ id: emojiData.id, name: emojiData.name });
            }

            if (index < 3) {
                row1.addComponents(button);
            } else if (index < 6) {
                row2.addComponents(button);
            } else {
                row3.addComponents(button);
            }
        });

        const imageBuffer = await generateInterfaceImage(guild);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });

        const embed = new EmbedBuilder()
            .setImage('attachment://interface.png');

        const components = [row1];
        if (row2.components.length > 0) {
            components.push(row2);
        }
        if (row3.components.length > 0) {
            components.push(row3);
        }

        if (oldMessage) {
            await oldMessage.edit({
                embeds: [embed],
                files: [attachment],
                components,
            });
            await interaction.editReply('PVC interface refreshed successfully! Updated embed, buttons, and image.');
        } else {
            await interfaceTextChannel.send({
                embeds: [embed],
                files: [attachment],
                components,
            });
            await interaction.editReply('PVC interface message not found, created a new one.');
        }

    } catch (err) {
        console.error('[RefreshPVC] Failed to refresh interface:', err);
        await interaction.editReply('Failed to refresh PVC interface. No changes were made.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

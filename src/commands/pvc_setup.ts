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
} from 'discord.js';
import prisma from '../utils/database';
import { registerInterfaceChannel } from '../utils/voiceManager';
import type { Command } from '../client';
import { generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { invalidateGuildSettings } from '../utils/cache';
import { canRunAdminCommand } from '../utils/permissions';

// Main interface buttons (3x3 layout)
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
    .setName('pvc_setup')
    .setDescription('Set up the Private Voice Channel system')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('category')
            .setDescription('The category where PVC channels will be created')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
    );

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

    const category = interaction.options.getChannel('category', true);

    if (category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ content: 'Please select a valid category channel.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const guild = interaction.guild;

        // 1. Create the interface TEXT channel for the control panel
        const interfaceTextChannel = await guild.channels.create({
            name: 'interface',
            type: ChannelType.GuildText,
            parent: category.id,
        });

        // 2. Create the "Join to Create" voice channel
        const joinToCreateVc = await guild.channels.create({
            name: 'Join to Create',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        // 3. Create button rows (3x3 layout)
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

        // 4. Generate dynamic interface image with canvas
        const imageBuffer = await generateInterfaceImage(guild);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });

        const embed = new EmbedBuilder()
            .setImage('attachment://interface.png');

        // 5. Send the control panel message in the interface text channel
        const components = [row1];
        if (row2.components.length > 0) {
            components.push(row2);
        }
        if (row3.components.length > 0) {
            components.push(row3);
        }

        await interfaceTextChannel.send({
            embeds: [embed],
            files: [attachment],
            components,
        });

        // 6. Save to database
        await prisma.guildSettings.upsert({
            where: { guildId: guild.id },
            update: {
                interfaceVcId: joinToCreateVc.id,
                interfaceTextId: interfaceTextChannel.id,
            },
            create: {
                guildId: guild.id,
                interfaceVcId: joinToCreateVc.id,
                interfaceTextId: interfaceTextChannel.id,
            },
        });

        invalidateGuildSettings(guild.id);

        // 7. Register in memory
        registerInterfaceChannel(guild.id, joinToCreateVc.id);

        await interaction.editReply(
            `PVC System set up successfully!\n` +
            `Category: ${category.name}\n` +
            `Control Panel: ${interfaceTextChannel}\n` +
            `Join to Create VC: ${joinToCreateVc}`
        );
    } catch {
        await interaction.editReply('Failed to set up PVC system. Check bot permissions.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

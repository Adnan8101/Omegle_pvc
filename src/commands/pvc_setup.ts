import {
    SlashCommandBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    AttachmentBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import { registerInterfaceChannel } from '../utils/voiceManager';
import type { Command } from '../client';
import { generateInterfaceEmbed, generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { invalidateGuildSettings } from '../utils/cache';
import { canRunAdminCommand } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';

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
    )
    .addChannelOption(option =>
        option
            .setName('logs_channel')
            .setDescription('The channel where all PVC actions will be logged')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption(option =>
        option
            .setName('command_channel')
            .setDescription('The channel where prefix commands (!au, !ru, !l) and approvals work')
            .setRequired(true)
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

    const category = interaction.options.getChannel('category', true);
    const logsChannel = interaction.options.getChannel('logs_channel', true);
    const commandChannel = interaction.options.getChannel('command_channel', true);

    if (category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ content: 'Please select a valid category channel.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    if (logsChannel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Logs channel must be a text channel.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    if (commandChannel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Command channel must be a text channel.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    console.log('[PVC Setup] Starting PVC setup process...');
    console.log('[PVC Setup] Guild:', interaction.guild.name, '(' + interaction.guild.id + ')');
    console.log('[PVC Setup] Category:', category.name, '(' + category.id + ')');
    console.log('[PVC Setup] Logs Channel:', logsChannel.name, '(' + logsChannel.id + ')');
    console.log('[PVC Setup] Command Channel:', commandChannel.name, '(' + commandChannel.id + ')');

    try {
        const guild = interaction.guild;

        console.log('[PVC Setup] Creating interface text channel...');
        const interfaceTextChannel = await guild.channels.create({
            name: 'interface',
            type: ChannelType.GuildText,
            parent: category.id,
        });

        console.log('[PVC Setup] Interface text channel created:', interfaceTextChannel.id);
        
        console.log('[PVC Setup] Creating Join to Create voice channel...');
        const joinToCreateVc = await guild.channels.create({
            name: 'Join to Create',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });
        console.log('[PVC Setup] Join to Create VC created:', joinToCreateVc.id);

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

        await interfaceTextChannel.send({
            embeds: [embed],
            files: [attachment],
            components,
        });

        console.log('[PVC Setup] Creating logs webhook...');
        const logsWebhook = await (logsChannel as any).createWebhook({
            name: 'PVC Logger',
            reason: 'For logging PVC actions',
        });
        console.log('[PVC Setup] Webhook created successfully');

        console.log('[PVC Setup] Saving guild settings to database...');
        console.log('[PVC Setup] Guild ID:', guild.id);
        console.log('[PVC Setup] Interface VC ID:', joinToCreateVc.id);
        console.log('[PVC Setup] Interface Text ID:', interfaceTextChannel.id);
        
        await prisma.guildSettings.upsert({
            where: { guildId: guild.id },
            update: {
                interfaceVcId: joinToCreateVc.id,
                interfaceTextId: interfaceTextChannel.id,
                logsChannelId: logsChannel.id,
                logsWebhookUrl: logsWebhook.url,
                commandChannelId: commandChannel.id,
            },
            create: {
                guildId: guild.id,
                interfaceVcId: joinToCreateVc.id,
                interfaceTextId: interfaceTextChannel.id,
                logsChannelId: logsChannel.id,
                logsWebhookUrl: logsWebhook.url,
                commandChannelId: commandChannel.id,
            },
        });
        console.log('[PVC Setup] ✅ Guild settings saved to database successfully!');

        invalidateGuildSettings(guild.id);

        registerInterfaceChannel(guild.id, joinToCreateVc.id);

        await logAction({
            action: LogAction.PVC_SETUP,
            guild: guild,
            user: interaction.user,
            details: `PVC System set up with category: ${category.name}, logs: ${logsChannel}, commands: ${commandChannel}`,
        });

        console.log('[PVC Setup] Setup complete! Sending success message...');
        await interaction.editReply(
            `✅ PVC System set up successfully!\n\n` +
            `**Category:** ${category.name}\n` +
            `**Control Panel:** ${interfaceTextChannel}\n` +
            `**Join to Create VC:** ${joinToCreateVc}\n` +
            `**Logs Channel:** ${logsChannel}\n` +
            `**Command Channel:** ${commandChannel}\n\n` +
            `All actions will now be logged to ${logsChannel}`
        );
    } catch (error: any) {
        console.error('[PVC Setup] ❌ Setup failed with error:', error);
        console.error('[PVC Setup] Error name:', error.name);
        console.error('[PVC Setup] Error message:', error.message);
        console.error('[PVC Setup] Error stack:', error.stack);
        await interaction.editReply(`Failed to set up PVC system.\n\n**Error:** ${error.message}\n\nCheck bot permissions and database connection.`);
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

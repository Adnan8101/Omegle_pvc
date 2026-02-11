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
import { validateServerCommand, validateAdminCommand, validateChannelType } from '../utils/commandValidation';
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
    if (!await validateServerCommand(interaction)) return;
    if (!await validateAdminCommand(interaction)) return;
    const category = interaction.options.getChannel('category', true);
    const logsChannel = interaction.options.getChannel('logs_channel', true);
    const commandChannel = interaction.options.getChannel('command_channel', true);
    if (!await validateChannelType(interaction, category, ChannelType.GuildCategory, 'Please select a valid category channel.')) return;
    if (!await validateChannelType(interaction, logsChannel, ChannelType.GuildText, 'Logs channel must be a text channel.')) return;
    if (!await validateChannelType(interaction, commandChannel, ChannelType.GuildText, 'Command channel must be a text channel.')) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const guild = interaction.guild;
    if (!guild) {
        await interaction.editReply({ content: 'This command can only be used in a server.' });
        return;
    }
    console.log('[PVC Setup] Starting PVC setup process...');
    console.log('[PVC Setup] Guild:', guild.name, '(' + guild.id + ')');
    console.log('[PVC Setup] Category:', category.name, '(' + category.id + ')');
    console.log('[PVC Setup] Logs Channel:', logsChannel.name, '(' + logsChannel.id + ')');
    console.log('[PVC Setup] Command Channel:', commandChannel.name, '(' + commandChannel.id + ')');
    try {
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
        console.log('[PVC Setup] Setting up logs webhook...');
        let logsWebhook;
        try {
            const webhooks = await (logsChannel as any).fetchWebhooks();
            logsWebhook = webhooks.find((w: any) => w.owner?.id === interaction.client.user?.id && w.name === interaction.client.user?.username);
            if (logsWebhook) {
                console.log('[PVC Setup] Reusing existing webhook:', logsWebhook.id);
            } else {
                console.log('[PVC Setup] No existing webhook found, creating new one...');
                const botWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id);
                if (webhooks.size >= 15 && botWebhooks.size > 0) {
                    console.log('[PVC Setup] Webhook limit reached, cleaning up old bot webhooks...');
                    for (const oldWebhook of botWebhooks.values()) {
                        try {
                            await oldWebhook.delete('Cleaning up old webhooks');
                            console.log('[PVC Setup] Deleted old webhook:', oldWebhook.name);
                        } catch (deleteErr) {
                            console.error('[PVC Setup] Failed to delete old webhook:', deleteErr);
                        }
                    }
                }
                const botAvatar = interaction.client.user?.displayAvatarURL();
                logsWebhook = await (logsChannel as any).createWebhook({
                    name: interaction.client.user?.username || 'PVC Logger',
                    avatar: botAvatar,
                    reason: 'For logging PVC actions',
                });
                console.log('[PVC Setup] Webhook created successfully');
            }
        } catch (webhookError: any) {
            console.error('[PVC Setup] Webhook error:', webhookError.message);
            throw new Error(`Failed to setup webhook: ${webhookError.message}`);
        }
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

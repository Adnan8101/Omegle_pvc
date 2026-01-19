import { type ModalSubmitInteraction, ChannelType, EmbedBuilder, TextChannel, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getChannelByOwner } from '../../utils/voiceManager';
import { safeSetChannelName, safeSetUserLimit, safeSetBitrate, validateVoiceChannel } from '../../utils/discordApi';
import prisma from '../../utils/database';

// Store pending rename requests
export const pendingRenames = new Map<string, {
    userId: string;
    channelId: string;
    newName: string;
    guildId: string;
}>();

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const { customId, guild } = interaction;
    if (!guild) return;

    // Handle rejection reason modal
    if (customId.startsWith('pvc_reject_reason_')) {
        await handleRejectReasonModal(interaction);
        return;
    }

    const userId = interaction.user.id;
    const ownedChannelId = getChannelByOwner(guild.id, userId);

    if (!ownedChannelId) {
        await interaction.reply({ content: 'You do not own a private voice channel.', flags: MessageFlags.Ephemeral });
        return;
    }

    // Validate channel exists using safe API
    const channel = await validateVoiceChannel(guild, ownedChannelId);
    if (!channel) {
        await interaction.reply({ content: 'Your voice channel could not be found.', flags: MessageFlags.Ephemeral });
        return;
    }

    switch (customId) {
        case 'pvc_limit_modal':
            await handleLimitModal(interaction, ownedChannelId);
            break;
        case 'pvc_rename_modal':
            await handleRenameModal(interaction, ownedChannelId);
            break;
        case 'pvc_bitrate_modal':
            await handleBitrateModal(interaction, ownedChannelId);
            break;
        default:
            await interaction.reply({ content: 'Unknown modal.', flags: MessageFlags.Ephemeral });
    }
}

async function handleRejectReasonModal(interaction: ModalSubmitInteraction): Promise<void> {
    const messageId = interaction.customId.replace('pvc_reject_reason_', '');
    const reason = interaction.fields.getTextInputValue('reject_reason');
    const staffUser = interaction.user;

    const pendingRename = pendingRenames.get(messageId);
    if (!pendingRename) {
        await interaction.reply({ content: 'This rename request has expired or was already processed.', flags: MessageFlags.Ephemeral });
        return;
    }

    pendingRenames.delete(messageId);

    const rejectedEmbed = new EmbedBuilder()
        .setTitle('Rename Rejected')
        .setDescription(`<@${pendingRename.userId}>'s rename request to **"${pendingRename.newName}"** was rejected.\n\n**Reason:** ${reason}`)
        .setColor(0xFF0000)
        .setFooter({ text: `Rejected by ${staffUser.username}` })
        .setTimestamp();

    try {
        const originalMessage = interaction.message;
        if (originalMessage) {
            await originalMessage.edit({ embeds: [rejectedEmbed], components: [] }).catch(() => { });
        }
        await interaction.reply({ content: 'Rename request rejected.', flags: MessageFlags.Ephemeral });
    } catch {
        await interaction.reply({ content: 'Rename request rejected.', flags: MessageFlags.Ephemeral }).catch(() => { });
    }
}

async function handleLimitModal(interaction: ModalSubmitInteraction, channelId: string): Promise<void> {
    const input = interaction.fields.getTextInputValue('limit_input');
    const limit = parseInt(input, 10);

    if (isNaN(limit) || limit < 0 || limit > 99) {
        await interaction.reply({ content: 'Please enter a valid number between 0 and 99.', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await safeSetUserLimit(interaction.guild!, channelId, limit);
    if (!result.success) {
        await interaction.editReply({ content: `Failed to set limit: ${result.error}` });
        return;
    }

    await interaction.editReply({
        content: limit === 0 ? 'User limit has been removed.' : `User limit set to ${limit}.`,
    });
}

async function handleRenameModal(interaction: ModalSubmitInteraction, channelId: string): Promise<void> {
    const newName = interaction.fields.getTextInputValue('rename_input').trim();

    if (!newName || newName.length > 100) {
        await interaction.reply({ content: 'Please enter a valid channel name (1-100 characters).', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild!;
    const settings = await prisma.guildSettings.findUnique({ where: { guildId: guild.id } });

    // If BOTH staff role AND command channel are set, require approval
    // Otherwise, rename directly
    const requiresApproval = settings && settings.staffRoleId && settings.commandChannelId;

    if (!requiresApproval) {
        const result = await safeSetChannelName(guild, channelId, newName);
        if (!result.success) {
            await interaction.editReply({ content: `Failed to rename: ${result.error}` });
            return;
        }
        await interaction.editReply({ content: `Channel renamed to "${newName}".` });
        return;
    }

    // Get command channel (we know it's set because requiresApproval was true)
    const commandChannel = guild.channels.cache.get(settings!.commandChannelId!) as TextChannel;
    if (!commandChannel || commandChannel.type !== ChannelType.GuildText) {
        const result = await safeSetChannelName(guild, channelId, newName);
        if (!result.success) {
            await interaction.editReply({ content: `Failed to rename: ${result.error}` });
            return;
        }
        await interaction.editReply({ content: `Channel renamed to "${newName}".` });
        return;
    }

    // Create approve/reject buttons
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('pvc_rename_approve').setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('pvc_rename_reject').setLabel('Reject').setStyle(ButtonStyle.Danger)
        );

    const embed = new EmbedBuilder()
        .setTitle('Rename Request')
        .setDescription(`<@${interaction.user.id}> is requesting rename of VC to **"${newName}"**\n\nStaff can approve or reject below.`)
        .setColor(0xFFAA00)
        .setFooter({ text: '15 minute timeout' })
        .setTimestamp();

    const approvalMessage = await commandChannel.send({ embeds: [embed], components: [row] });

    pendingRenames.set(approvalMessage.id, {
        userId: interaction.user.id,
        channelId: channelId,
        newName: newName,
        guildId: guild.id,
    });

    await interaction.editReply({ content: 'Rename request sent! Waiting for staff approval...' });

    // Cleanup timeout
    setTimeout(async () => {
        const pending = pendingRenames.get(approvalMessage.id);
        if (pending) {
            pendingRenames.delete(approvalMessage.id);
            const timeoutEmbed = new EmbedBuilder()
                .setTitle('Rename Request Expired ⏱️')
                .setDescription(`<@${pending.userId}>'s rename request to **"${pending.newName}"** expired.`)
                .setColor(0x888888)
                .setTimestamp();
            await approvalMessage.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => { });
        }
    }, 15 * 60 * 1000);
}

async function handleBitrateModal(interaction: ModalSubmitInteraction, channelId: string): Promise<void> {
    const input = interaction.fields.getTextInputValue('bitrate_input');
    const bitrate = parseInt(input, 10);

    const guild = interaction.guild!;
    const maxBitrate = guild.premiumTier === 0 ? 96 : guild.premiumTier === 1 ? 128 : guild.premiumTier === 2 ? 256 : 384;

    if (isNaN(bitrate) || bitrate < 8 || bitrate > maxBitrate) {
        await interaction.reply({ content: `Please enter a valid bitrate between 8 and ${maxBitrate} kbps.`, flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await safeSetBitrate(guild, channelId, bitrate * 1000);
    if (!result.success) {
        await interaction.editReply({ content: `Failed to set bitrate: ${result.error}` });
        return;
    }

    await interaction.editReply({ content: `Bitrate set to ${bitrate} kbps.` });
}

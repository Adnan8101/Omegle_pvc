import { type ModalSubmitInteraction, ChannelType, EmbedBuilder, TextChannel, MessageFlags } from 'discord.js';
import { getChannelByOwner, getTeamChannelByOwner, getTeamChannelState, getChannelState } from '../../utils/voiceManager';
import { safeSetChannelName, safeSetUserLimit, safeSetBitrate, validateVoiceChannel } from '../../utils/discordApi';
import prisma from '../../utils/database';
import { logAction, LogAction } from '../../utils/logger';
import { isPvcPaused } from '../../utils/pauseManager';

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const { customId, guild } = interaction;
    if (!guild) return;

    if (isPvcPaused(guild.id) && customId.startsWith('pvc_')) {
        const pauseEmbed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('⏸️ PVC System Paused')
            .setDescription(
                'The Private Voice Channel system is currently paused.\n\n' +
                'All interface controls are temporarily disabled.\n' +
                'Please wait for an administrator to resume the system.'
            )
            .setTimestamp();

        await interaction.reply({ embeds: [pauseEmbed], flags: [MessageFlags.Ephemeral] });
        return;
    }

    if (customId.startsWith('pvc_reject_reason_')) {
        await interaction.reply({ content: 'Rejection via button is no longer supported. React to the message instead.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const userId = interaction.user.id;

    const messageChannel = interaction.channel;
    let targetChannelId: string | undefined;
    let isTeamChannel = false;

    if (messageChannel && 'type' in messageChannel && messageChannel.type === ChannelType.GuildVoice) {
        const pvcState = getChannelState(messageChannel.id);
        const teamState = getTeamChannelState(messageChannel.id);

        if (pvcState && pvcState.ownerId === userId) {
            targetChannelId = messageChannel.id;
            isTeamChannel = false;
        } else if (teamState && teamState.ownerId === userId) {
            targetChannelId = messageChannel.id;
            isTeamChannel = true;
        }
    }

    if (!targetChannelId) {
        let ownedChannelId = getChannelByOwner(guild.id, userId);
        if (!ownedChannelId) {
            ownedChannelId = getTeamChannelByOwner(guild.id, userId);
            isTeamChannel = Boolean(ownedChannelId);
        } else {
            isTeamChannel = false;
        }
        targetChannelId = ownedChannelId;
    }

    if (!targetChannelId) {
        await interaction.reply({ content: 'You do not own a private or team voice channel.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const channel = await validateVoiceChannel(guild, targetChannelId);
    if (!channel) {
        await interaction.reply({ content: 'Your voice channel could not be found.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    switch (customId) {
        case 'pvc_limit_modal':
            await handleLimitModal(interaction, targetChannelId, isTeamChannel);
            break;
        case 'pvc_rename_modal':
            await handleRenameModal(interaction, targetChannelId);
            break;
        case 'pvc_bitrate_modal':
            await handleBitrateModal(interaction, targetChannelId);
            break;
        default:
            await interaction.reply({ content: 'Unknown modal.', flags: [MessageFlags.Ephemeral] });
    }
}

async function handleLimitModal(interaction: ModalSubmitInteraction, channelId: string, isTeamChannel: boolean = false): Promise<void> {

    if (isTeamChannel) {
        const channel = await validateVoiceChannel(interaction.guild!, channelId);
        const settings = await prisma.guildSettings.findUnique({ where: { guildId: interaction.guild!.id } });
        let message = `User limit is fixed to **${channel?.userLimit || 'default'}** for team channels.`;
        if (settings?.interfaceVcId) {
            message += `\n\nWant your own VC with unlimited space?\nCreate Private Voice Channel from <#${settings.interfaceVcId}>`;
        }
        await interaction.reply({
            content: message,
            flags: [MessageFlags.Ephemeral]
        });
        return;
    }

    const input = interaction.fields.getTextInputValue('limit_input');
    const limit = parseInt(input, 10);

    if (isNaN(limit) || limit < 0 || limit > 99) {
        await interaction.reply({ content: 'Please enter a valid number between 0 and 99.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const result = await safeSetUserLimit(interaction.guild!, channelId, limit);
    if (!result.success) {
        await interaction.editReply({ content: `Failed to set limit: ${result.error}` });
        return;
    }

    const channel = await validateVoiceChannel(interaction.guild!, channelId);
    await logAction({
        action: LogAction.CHANNEL_LIMIT_SET,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel?.name,
        channelId: channelId,
        details: limit === 0 ? 'User limit removed' : `User limit set to ${limit}`,
    });

    const settings = await prisma.guildSettings.findUnique({ where: { guildId: interaction.guild!.id } });
    let message = limit === 0 ? 'User limit has been removed.' : `User limit set to ${limit}.`;
    if (settings?.interfaceVcId) {
        message += `\n\nWant your own VC with unlimited space?\nCreate Private Voice Channel from <#${settings.interfaceVcId}>`;
    }
    await interaction.editReply({
        content: message,
    });
}

async function handleRenameModal(interaction: ModalSubmitInteraction, channelId: string): Promise<void> {
    const newName = interaction.fields.getTextInputValue('rename_input').trim();

    if (!newName || newName.length > 100) {
        await interaction.reply({ content: 'Please enter a valid channel name (1-100 characters).', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const guild = interaction.guild!;
    const settings = await prisma.guildSettings.findUnique({ where: { guildId: guild.id } });

    const requiresApproval = settings && settings.staffRoleId && settings.commandChannelId;

    if (!requiresApproval) {
        const result = await safeSetChannelName(guild, channelId, newName);
        if (!result.success) {
            await interaction.editReply({ content: `Failed to rename: ${result.error}` });
            return;
        }

        await logAction({
            action: LogAction.CHANNEL_RENAMED,
            guild: guild,
            user: interaction.user,
            channelName: newName,
            channelId: channelId,
            details: `Channel renamed to "${newName}"`,
        });

        await interaction.editReply({ content: `Channel renamed to "${newName}".` });
        return;
    }

    const commandChannel = guild.channels.cache.get(settings!.commandChannelId!) as TextChannel;
    if (!commandChannel || commandChannel.type !== ChannelType.GuildText) {
        const result = await safeSetChannelName(guild, channelId, newName);
        if (!result.success) {
            await interaction.editReply({ content: `Failed to rename: ${result.error}` });
            return;
        }

        await logAction({
            action: LogAction.CHANNEL_RENAMED,
            guild: guild,
            user: interaction.user,
            channelName: newName,
            channelId: channelId,
            details: `Channel renamed to "${newName}"`,
        });

        await interaction.editReply({ content: `Channel renamed to "${newName}".` });
        return;
    }

    const existingRequests = await prisma.pendingRenameRequest.findMany({
        where: {
            guildId: guild.id,
            userId: interaction.user.id,
        },
    });

    for (const req of existingRequests) {
        try {
            const msg = await commandChannel.messages.fetch(req.messageId);
            const cancelledEmbed = new EmbedBuilder()
                .setTitle('Rename Request Cancelled')
                .setDescription(`<@${req.userId}>'s previous rename request to "${req.newName}" was cancelled due to a new request.`)
                .setColor(0x888888)
                .setTimestamp();
            await msg.edit({ embeds: [cancelledEmbed] }).catch(() => { });
        } catch { }

        await prisma.pendingRenameRequest.delete({ where: { id: req.id } });
    }

    const embed = new EmbedBuilder()
        .setTitle('✏️ Rename Request')
        .setDescription(
            `**New Name:** ${newName}\n\n` +
            (settings?.staffRoleId ? `Ping any <@&${settings.staffRoleId}> for approval.\n\n` : '') +
            `React with ✅ to approve this rename request.`
        )
        .setColor(0xFFAA00)
        .setFooter({ text: '⏱️ Expires in 15 minutes' })
        .setTimestamp();

    const approvalMessage = await commandChannel.send({
        content: `<@${interaction.user.id}> - **Pending Approval**`,
        embeds: [embed]
    });
    await approvalMessage.react('✅');

    await prisma.pendingRenameRequest.create({
        data: {
            guildId: guild.id,
            userId: interaction.user.id,
            channelId: channelId,
            newName: newName,
            messageId: approvalMessage.id,
        },
    });

    await logAction({
        action: LogAction.RENAME_REQUESTED,
        guild: guild,
        user: interaction.user,
        channelId: channelId,
        details: `Rename request to "${newName}" sent for approval`,
    });

    await interaction.editReply({ content: '✅ Rename request sent! Waiting for staff approval...' });

    setTimeout(async () => {
        const pending = await prisma.pendingRenameRequest.findUnique({
            where: { messageId: approvalMessage.id },
        });

        if (pending) {
            await prisma.pendingRenameRequest.delete({ where: { id: pending.id } });

            const timeoutEmbed = new EmbedBuilder()
                .setTitle('⏱️ Rename Request Expired')
                .setDescription(`<@${pending.userId}>'s rename request to "${pending.newName}" expired.`)
                .setColor(0x888888)
                .setTimestamp();

            await approvalMessage.edit({ embeds: [timeoutEmbed] }).catch(() => { });

            await logAction({
                action: LogAction.RENAME_EXPIRED,
                guild: guild,
                user: { id: pending.userId } as any,
                channelId: pending.channelId,
                details: `Rename request to "${pending.newName}" expired after 15 minutes`,
            });
        }
    }, 15 * 60 * 1000);
}

async function handleBitrateModal(interaction: ModalSubmitInteraction, channelId: string): Promise<void> {
    const input = interaction.fields.getTextInputValue('bitrate_input');
    const bitrate = parseInt(input, 10);

    const guild = interaction.guild!;
    const maxBitrate = guild.premiumTier === 0 ? 96 : guild.premiumTier === 1 ? 128 : guild.premiumTier === 2 ? 256 : 384;

    if (isNaN(bitrate) || bitrate < 8 || bitrate > maxBitrate) {
        await interaction.reply({ content: `Please enter a valid bitrate between 8 and ${maxBitrate} kbps.`, flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const result = await safeSetBitrate(guild, channelId, bitrate * 1000);
    if (!result.success) {
        await interaction.editReply({ content: `Failed to set bitrate: ${result.error}` });
        return;
    }

    const channel = await validateVoiceChannel(guild, channelId);
    await logAction({
        action: LogAction.CHANNEL_BITRATE_SET,
        guild: guild,
        user: interaction.user,
        channelName: channel?.name,
        channelId: channelId,
        details: `Bitrate set to ${bitrate} kbps`,
    });

    await interaction.editReply({ content: `Bitrate set to ${bitrate} kbps.` });
}

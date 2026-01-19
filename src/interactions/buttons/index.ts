import {
    type ButtonInteraction,
    ChannelType,
    ActionRowBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getChannelByOwner, getChannelState, transferOwnership, unregisterChannel, getGuildChannels } from '../../utils/voiceManager';
import { executeWithRateLimit, Priority } from '../../utils/rateLimit';
import { safeEditPermissions, safeSetChannelName, validateVoiceChannel } from '../../utils/discordApi';
import prisma from '../../utils/database';
import { BUTTON_EMOJI_MAP } from '../../utils/canvasGenerator';
import { getGuildSettings } from '../../utils/cache';
import { logAction, LogAction } from '../../utils/logger';

export async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId, guild, member } = interaction;
    if (!guild || !member) return;

    const userId = typeof member === 'string' ? member : member.user.id;

    // Remove old approval button handlers
    if (customId === 'pvc_rename_approve' || customId === 'pvc_rename_reject') {
        await interaction.reply({ content: 'Button approvals are no longer supported. React with ✅ instead.', ephemeral: true });
        return;
    }

    // Get user's current voice channel
    const guildMember = await guild.members.fetch(userId);
    const voiceChannelId = guildMember.voice.channelId;

    // For claim, check if user is in any PVC
    if (customId === 'pvc_claim') {
        await handleClaim(interaction, voiceChannelId);
        return;
    }

    // Settings menu doesn't require channel ownership
    if (customId === 'pvc_settings') {
        await handleSettings(interaction);
        return;
    }

    // Delete button - special handling for owner vs admin
    if (customId === 'pvc_delete') {
        await handleDelete(interaction);
        return;
    }

    // Handle delete confirmation buttons
    if (customId.startsWith('pvc_delete_confirm:') || customId === 'pvc_delete_cancel') {
        await handleDeleteConfirm(interaction);
        return;
    }

    if (customId.startsWith('pvc_admin_delete:')) {
        await handleAdminDelete(interaction);
        return;
    }

    // For other buttons, check ownership
    const ownedChannelId = getChannelByOwner(guild.id, userId);
    if (!ownedChannelId) {
        await interaction.reply({
            content: 'You do not own a private voice channel.',
            ephemeral: true,
        });
        return;
    }

    const channel = await validateVoiceChannel(guild, ownedChannelId);
    if (!channel) {
        await interaction.reply({ content: 'Your voice channel could not be found.', ephemeral: true });
        return;
    }

    switch (customId) {
        case 'pvc_lock':
            await handleLock(interaction, channel);
            break;
        case 'pvc_unlock':
            await handleUnlock(interaction, channel);
            break;
        case 'pvc_hide':
            await handleHide(interaction, channel);
            break;
        case 'pvc_unhide':
            await handleUnhide(interaction, channel);
            break;
        case 'pvc_add_user':
        case 'pvc_invite':
            await handleInvite(interaction);
            break;
        case 'pvc_limit':
            await handleLimit(interaction);
            break;
        case 'pvc_ban':
            await handleBan(interaction);
            break;
        case 'pvc_permit':
            await handlePermit(interaction);
            break;
        case 'pvc_rename':
            await handleRename(interaction);
            break;
        case 'pvc_bitrate':
            await handleBitrate(interaction);
            break;
        case 'pvc_region':
            await handleRegion(interaction);
            break;
        case 'pvc_transfer':
            await handleTransfer(interaction);
            break;
        default:
            await interaction.reply({ content: 'Unknown button.', ephemeral: true });
    }
}

// Settings menu - shows all other options
async function handleSettings(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const guild = interaction.guild!;

    // Check if user owns a channel
    const ownedChannelId = getChannelByOwner(guild.id, userId);
    if (!ownedChannelId) {
        await interaction.reply({
            content: 'You do not own a private voice channel.',
            ephemeral: true,
        });
        return;
    }

    // Create clean, modern embed
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31) // Discord dark theme
        .setDescription(
            `### <:settings:1462347302948569178> Voice Channel Settings\n` +
            `\n` +
            `<:Users:1462347409840537747> **User Management**\n` +
            `> Limit · Ban · Permit · Invite\n` +
            `\n` +
            `<:rename:1462347738069864552> **Channel Config**\n` +
            `> Rename · Bitrate · Region\n` +
            `\n` +
            `<:Crown_2:1462348069592109198> **Ownership**\n` +
            `> Claim · Transfer`
        );

    // Create button rows
    const row1 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            createEmojiButton('pvc_limit', 'Limit'),
            createEmojiButton('pvc_ban', 'Ban'),
            createEmojiButton('pvc_permit', 'Permit'),
            createEmojiButton('pvc_invite', 'Invite')
        );

    const row2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            createEmojiButton('pvc_rename', 'Rename'),
            createEmojiButton('pvc_bitrate', 'Bitrate'),
            createEmojiButton('pvc_region', 'Region')
        );

    const row3 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            createEmojiButton('pvc_claim', 'Claim'),
            createEmojiButton('pvc_transfer', 'Transfer')
        );

    await interaction.reply({
        embeds: [embed],
        components: [row1, row2, row3],
        ephemeral: true,
    });
}

// Helper to create emoji button
function createEmojiButton(customId: string, label: string): ButtonBuilder {
    const emojiData = BUTTON_EMOJI_MAP[customId];
    const button = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary);

    if (emojiData) {
        button.setEmoji({ id: emojiData.id, name: emojiData.name });
    }

    return button;
}

// Helper to update channel permissions using safe API
async function updateChannelPermission(
    interaction: ButtonInteraction,
    channel: any,
    permissionUpdates: any,
    successMessage: string
): Promise<void> {
    const result = await safeEditPermissions(interaction.guild!, channel.id, interaction.guild!.id, permissionUpdates);
    if (!result.success) {
        await interaction.reply({ content: `Failed: ${result.error}`, ephemeral: true });
        return;
    }
    await interaction.reply({ content: successMessage, ephemeral: true });
}

// Helper to create and send a selection menu response
async function sendSelectionMenu(
    interaction: ButtonInteraction,
    customId: string,
    placeholder: string,
    type: 'user' | 'role' | 'string',
    options?: { label: string; value: string }[],
    messageContent?: string,
    maxValues: number = 10
): Promise<void> {
    let component;

    if (type === 'user') {
        component = new UserSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setMinValues(type === 'user' && customId === 'pvc_transfer_select' ? 1 : 0) // Transfer needs exactly 1
            .setMaxValues(customId === 'pvc_transfer_select' ? 1 : maxValues);
    } else if (type === 'role') {
        component = new RoleSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setMinValues(0)
            .setMaxValues(maxValues);
    } else {
        component = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .addOptions(
                options?.map(opt =>
                    new StringSelectMenuOptionBuilder().setLabel(opt.label).setValue(opt.value)
                ) || []
            );
    }

    const row = new ActionRowBuilder<typeof component>().addComponents(component);

    await interaction.reply({
        content: messageContent || `${placeholder}:`,
        components: [row],
        ephemeral: true,
    });
}

// Handlers using helpers
async function handleLock(interaction: ButtonInteraction, channel: any): Promise<void> {
    await updateChannelPermission(interaction, channel, { Connect: false }, 'Your voice channel has been locked.');
    await logAction({
        action: LogAction.CHANNEL_LOCKED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel locked - users cannot join',
    });
}

async function handleUnlock(interaction: ButtonInteraction, channel: any): Promise<void> {
    await updateChannelPermission(interaction, channel, { Connect: null }, 'Your voice channel has been unlocked.');
    await logAction({
        action: LogAction.CHANNEL_UNLOCKED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel unlocked - users can now join',
    });
}

async function handleHide(interaction: ButtonInteraction, channel: any): Promise<void> {
    await updateChannelPermission(interaction, channel, { ViewChannel: false }, 'Your voice channel is now hidden.');
    await logAction({
        action: LogAction.CHANNEL_HIDDEN,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel hidden from members',
    });
}

async function handleUnhide(interaction: ButtonInteraction, channel: any): Promise<void> {
    await updateChannelPermission(interaction, channel, { ViewChannel: null }, 'Your voice channel is now visible.');
    await logAction({
        action: LogAction.CHANNEL_UNHIDDEN,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel made visible to members',
    });
}

async function handleInvite(interaction: ButtonInteraction): Promise<void> {
    await sendSelectionMenu(interaction, 'pvc_invite_select', 'Select users to invite', 'user', undefined, '**Select users to add to your voice channel:**');
}

async function handleBan(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_ban_user_select')
        .setPlaceholder('Select users to ban')
        .setMinValues(0)
        .setMaxValues(10);

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('pvc_ban_role_select')
        .setPlaceholder('Select roles to ban')
        .setMinValues(0)
        .setMaxValues(10);

    const userRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);
    const roleRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

    await interaction.reply({
        content: '**Select users and roles to ban from your channel:**',
        components: [userRow, roleRow],
        ephemeral: true,
    });
}

async function handlePermit(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_permit_user_select')
        .setPlaceholder('Select users to permit')
        .setMinValues(0)
        .setMaxValues(10);

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('pvc_permit_role_select')
        .setPlaceholder('Select roles to permit')
        .setMinValues(0)
        .setMaxValues(10);

    const userRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);
    const roleRow = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);

    await interaction.reply({
        content: '**Select users and roles to permit in your channel:**',
        components: [userRow, roleRow],
        ephemeral: true,
    });
}

async function handleRename(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId('pvc_rename_modal')
        .setTitle('Rename Channel');

    const input = new TextInputBuilder()
        .setCustomId('rename_input')
        .setLabel('New channel name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter new name')
        .setRequired(true)
        .setMaxLength(100);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

async function handleBitrate(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId('pvc_bitrate_modal')
        .setTitle('Set Bitrate');

    const input = new TextInputBuilder()
        .setCustomId('bitrate_input')
        .setLabel('Bitrate in kbps (8-384)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('64')
        .setRequired(true)
        .setMaxLength(3);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

async function handleRegion(interaction: ButtonInteraction): Promise<void> {
    const regions = [
        { label: 'Automatic', value: 'auto' },
        { label: 'Brazil', value: 'brazil' },
        { label: 'Hong Kong', value: 'hongkong' },
        { label: 'India', value: 'india' },
        { label: 'Japan', value: 'japan' },
        { label: 'Rotterdam', value: 'rotterdam' },
        { label: 'Russia', value: 'russia' },
        { label: 'Singapore', value: 'singapore' },
        { label: 'South Africa', value: 'southafrica' },
        { label: 'Sydney', value: 'sydney' },
        { label: 'US Central', value: 'us-central' },
        { label: 'US East', value: 'us-east' },
        { label: 'US South', value: 'us-south' },
        { label: 'US West', value: 'us-west' },
    ];

    await sendSelectionMenu(interaction, 'pvc_region_select', 'Select a voice region', 'string', regions, '**Select a voice region:**');
}

async function handleTransfer(interaction: ButtonInteraction): Promise<void> {
    await sendSelectionMenu(interaction, 'pvc_transfer_select', 'Select the new owner', 'user', undefined, '**Select a user to transfer ownership to:**');
}

async function handleClaim(
    interaction: ButtonInteraction,
    voiceChannelId: string | null
): Promise<void> {
    if (!voiceChannelId) {
        await interaction.reply({ content: 'You must be in a voice channel to claim it.', ephemeral: true });
        return;
    }

    const channelState = getChannelState(voiceChannelId);
    if (!channelState) {
        await interaction.reply({ content: 'This is not a private voice channel.', ephemeral: true });
        return;
    }

    const userId = interaction.user.id;
    const guild = interaction.guild!;
    const channel = guild.channels.cache.get(voiceChannelId);

    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    if (channel.members.has(channelState.ownerId)) {
        await interaction.reply({ content: 'The owner is still in the channel. You cannot claim it.', ephemeral: true });
        return;
    }

    const { transferOwnership } = await import('../../utils/voiceManager');
    transferOwnership(voiceChannelId, userId);

    const newOwner = await guild.members.fetch(userId);

    await executeWithRateLimit(`perms:${voiceChannelId}`, async () => {
        await channel.permissionOverwrites.delete(channelState.ownerId).catch(() => { });
        await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true, Connect: true, Speak: true, Stream: true,
            MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
        });
        await channel.setName(newOwner.displayName).catch(() => {});
    });

    await prisma.privateVoiceChannel.update({
        where: { channelId: voiceChannelId },
        data: { ownerId: userId },
    });

    await interaction.reply({ content: 'You have claimed ownership of this voice channel.', ephemeral: true });
}

async function handleDelete(interaction: ButtonInteraction): Promise<void> {
    const { guild, user } = interaction;
    if (!guild) return;

    const ownedChannelId = getChannelByOwner(guild.id, user.id);

    if (ownedChannelId) {
        const channel = guild.channels.cache.get(ownedChannelId);
        const channelName = channel?.name || 'your voice channel';

        const confirmButton = new ButtonBuilder()
            .setCustomId(`pvc_delete_confirm:${ownedChannelId}`)
            .setLabel('Delete')
            .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
            .setCustomId('pvc_delete_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

        const embed = new EmbedBuilder()
            .setColor(0xFF6B6B)
            .setTitle('Delete Voice Channel')
            .setDescription(`Are you sure you want to delete **${channelName}**?\n\nThis action cannot be undone.`);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        return;
    }

    const member = await guild.members.fetch(user.id);
    const hasAdminPerms = member.permissions.has('Administrator') || member.permissions.has('ManageGuild');

    if (!hasAdminPerms) {
        await interaction.reply({
            content: 'You do not own a private voice channel.',
            ephemeral: true,
        });
        return;
    }

    const allPVCs = getGuildChannels(guild.id);
    if (allPVCs.length === 0) {
        await interaction.reply({
            content: 'There are no active private voice channels.',
            ephemeral: true,
        });
        return;
    }

    const options = allPVCs.slice(0, 25).map(pvc => {
        const channel = guild.channels.cache.get(pvc.channelId);
        const owner = guild.members.cache.get(pvc.ownerId);
        const channelName = channel?.name || 'Unknown';
        const ownerName = owner?.displayName || pvc.ownerId;
        return new StringSelectMenuOptionBuilder()
            .setLabel(channelName)
            .setDescription(`Owner: ${ownerName}`)
            .setValue(pvc.channelId);
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('pvc_admin_delete_select')
        .setPlaceholder('Select a channel to delete')
        .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const embed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('Admin: Delete Voice Channel')
        .setDescription(`Select a private voice channel to delete.\n\n**Active PVCs:** ${allPVCs.length}`);

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function handleDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
    const { guild, customId } = interaction;
    if (!guild) return;

    if (customId === 'pvc_delete_cancel') {
        await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
        return;
    }

    const channelId = customId.replace('pvc_delete_confirm:', '');
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        await interaction.update({ content: 'Channel not found.', embeds: [], components: [] });
        return;
    }

    try {
        const channelName = channel.name;
        unregisterChannel(channelId);
        await channel.delete();
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});

        await logAction({
            action: LogAction.CHANNEL_DELETED,
            guild: guild,
            user: interaction.user,
            channelName: channelName,
            channelId: channelId,
            details: 'Voice channel deleted by owner',
        });

        await interaction.update({
            content: 'Voice channel deleted successfully.',
            embeds: [],
            components: [],
        });
    } catch (err) {
        console.error('[Delete] Failed to delete channel:', err);
        await interaction.update({
            content: 'Failed to delete the channel.',
            embeds: [],
            components: [],
        });
    }
}

async function handleAdminDelete(interaction: ButtonInteraction): Promise<void> {
    const { guild, customId, user } = interaction;
    if (!guild) return;

    const member = await guild.members.fetch(user.id);
    const hasAdminPerms = member.permissions.has('Administrator') || member.permissions.has('ManageGuild');

    if (!hasAdminPerms) {
        await interaction.reply({ content: 'You do not have permission to do this.', ephemeral: true });
        return;
    }

    const channelId = customId.replace('pvc_admin_delete:', '');
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        await interaction.update({ content: 'Channel not found.', embeds: [], components: [] });
        return;
    }

    try {
        unregisterChannel(channelId);
        await channel.delete();
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});

        await interaction.update({
            content: `Channel **${channel.name}** deleted successfully.`,
            embeds: [],
            components: [],
        });
    } catch (err) {
        console.error('[AdminDelete] Failed to delete channel:', err);
        await interaction.update({
            content: 'Failed to delete the channel.',
            embeds: [],
            components: [],
        });
    }
}

async function handleLimit(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId('pvc_limit_modal')
        .setTitle('Set User Limit');

    const input = new TextInputBuilder()
        .setCustomId('limit_input')
        .setLabel('Maximum users (0 = unlimited)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter a number')
        .setRequired(true)
        .setMaxLength(3);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

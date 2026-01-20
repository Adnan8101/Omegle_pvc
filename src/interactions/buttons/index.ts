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
import { getChannelByOwner, getChannelState, transferOwnership, unregisterChannel, getGuildChannels, addTempPermittedUsers } from '../../utils/voiceManager';
import { executeWithRateLimit, Priority } from '../../utils/rateLimit';
import { safeEditPermissions, validateVoiceChannel } from '../../utils/discordApi';
import prisma from '../../utils/database';
import { BUTTON_EMOJI_MAP } from '../../utils/canvasGenerator';
import { logAction, LogAction } from '../../utils/logger';

export async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId, guild, member } = interaction;
    if (!guild || !member) return;

    // Handle list_permanent button from !l command
    if (customId.startsWith('list_permanent_')) {
        const targetUserId = customId.replace('list_permanent_', '');

        // Only the original user can click
        if (interaction.user.id !== targetUserId) {
            await interaction.reply({ content: 'This button is not for you.', ephemeral: true });
            return;
        }

        const permanentAccess = await prisma.ownerPermission.findMany({
            where: { guildId: guild.id, ownerId: targetUserId },
            orderBy: { createdAt: 'desc' },
        });

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Permanent Access List');

        if (permanentAccess.length === 0) {
            embed.setDescription('No users with permanent access.');
        } else {
            const userList = permanentAccess.map((p, i) => `${i + 1}. <@${p.targetId}>`).join('\n');
            embed.setDescription(userList);
        }

        embed.setFooter({ text: '/permanent_access add/remove' }).setTimestamp();

        await interaction.update({ embeds: [embed], components: [] });
        return;
    }

    // Skip other list_ buttons (legacy/pagination)
    if (customId.startsWith('list_')) return;

    const userId = typeof member === 'string' ? member : member.user.id;

    if (customId === 'pvc_rename_approve' || customId === 'pvc_rename_reject') {
        await interaction.reply({ content: 'Button approvals are no longer supported. React with ✅ instead.', ephemeral: true });
        return;
    }

    const guildMember = await guild.members.fetch(userId);
    const voiceChannelId = guildMember.voice.channelId;

    if (customId === 'pvc_claim') {
        await handleClaim(interaction, voiceChannelId);
        return;
    }

    if (customId === 'pvc_delete') {
        await handleDelete(interaction);
        return;
    }

    if (customId.startsWith('pvc_delete_confirm:') || customId === 'pvc_delete_cancel') {
        await handleDeleteConfirm(interaction);
        return;
    }

    if (customId.startsWith('pvc_admin_delete:')) {
        await handleAdminDelete(interaction);
        return;
    }

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
        case 'pvc_privacy':
            await handlePrivacy(interaction, channel);
            break;
        case 'pvc_add_user':
            await handleAddUser(interaction);
            break;
        case 'pvc_remove_user':
            await handleRemoveUser(interaction);
            break;
        case 'pvc_invite':
            await handleInvite(interaction);
            break;
        case 'pvc_name':
            await handleRename(interaction);
            break;
        case 'pvc_kick':
            await handleKick(interaction, channel);
            break;
        case 'pvc_region':
            await handleRegion(interaction);
            break;
        case 'pvc_block':
            await handleBlock(interaction);
            break;
        case 'pvc_unblock':
            await handleUnblock(interaction);
            break;
        case 'pvc_transfer':
            await handleTransfer(interaction);
            break;
        case 'pvc_chat':
            await handleChat(interaction, channel);
            break;
        case 'pvc_info':
            await handleInfo(interaction, channel);
            break;
        default:
            await interaction.reply({ content: 'Unknown button.', ephemeral: true });
    }
}

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

async function handleLock(interaction: ButtonInteraction, channel: any): Promise<void> {
    const memberIds = channel.members.map((m: any) => m.id);
    if (memberIds.length > 0) {
        addTempPermittedUsers(channel.id, memberIds);
    }

    await updateChannelPermission(interaction, channel, { Connect: false }, '🔒 Your voice channel has been locked.');
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
    await updateChannelPermission(interaction, channel, { Connect: null }, '🔓 Your voice channel has been unlocked.');
    await logAction({
        action: LogAction.CHANNEL_UNLOCKED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel unlocked - users can now join',
    });
}

async function handlePrivacy(interaction: ButtonInteraction, channel: any): Promise<void> {
    const everyonePerms = channel.permissionOverwrites.cache.get(interaction.guild!.id);
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;

    if (isHidden) {
        await updateChannelPermission(interaction, channel, { ViewChannel: null }, '👁️ Your voice channel is now **visible**.');
        await logAction({
            action: LogAction.CHANNEL_UNHIDDEN,
            guild: interaction.guild!,
            user: interaction.user,
            channelName: channel.name,
            channelId: channel.id,
            details: 'Channel made visible to members',
        });
    } else {
        await updateChannelPermission(interaction, channel, { ViewChannel: false }, '🙈 Your voice channel is now **hidden**.');
        await logAction({
            action: LogAction.CHANNEL_HIDDEN,
            guild: interaction.guild!,
            user: interaction.user,
            channelName: channel.name,
            channelId: channel.id,
            details: 'Channel hidden from members',
        });
    }
}

async function handleAddUser(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_add_user_select')
        .setPlaceholder('Select users to add (Trust)')
        .setMinValues(1)
        .setMaxValues(10);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to add to your voice channel:**',
        components: [row],
        ephemeral: true,
    });
}

async function handleRemoveUser(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_remove_user_select')
        .setPlaceholder('Select users to remove (Untrust)')
        .setMinValues(1)
        .setMaxValues(10);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to remove from your voice channel:**',
        components: [row],
        ephemeral: true,
    });
}

async function handleInvite(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_invite_select')
        .setPlaceholder('Select users to invite')
        .setMinValues(1)
        .setMaxValues(10);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to invite to your voice channel:**\n*They will receive a DM with an invite link.*',
        components: [row],
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

async function handleKick(interaction: ButtonInteraction, channel: any): Promise<void> {
    const membersInChannel = channel.members.filter((m: any) => m.id !== interaction.user.id);

    if (membersInChannel.size === 0) {
        await interaction.reply({ content: 'There are no other users in your channel to kick.', ephemeral: true });
        return;
    }

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_kick_select')
        .setPlaceholder('Select users to kick')
        .setMinValues(1)
        .setMaxValues(Math.min(membersInChannel.size, 10));

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to kick from your voice channel:**',
        components: [row],
        ephemeral: true,
    });
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

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('pvc_region_select')
        .setPlaceholder('Select a voice region')
        .addOptions(
            regions.map(r => new StringSelectMenuOptionBuilder().setLabel(r.label).setValue(r.value))
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.reply({
        content: '**Select a voice region:**',
        components: [row],
        ephemeral: true,
    });
}

async function handleBlock(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_block_select')
        .setPlaceholder('Select users to block')
        .setMinValues(1)
        .setMaxValues(10);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to block from your voice channel:**\n*Blocked users cannot join by any means.*',
        components: [row],
        ephemeral: true,
    });
}

async function handleUnblock(interaction: ButtonInteraction): Promise<void> {
    const guild = interaction.guild!;
    const ownedChannelId = getChannelByOwner(guild.id, interaction.user.id);

    if (!ownedChannelId) {
        await interaction.reply({ content: 'You do not own a private voice channel.', ephemeral: true });
        return;
    }

    const blockedUsers = await prisma.voicePermission.findMany({
        where: { channelId: ownedChannelId, permission: 'ban' },
    });

    if (blockedUsers.length === 0) {
        await interaction.reply({ content: 'No users are currently blocked from your channel.', ephemeral: true });
        return;
    }

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_unblock_select')
        .setPlaceholder('Select users to unblock')
        .setMinValues(1)
        .setMaxValues(Math.min(blockedUsers.length, 10));

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select users to unblock:**',
        components: [row],
        ephemeral: true,
    });
}

async function handleTransfer(interaction: ButtonInteraction): Promise<void> {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('pvc_transfer_select')
        .setPlaceholder('Select the new owner')
        .setMinValues(1)
        .setMaxValues(1);

    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

    await interaction.reply({
        content: '**Select a user to transfer ownership to:**',
        components: [row],
        ephemeral: true,
    });
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

    transferOwnership(voiceChannelId, userId);

    const newOwner = await guild.members.fetch(userId);

    await executeWithRateLimit(`perms:${voiceChannelId}`, async () => {
        await channel.permissionOverwrites.delete(channelState.ownerId).catch(() => { });
        await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true, Connect: true, Speak: true, Stream: true,
            MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
        });
        await channel.setName(newOwner.displayName).catch(() => { });
    });

    await prisma.privateVoiceChannel.update({
        where: { channelId: voiceChannelId },
        data: { ownerId: userId },
    });

    await interaction.reply({ content: '👑 You have claimed ownership of this voice channel.', ephemeral: true });
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
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });

        await logAction({
            action: LogAction.CHANNEL_DELETED,
            guild: guild,
            user: interaction.user,
            channelName: channelName,
            channelId: channelId,
            details: 'Voice channel deleted by owner',
        });

        await interaction.update({
            content: '🗑️ Voice channel deleted successfully.',
            embeds: [],
            components: [],
        });
    } catch {
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
        await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });

        await interaction.update({
            content: `Channel **${channel.name}** deleted successfully.`,
            embeds: [],
            components: [],
        });
    } catch {
        await interaction.update({
            content: 'Failed to delete the channel.',
            embeds: [],
            components: [],
        });
    }
}

async function handleChat(interaction: ButtonInteraction, channel: any): Promise<void> {
    const vcTextChatUrl = `https://discord.com/channels/${interaction.guild!.id}/${channel.id}`;

    await interaction.reply({
        content: `💬 **Voice Channel Chat**\n\nClick the link below to open your voice channel's text chat:\n${vcTextChatUrl}`,
        ephemeral: true,
    });
}

async function handleInfo(interaction: ButtonInteraction, channel: any): Promise<void> {
    const guild = interaction.guild!;
    const channelState = getChannelState(channel.id);

    if (!channelState) {
        await interaction.reply({ content: 'Could not retrieve channel information.', ephemeral: true });
        return;
    }

    const owner = await guild.members.fetch(channelState.ownerId).catch(() => null);
    const memberCount = channel.members.size;
    const memberList = channel.members.map((m: any) => `<@${m.id}>`).join(', ') || 'None';

    const everyonePerms = channel.permissionOverwrites.cache.get(guild.id);
    const isLocked = everyonePerms?.deny.has('Connect') ?? false;
    const isHidden = everyonePerms?.deny.has('ViewChannel') ?? false;

    const bitrate = Math.round(channel.bitrate / 1000);
    const userLimit = channel.userLimit || 'Unlimited';
    const region = channel.rtcRegion || 'Automatic';

    const embed = new EmbedBuilder()
        .setAuthor({ name: 'Channel Information', iconURL: guild.iconURL() || undefined })
        .setTitle(channel.name)
        .setColor(0x2b2d31)
        .addFields(
            { name: 'Owner', value: owner ? `<@${owner.id}>` : 'Unknown', inline: true },
            { name: 'Occupancy', value: `${memberCount}/${userLimit}`, inline: true },
            { name: 'Region', value: region.charAt(0).toUpperCase() + region.slice(1), inline: true },
            { name: 'Bitrate', value: `${bitrate} kbps`, inline: true },
            { name: 'Status', value: `${isLocked ? 'Locked' : 'Unlocked'} / ${isHidden ? 'Hidden' : 'Visible'}`, inline: true },
            { name: 'Voice Members', value: memberList.slice(0, 1024), inline: false }
        )
        .setFooter({ text: `ID: ${channel.id}` })
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        ephemeral: true,
    });
}


import {
    type AnySelectMenuInteraction,
    ChannelType,
    type UserSelectMenuInteraction,
    type RoleSelectMenuInteraction,
    type StringSelectMenuInteraction,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    GuildMember,
} from 'discord.js';
import { getChannelByOwner, transferOwnership, unregisterChannel, getGuildChannels } from '../../utils/voiceManager';
import { executeWithRateLimit, executeParallel, Priority } from '../../utils/rateLimit';
import { transferChannelOwnership } from '../../utils/channelActions';
import prisma from '../../utils/database';
import { batchUpsertPermissions, invalidateWhitelist, batchUpsertOwnerPermissions, batchDeleteOwnerPermissions, getOwnerPermissions as getCachedOwnerPerms, invalidateChannelPermissions } from '../../utils/cache';
import { logAction, LogAction } from '../../utils/logger';

export async function handleSelectMenuInteraction(
    interaction: AnySelectMenuInteraction
): Promise<void> {
    const { customId, guild } = interaction;
    if (!guild) return;

    const userId = interaction.user.id;
    const ownedChannelId = getChannelByOwner(guild.id, userId);

    if (customId === 'pvc_admin_delete_select') {
        await handleAdminDeleteSelect(interaction as StringSelectMenuInteraction);
        return;
    }

    if (!ownedChannelId && customId !== 'pvc_transfer_select') {
        await interaction.reply({
            content: 'You do not own a private voice channel.',
            ephemeral: true,
        });
        return;
    }

    const channel = ownedChannelId ? guild.channels.cache.get(ownedChannelId) : null;

    switch (customId) {
        case 'pvc_add_user_select':
            await handleAddUserSelect(interaction as UserSelectMenuInteraction, channel, userId);
            break;
        case 'pvc_remove_user_select':
            await handleRemoveUserSelect(interaction as UserSelectMenuInteraction, channel, userId);
            break;
        case 'pvc_invite_select':
            await handleInviteSelect(interaction as UserSelectMenuInteraction, channel, userId);
            break;
        case 'pvc_kick_select':
            await handleKickSelect(interaction as UserSelectMenuInteraction, channel, userId);
            break;
        case 'pvc_block_select':
            await handleBlockSelect(interaction as UserSelectMenuInteraction, channel, userId);
            break;
        case 'pvc_unblock_select':
            await handleUnblockSelect(interaction as UserSelectMenuInteraction, channel);
            break;
        case 'pvc_region_select':
            await handleRegionSelect(interaction as StringSelectMenuInteraction, channel);
            break;
        case 'pvc_transfer_select':
            await handleTransferSelect(interaction as UserSelectMenuInteraction, ownedChannelId);
            break;
        default:
            await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
    }
}

async function updateVoicePermissions(
    channel: any,
    targets: Map<string, any>,
    type: 'user' | 'role',
    permission: 'permit' | 'ban',
    permissionUpdates: any
): Promise<void> {
    const targetIds = Array.from(targets.keys());

    const discordTasks = targetIds.map(id => ({
        route: `perms:${channel.id}:${id}`,
        task: () => channel.permissionOverwrites.edit(id, permissionUpdates),
        priority: Priority.NORMAL,
    }));
    await executeParallel(discordTasks);

    if (permission === 'ban') {
        const disconnectTasks: Array<{ route: string; task: () => Promise<any>; priority: Priority }> = [];

        for (const id of targetIds) {
            if (type === 'user') {
                const member = channel.members.get(id);
                if (member) {
                    disconnectTasks.push({
                        route: `disconnect:${id}`,
                        task: () => member.voice.disconnect(),
                        priority: Priority.NORMAL,
                    });
                }
            } else {
                for (const [, member] of channel.members) {
                    if (member.roles.cache.has(id)) {
                        disconnectTasks.push({
                            route: `disconnect:${member.id}`,
                            task: () => member.voice.disconnect(),
                            priority: Priority.NORMAL,
                        });
                    }
                }
            }
        }

        if (disconnectTasks.length > 0) {
            await executeParallel(disconnectTasks);
        }
    }

    await batchUpsertPermissions(
        channel.id,
        targetIds.map(id => ({ targetId: id, targetType: type, permission }))
    );
}

async function handleAddUserSelect(
    interaction: UserSelectMenuInteraction,
    channel: any,
    ownerId: string
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users } = interaction;

    if (users.has(ownerId)) {
        await interaction.reply({ content: 'You cannot add yourself to your own channel.', ephemeral: true });
        return;
    }

    await updateVoicePermissions(channel, users, 'user', 'permit', { ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, AttachFiles: true });

    // Persistent History: Save to OwnerPermission using Cache Helper
    const targetIds = Array.from(users.keys());
    await batchUpsertOwnerPermissions(
        interaction.guild!.id,
        ownerId,
        targetIds.map(id => ({ targetId: id, targetType: 'user' }))
    );

    await logAction({
        action: LogAction.USER_ADDED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: `Added ${users.size} user(s)`,
    });

    await interaction.update({
        content: `✅ Trusted ${users.size} user(s) in your voice channel.`,
        components: [],
    });
}

async function handleRemoveUserSelect(
    interaction: UserSelectMenuInteraction,
    channel: any,
    ownerId: string
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users } = interaction;

    if (users.has(ownerId)) {
        await interaction.reply({ content: 'You cannot remove yourself from your own channel.', ephemeral: true });
        return;
    }

    const targetIds = Array.from(users.keys());

    const discordTasks = targetIds.map(id => ({
        route: `perms:${channel.id}:${id}`,
        task: () => channel.permissionOverwrites.delete(id).catch(() => { }),
        priority: Priority.NORMAL,
    }));
    await executeParallel(discordTasks);

    await prisma.voicePermission.deleteMany({
        where: {
            channelId: channel.id,
            targetId: { in: targetIds },
        },
    });

    // Persistent History: Remove from OwnerPermission using Cache Helper
    await batchDeleteOwnerPermissions(
        interaction.guild!.id,
        ownerId,
        targetIds
    );

    invalidateWhitelist(channel.id);

    await logAction({
        action: LogAction.USER_REMOVED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: `Removed ${users.size} user(s)`,
    });

    await interaction.update({
        content: `✅ Untrusted ${users.size} user(s) from your voice channel.`,
        components: [],
    });
}

async function handleInviteSelect(
    interaction: UserSelectMenuInteraction,
    channel: any,
    ownerId: string
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users, user: inviter } = interaction;

    if (users.has(ownerId)) {
        await interaction.reply({ content: 'You cannot invite yourself to your own channel.', ephemeral: true });
        return;
    }

    await updateVoicePermissions(channel, users, 'user', 'permit', { ViewChannel: true, Connect: true, SendMessages: true, EmbedLinks: true, AttachFiles: true });

    for (const [, user] of users) {
        user.send(`<@${inviter.id}> is inviting you to join <#${channel.id}>`).catch(() => { });
    }

    await interaction.update({
        content: `📨 Invited ${users.size} user(s) to your voice channel.`,
        components: [],
    });
}

async function handleKickSelect(
    interaction: UserSelectMenuInteraction,
    channel: any,
    ownerId: string
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users } = interaction;

    if (users.has(ownerId)) {
        await interaction.reply({ content: 'You cannot kick yourself from your own channel.', ephemeral: true });
        return;
    }

    let kickedCount = 0;
    for (const [userId] of users) {
        const member = channel.members.get(userId);
        if (member) {
            await executeWithRateLimit(`disconnect:${userId}`, () =>
                member.voice.disconnect()
            );
            kickedCount++;
        }
    }

    await interaction.update({
        content: `👢 Kicked ${kickedCount} user(s) from your voice channel.`,
        components: [],
    });
}

async function handleBlockSelect(
    interaction: UserSelectMenuInteraction,
    channel: any,
    ownerId: string
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users } = interaction;

    if (users.has(ownerId)) {
        await interaction.reply({ content: 'You cannot block yourself from your own channel.', ephemeral: true });
        return;
    }

    await updateVoicePermissions(channel, users, 'user', 'ban', { ViewChannel: false, Connect: false });

    await logAction({
        action: LogAction.USER_BANNED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: `Blocked ${users.size} user(s)`,
    });

    await interaction.update({
        content: `🚫 Blocked ${users.size} user(s) from your voice channel.`,
        components: [],
    });
}

async function handleUnblockSelect(
    interaction: UserSelectMenuInteraction,
    channel: any
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users } = interaction;
    const targetIds = Array.from(users.keys());

    const discordTasks = targetIds.map(id => ({
        route: `perms:${channel.id}:${id}`,
        task: () => channel.permissionOverwrites.delete(id).catch(() => { }),
        priority: Priority.NORMAL,
    }));
    await executeParallel(discordTasks);

    await prisma.voicePermission.deleteMany({
        where: {
            channelId: channel.id,
            targetId: { in: targetIds },
            permission: 'ban',
        },
    });

    invalidateWhitelist(channel.id);

    await interaction.update({
        content: `✅ Unblocked ${users.size} user(s) from your voice channel.`,
        components: [],
    });
}

async function handleRegionSelect(
    interaction: StringSelectMenuInteraction,
    channel: any
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const region = interaction.values[0];
    await executeWithRateLimit(`edit:${channel.id}`, () =>
        channel.setRTCRegion(region === 'auto' ? null : region),
        Priority.NORMAL
    );

    await logAction({
        action: LogAction.CHANNEL_REGION_SET,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: `Region set to ${region === 'auto' ? 'Automatic' : region}`,
    });

    await interaction.update({
        content: `🌍 Voice region set to **${region === 'auto' ? 'Automatic' : region}**.`,
        components: [],
    });
}

async function handleTransferSelect(
    interaction: UserSelectMenuInteraction,
    channelId: string | undefined
): Promise<void> {
    if (!channelId) {
        await interaction.reply({ content: 'You do not own a private voice channel.', ephemeral: true });
        return;
    }

    const guild = interaction.guild!;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const selectedUser = interaction.users.first();
    if (!selectedUser) {
        await interaction.update({ content: 'No user selected.', components: [] });
        return;
    }

    if (selectedUser.id === interaction.user.id) {
        await interaction.reply({ content: 'You cannot transfer ownership to yourself.', ephemeral: true });
        return;
    }

    const oldOwnerId = interaction.user.id;
    const newOwnerId = selectedUser.id;

    await transferChannelOwnership(
        guild,
        channelId,
        oldOwnerId,
        newOwnerId,
        interaction.member as GuildMember,
        channel.name
    );

    await interaction.update({ content: `👑 Ownership transferred to **${selectedUser.displayName}**.`, components: [] });
}

async function handleAdminDeleteSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const { guild, user } = interaction;
    if (!guild) return;

    const member = await guild.members.fetch(user.id);
    const hasAdminPerms = member.permissions.has('Administrator') || member.permissions.has('ManageGuild');

    if (!hasAdminPerms) {
        await interaction.reply({ content: 'You do not have permission to do this.', ephemeral: true });
        return;
    }

    const channelId = interaction.values[0];
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        await interaction.update({ content: 'Channel not found.', embeds: [], components: [] });
        return;
    }

    const confirmButton = new ButtonBuilder()
        .setCustomId(`pvc_admin_delete:${channelId}`)
        .setLabel('Confirm Delete')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('pvc_delete_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

    const embed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('Confirm Deletion')
        .setDescription(`Are you sure you want to delete **${channel.name}**?\n\nThis action cannot be undone.`);

    await interaction.update({ embeds: [embed], components: [row] });
}

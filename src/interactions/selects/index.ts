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
} from 'discord.js';
import { getChannelByOwner, transferOwnership, unregisterChannel, getGuildChannels } from '../../utils/voiceManager';
import { executeWithRateLimit, executeParallel, Priority } from '../../utils/rateLimit';
import { getOwnerPermissions } from '../../utils/permissions';
import prisma from '../../utils/database';
import { batchUpsertPermissions, invalidateWhitelist } from '../../utils/cache';

export async function handleSelectMenuInteraction(
    interaction: AnySelectMenuInteraction
): Promise<void> {
    const { customId, guild } = interaction;
    if (!guild) return;

    const userId = interaction.user.id;
    const ownedChannelId = getChannelByOwner(guild.id, userId);

    // Admin delete select doesn't require ownership
    if (customId === 'pvc_admin_delete_select') {
        await handleAdminDeleteSelect(interaction as StringSelectMenuInteraction);
        return;
    }

    // All other selects require channel ownership
    if (!ownedChannelId && customId !== 'pvc_transfer_select') {
        await interaction.reply({
            content: 'You do not own a private voice channel.',
            ephemeral: true,
        });
        return;
    }

    const channel = ownedChannelId ? guild.channels.cache.get(ownedChannelId) : null;

    switch (customId) {
        case 'pvc_invite_select':
            await handleInviteSelect(interaction as UserSelectMenuInteraction, channel);
            break;
        case 'pvc_ban_user_select':
            await handleBanUserSelect(interaction as UserSelectMenuInteraction, channel);
            break;
        case 'pvc_ban_role_select':
            await handleBanRoleSelect(interaction as RoleSelectMenuInteraction, channel);
            break;
        case 'pvc_permit_user_select':
            await handlePermitUserSelect(interaction as UserSelectMenuInteraction, channel);
            break;
        case 'pvc_permit_role_select':
            await handlePermitRoleSelect(interaction as RoleSelectMenuInteraction, channel);
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

// Optimized batch permission update
async function updateVoicePermissions(
    channel: any,
    targets: Map<string, any>,
    type: 'user' | 'role',
    permission: 'permit' | 'ban',
    permissionUpdates: any
): Promise<void> {
    const targetIds = Array.from(targets.keys());

    // Batch Discord API calls
    const discordTasks = targetIds.map(id => ({
        route: `perms:${channel.id}:${id}`,
        task: () => channel.permissionOverwrites.edit(id, permissionUpdates),
        priority: Priority.NORMAL,
    }));
    await executeParallel(discordTasks);

    // Handle disconnects for bans
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

    // Batch DB update
    await batchUpsertPermissions(
        channel.id,
        targetIds.map(id => ({ targetId: id, targetType: type, permission }))
    );
}

async function handleInviteSelect(
    interaction: UserSelectMenuInteraction,
    channel: any
): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }

    const { users, user: inviter } = interaction;

    await updateVoicePermissions(channel, users, 'user', 'permit', { ViewChannel: true, Connect: true });

    // Send DMs in background (don't await)
    for (const [, user] of users) {
        user.send(`<@${inviter.id}> is inviting you to join <#${channel.id}>`).catch(() => { });
    }

    await interaction.update({
        content: `Invited ${users.size} user(s) to your voice channel.`,
        components: [],
    });
}

async function handleBanUserSelect(interaction: UserSelectMenuInteraction, channel: any): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }
    await updateVoicePermissions(channel, interaction.users, 'user', 'ban', { ViewChannel: false, Connect: false });
    await interaction.update({ content: `Banned ${interaction.users.size} user(s) from your voice channel.`, components: [] });
}

async function handleBanRoleSelect(interaction: RoleSelectMenuInteraction, channel: any): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }
    await updateVoicePermissions(channel, interaction.roles, 'role', 'ban', { ViewChannel: false, Connect: false });
    await interaction.update({ content: `Banned ${interaction.roles.size} role(s) from your voice channel.`, components: [] });
}

async function handlePermitUserSelect(interaction: UserSelectMenuInteraction, channel: any): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }
    await updateVoicePermissions(channel, interaction.users, 'user', 'permit', { ViewChannel: true, Connect: true });
    await interaction.update({ content: `Permitted ${interaction.users.size} user(s) in your voice channel.`, components: [] });
}

async function handlePermitRoleSelect(interaction: RoleSelectMenuInteraction, channel: any): Promise<void> {
    if (!channel || channel.type !== ChannelType.GuildVoice) {
        await interaction.reply({ content: 'Channel not found.', ephemeral: true });
        return;
    }
    await updateVoicePermissions(channel, interaction.roles, 'role', 'permit', { ViewChannel: true, Connect: true });
    await interaction.update({ content: `Permitted ${interaction.roles.size} role(s) in your voice channel.`, components: [] });
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

    await interaction.update({
        content: `Voice region set to ${region === 'auto' ? 'Automatic' : region}.`,
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

    const oldOwnerId = interaction.user.id;
    const newOwnerId = selectedUser.id;

    transferOwnership(channelId, newOwnerId);

    await Promise.all([
        executeWithRateLimit(`perms:${channelId}`, async () => {
            await channel.permissionOverwrites.delete(oldOwnerId).catch(() => { });
            await channel.permissionOverwrites.edit(newOwnerId, {
                ViewChannel: true, Connect: true, Speak: true, Stream: true,
                MuteMembers: true, DeafenMembers: true, MoveMembers: true, ManageChannels: true,
            });
            await channel.setName(selectedUser.displayName).catch(() => {});
        }, Priority.HIGH),
        prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { ownerId: newOwnerId },
        }),
    ]);

    await interaction.update({ content: `Ownership transferred to ${selectedUser.displayName}.`, components: [] });
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

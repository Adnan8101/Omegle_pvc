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
    MessageFlags,
} from 'discord.js';
import { getChannelByOwner, getChannelState, transferOwnership, unregisterChannel, getGuildChannels, addTempPermittedUsers, getTeamChannelByOwner, getTeamChannelState } from '../../utils/voiceManager';
import { executeWithRateLimit, Priority } from '../../utils/rateLimit';
import { safeEditPermissions, validateVoiceChannel } from '../../utils/discordApi';
import { VoiceStateService } from '../../services/voiceStateService';
import { modMailService } from '../../services/modmailService';
import prisma from '../../utils/database';
import { BUTTON_EMOJI_MAP } from '../../utils/canvasGenerator';
import { logAction, LogAction } from '../../utils/logger';
import { isPvcPaused } from '../../utils/pauseManager';
import { recordBotEdit } from '../../events/channelUpdate';

export async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId, guild, member } = interaction;
    if (!guild || !member) return;

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

        await interaction.reply({ embeds: [pauseEmbed], ephemeral: true });
        return;
    }

    if (customId.startsWith('list_permanent_')) {
        const targetUserId = customId.replace('list_permanent_', '');

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

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`list_normal_${targetUserId}`)
                .setLabel('Back to Channel Info')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return;
    }

    if (customId.startsWith('list_normal_')) {
        const targetUserId = customId.replace('list_normal_', '');

        if (interaction.user.id !== targetUserId) {
            await interaction.reply({ content: 'This button is not for you.', ephemeral: true });
            return;
        }

        const pvc = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: targetUserId },
            include: { permissions: true },
        });

        if (!pvc) {
            await interaction.reply({ content: 'You do not have an active voice channel.', ephemeral: true });
            return;
        }

        const channel = guild.channels.cache.get(pvc.channelId);
        const owner = guild.members.cache.get(pvc.ownerId);
        const permittedUsers = pvc.permissions.filter(p => p.permission === 'permit' && p.targetType === 'user');
        const bannedUsers = pvc.permissions.filter(p => p.permission === 'ban' && p.targetType === 'user');
        const permanentCount = await prisma.ownerPermission.count({
            where: { guildId: guild.id, ownerId: targetUserId },
        });

        const embed = new EmbedBuilder()
            .setTitle('Voice Channel Information')
            .setColor(0x5865F2)
            .addFields(
                { name: 'Channel', value: channel?.name || 'Unknown', inline: true },
                { name: 'Owner', value: owner ? `${owner}` : `<@${pvc.ownerId}>`, inline: true },
                { name: 'Members', value: channel && 'members' in channel ? `${(channel as any).members.size}` : '-', inline: true },
            );

        if (permittedUsers.length > 0) {
            const userMentions = permittedUsers.slice(0, 10).map(p => `<@${p.targetId}>`).join(', ');
            const more = permittedUsers.length > 10 ? ` +${permittedUsers.length - 10} more` : '';
            embed.addFields({ name: `Permitted (${permittedUsers.length})`, value: userMentions + more, inline: false });
        }

        if (bannedUsers.length > 0) {
            const bannedMentions = bannedUsers.slice(0, 5).map(p => `<@${p.targetId}>`).join(', ');
            const more = bannedUsers.length > 5 ? ` +${bannedUsers.length - 5} more` : '';
            embed.addFields({ name: `Blocked (${bannedUsers.length})`, value: bannedMentions + more, inline: false });
        }

        embed.addFields({ name: 'Permanent Access', value: `${permanentCount} user(s)`, inline: true });
        embed.setFooter({ text: 'Use /permanent_access to manage trusted users' }).setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`list_permanent_${targetUserId}`)
                .setLabel('View Permanent Access')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return;
    }

    if (customId === 'modmail_userinfo') {
        await modMailService.handleUserInfo(interaction);
        return;
    }

    if (customId === 'modmail_claim') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const { command: claimCmd } = await import('../../commands/modmail/claim');
        // Hack: adapt ButtonInteraction to ChatInputCommandInteraction-like enough for execute
        // Or better, refactor command to sharing logic.
        // For now, let's call logic directly or use a helper.
        // The command uses interaction.channelId and interaction.user.
        // It replys.

        // Actually, let's just implement the small logic here or in service.
        // User requested buttons.
        try {
            const ticket = await prisma.modMailTicket.findFirst({
                where: { channelId: interaction.channelId, status: 'OPEN' }
            });
            if (!ticket) {
                await interaction.editReply('❌ Ticket is not open or not found.');
                return;
            }
            await prisma.modMailTicket.update({
                where: { id: ticket.id },
                data: { status: 'CLAIMED', staffClaimedBy: interaction.user.id }
            });
            const channel = interaction.channel as any;
            const newName = `claimed-${channel.name.replace('claimed-', '')}`;
            await channel.setName(newName).catch(() => { });
            await (interaction.channel as any)?.send(`👮‍♂️ Ticket claimed by ${interaction.user}`);

            await interaction.editReply('✅ You claimed the ticket.');
            await modMailService.logModMail(interaction.guild!, 'Ticket Claimed', `Claimed by ${interaction.user}`, [{ name: 'Ticket', value: ticket.userId }]);
        } catch (e) {
            await interaction.editReply('Failed to claim ticket.');
        }
        return;
    }

    if (customId === 'modmail_close') {
        // Close needs a confirmation or simple action
        // User asked for "Close" button.
        await interaction.reply({ content: 'Closing...', flags: [MessageFlags.Ephemeral] });
        const { command: closeCmd } = await import('../../commands/modmail/close');
        // This is complex because close command generates transcript etc.
        // Let's call the command handler or replicate logic.
        // Replicating logic is safest for types.

        const channel = interaction.channel as any;
        const ticket = await prisma.modMailTicket.findFirst({
            where: { channelId: channel.id, status: { in: ['OPEN', 'CLAIMED'] } }
        });
        if (!ticket) {
            await interaction.editReply('❌ Ticket not active.');
            return;
        }

        await prisma.modMailTicket.update({
            where: { id: ticket.id },
            data: { status: 'CLOSED', closedAt: new Date(), closedBy: interaction.user.id }
        });

        const { transcriptService } = await import('../../services/transcriptService');
        const transcript = await transcriptService.generateTranscript(channel);

        const settings = await prisma.modMailSettings.findUnique({ where: { guildId: interaction.guild!.id } });
        if (settings?.logsChannelId) {
            const logsChannel = interaction.guild!.channels.cache.get(settings.logsChannelId) as any;
            if (logsChannel) {
                await logsChannel.send({
                    content: `📕 **Ticket Closed**\n**User:** <@${ticket.userId}>\n**Closer:** ${interaction.user}\n**Reason:** Button Click\n**Transcript:**`,
                    files: [transcript]
                });
            }
        }

        const user = await interaction.guild!.members.fetch(ticket.userId).catch(() => null);
        if (user) {
            await user.send({
                content: `Your ticket in **${interaction.guild!.name}** has been closed.\n**Reason:** Closed via Button`,
                files: [transcript]
            }).catch(() => { });
        }

        if (settings?.closedCategoryId) {
            await channel.setParent(settings.closedCategoryId);
            await channel.lockPermissions();
        }
        const currentName = channel.name.replace('claimed-', '');
        await channel.setName(`closed-${currentName}`).catch(() => { });
        await channel.send({ content: `✅ Ticket Closed by ${interaction.user}.` });

        return;
    }

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

    if (customId === 'pvc_info' || customId === 'pvc_chat') {

        if (!voiceChannelId) {
            await interaction.reply({
                content: 'You must be in a voice channel to use this button.',
                ephemeral: true,
            });
            return;
        }

        const voiceChannel = guild.channels.cache.get(voiceChannelId);
        if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
            await interaction.reply({ content: 'Voice channel not found.', ephemeral: true });
            return;
        }

        const channelState = getChannelState(voiceChannelId) || getTeamChannelState(voiceChannelId);
        if (!channelState) {
            await interaction.reply({
                content: 'This command only works in private voice channels.',
                ephemeral: true,
            });
            return;
        }

        if (customId === 'pvc_info') {
            await handleInfo(interaction, voiceChannel);
            return;
        }

        if (customId === 'pvc_chat') {
            await handleChat(interaction, voiceChannel);
            return;
        }
    }

    const messageChannel = interaction.channel;
    let targetChannelId: string | undefined;
    let isTeamChannel = false;

    if (voiceChannelId) {

        let pvcState = getChannelState(voiceChannelId);
        let teamState = getTeamChannelState(voiceChannelId);

        if (!pvcState && !teamState) {
            const pvcData = await prisma.privateVoiceChannel.findUnique({
                where: { channelId: voiceChannelId },
            });
            const teamData = await prisma.teamVoiceChannel.findUnique({
                where: { channelId: voiceChannelId },
            });

            if (pvcData) {
                const { registerChannel } = await import('../../utils/voiceManager');
                registerChannel(pvcData.channelId, pvcData.guildId, pvcData.ownerId);
                pvcState = { channelId: pvcData.channelId, guildId: pvcData.guildId, ownerId: pvcData.ownerId, interfaceChannel: false };
            } else if (teamData) {
                const { registerTeamChannel } = await import('../../utils/voiceManager');
                const teamType = teamData.teamType.toLowerCase() as 'duo' | 'trio' | 'squad';
                registerTeamChannel(teamData.channelId, teamData.guildId, teamData.ownerId, teamType);
                teamState = { channelId: teamData.channelId, guildId: teamData.guildId, ownerId: teamData.ownerId, teamType: teamType };
            }
        }

        if (pvcState && pvcState.ownerId === userId) {
            targetChannelId = voiceChannelId;
            isTeamChannel = false;
        } else if (teamState && teamState.ownerId === userId) {
            targetChannelId = voiceChannelId;
            isTeamChannel = true;
        } else if (pvcState || teamState) {

            await interaction.reply({
                content: `⚠️ You can only use these controls in **your own** voice channel.\n\nThis channel belongs to someone else.`,
                ephemeral: true,
            });
            return;
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

        if (!ownedChannelId) {
            const pvcData = await prisma.privateVoiceChannel.findFirst({
                where: { guildId: guild.id, ownerId: userId },
            });
            const teamData = !pvcData ? await prisma.teamVoiceChannel.findFirst({
                where: { guildId: guild.id, ownerId: userId },
            }) : null;

            ownedChannelId = pvcData?.channelId || teamData?.channelId || undefined;
            isTeamChannel = Boolean(teamData);

            if (pvcData) {
                const { registerChannel } = await import('../../utils/voiceManager');
                registerChannel(pvcData.channelId, pvcData.guildId, pvcData.ownerId);
            } else if (teamData) {
                const { registerTeamChannel } = await import('../../utils/voiceManager');
                const teamType = teamData.teamType.toLowerCase() as 'duo' | 'trio' | 'squad';
                registerTeamChannel(teamData.channelId, teamData.guildId, teamData.ownerId, teamType);
            }
        }

        targetChannelId = ownedChannelId;
    }

    if (!targetChannelId) {
        const buttonLabels: Record<string, string> = {
            pvc_lock: 'Lock',
            pvc_unlock: 'Unlock',
            pvc_add_user: 'Add User',
            pvc_remove_user: 'Remove User',
            pvc_limit: 'User Limit',
            pvc_name: 'Rename',
            pvc_kick: 'Kick User',
            pvc_region: 'Region',
            pvc_block: 'Block User',
            pvc_unblock: 'Unblock User',
            pvc_transfer: 'Transfer Ownership',
        };

        const buttonName = buttonLabels[customId] || 'this feature';

        await interaction.reply({
            content: `⚠️ **${buttonName}** can only be used by the voice channel owner.\n\nYou currently do not own a private voice channel.`,
            ephemeral: true,
        });
        return;
    }

    const channel = await validateVoiceChannel(guild, targetChannelId);
    if (!channel) {
        await interaction.reply({ content: 'Your voice channel could not be found.', ephemeral: true });
        return;
    }

    if (customId === 'pvc_limit' && isTeamChannel) {
        const teamState = getTeamChannelState(targetChannelId);
        const settings = await prisma.guildSettings.findUnique({ where: { guildId: interaction.guild!.id } });
        let message = `User limit is fixed to **${channel.userLimit}** for ${teamState?.teamType || 'team'} channels.`;
        if (settings?.interfaceVcId) {
            message += `\n\nWant your own VC with unlimited space?\nCreate Private Voice Channel from <#${settings.interfaceVcId}>`;
        }
        await interaction.reply({
            content: message,
            ephemeral: true,
        });
        return;
    }

    switch (customId) {
        case 'pvc_lock':
            await handleLock(interaction, channel);
            break;
        case 'pvc_unlock':
            await handleUnlock(interaction, channel);
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
        case 'pvc_limit':
            await handleLimit(interaction);
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

    // Update DB first, then enforce - this is the ONLY valid way to lock a channel
    await VoiceStateService.setLock(channel.id, true);

    await interaction.reply({ content: '🔒 Your voice channel has been locked.', ephemeral: true });
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
    // Update DB first, then enforce - this is the ONLY valid way to unlock a channel
    await VoiceStateService.setLock(channel.id, false);

    await interaction.reply({ content: '🔓 Your voice channel has been unlocked.', ephemeral: true });
    await logAction({
        action: LogAction.CHANNEL_UNLOCKED,
        guild: interaction.guild!,
        user: interaction.user,
        channelName: channel.name,
        channelId: channel.id,
        details: 'Channel unlocked - users can now join',
    });
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

    let ownedChannelId = getChannelByOwner(guild.id, interaction.user.id);
    let isTeamChannel = false;

    if (!ownedChannelId) {
        ownedChannelId = getTeamChannelByOwner(guild.id, interaction.user.id);
        isTeamChannel = Boolean(ownedChannelId);
    }

    if (!ownedChannelId) {
        const pvcData = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: interaction.user.id },
        });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: interaction.user.id },
        }) : null;

        ownedChannelId = pvcData?.channelId || teamData?.channelId || undefined;
        isTeamChannel = Boolean(teamData);
    }

    if (!ownedChannelId) {
        await interaction.reply({ content: 'You do not own a voice channel.', ephemeral: true });
        return;
    }

    const blockedUsers = isTeamChannel
        ? await prisma.teamVoicePermission.findMany({
            where: { channelId: ownedChannelId, permission: 'ban' },
        })
        : await prisma.voicePermission.findMany({
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

    recordBotEdit(voiceChannelId);

    await executeWithRateLimit(`perms:${voiceChannelId}`, async () => {
        await channel.permissionOverwrites.delete(channelState.ownerId).catch(() => { });
        await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true, Connect: true, Speak: true, Stream: true,
            SendMessages: true, EmbedLinks: true, AttachFiles: true,
            MuteMembers: true, DeafenMembers: true, ManageChannels: true,
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

    let ownedChannelId = getChannelByOwner(guild.id, user.id);
    let isTeamChannel = false;

    if (!ownedChannelId) {
        ownedChannelId = getTeamChannelByOwner(guild.id, user.id);
        isTeamChannel = Boolean(ownedChannelId);
    }

    if (!ownedChannelId) {
        const pvcData = await prisma.privateVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: user.id },
        });
        const teamData = !pvcData ? await prisma.teamVoiceChannel.findFirst({
            where: { guildId: guild.id, ownerId: user.id },
        }) : null;

        ownedChannelId = pvcData?.channelId || teamData?.channelId || undefined;
        isTeamChannel = Boolean(teamData);
    }

    if (ownedChannelId) {
        const channel = guild.channels.cache.get(ownedChannelId);
        const channelName = channel?.name || 'your voice channel';

        const confirmButton = new ButtonBuilder()
            .setCustomId(`pvc_delete_confirm:${ownedChannelId}:${isTeamChannel}`)
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

    const parts = customId.replace('pvc_delete_confirm:', '').split(':');
    const channelId = parts[0];
    const isTeamChannel = parts[1] === 'true';
    const channel = guild.channels.cache.get(channelId);

    if (!channel) {
        await interaction.update({ content: 'Channel not found.', embeds: [], components: [] });
        return;
    }

    try {
        const channelName = channel.name;

        if (isTeamChannel) {
            const { unregisterTeamChannel } = await import('../../utils/voiceManager');
            unregisterTeamChannel(channelId);
            await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => { });
            await prisma.teamVoicePermission.deleteMany({ where: { channelId } }).catch(() => { });
        } else {
            unregisterChannel(channelId);
            await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => { });
            await prisma.voicePermission.deleteMany({ where: { channelId } }).catch(() => { });
        }

        await channel.delete();

        await logAction({
            action: isTeamChannel ? LogAction.TEAM_CHANNEL_DELETED : LogAction.CHANNEL_DELETED,
            guild: guild,
            user: interaction.user,
            channelName: channelName,
            channelId: channelId,
            details: 'Voice channel deleted by owner',
            isTeamChannel: isTeamChannel,
        });

        await interaction.update({
            content: 'Voice channel deleted successfully.',
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

    let channelState = getChannelState(channel.id);
    let isTeamChannel = false;

    if (!channelState) {
        const teamState = getTeamChannelState(channel.id);
        if (teamState) {
            channelState = teamState as any;
            isTeamChannel = true;
        }
    }

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
        .setFooter({ text: `ID: ${channel.id}${isTeamChannel ? ' (Team Channel)' : ''}` })
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        ephemeral: true,
    });
}

async function handleLimit(interaction: ButtonInteraction): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId('pvc_limit_modal')
        .setTitle('Set User Limit');

    const limitInput = new TextInputBuilder()
        .setCustomId('limit_input')
        .setLabel('User Limit (0 = unlimited, max 99)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter a number between 0 and 99')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(limitInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

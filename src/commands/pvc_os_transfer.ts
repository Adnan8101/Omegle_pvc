import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    GuildMember,
} from 'discord.js';
import type { Command } from '../client';
import { transferChannelOwnership } from '../utils/channelActions';
import { isChannelOwner, getChannelState, getTeamChannelState, transferOwnership, transferTeamOwnership } from '../utils/voiceManager';
import { logAction, LogAction } from '../utils/logger';
import prisma from '../utils/database';
import { enforcer } from '../services/enforcerService';
import { stateStore } from '../vcns/index';
const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];
export const command: Command = {
    data: new SlashCommandBuilder()
        .setName('pvc_os_transfer')
        .setDescription('Force transfer ownership of a PVC or Team VC (Admin/Dev only)')
        .addChannelOption(option =>
            option
                .setName('vc')
                .setDescription('The voice channel to transfer')
                .addChannelTypes(ChannelType.GuildVoice)
                .setRequired(true)
        )
        .addUserOption(option =>
            option
                .setName('owner')
                .setDescription('The new owner')
                .setRequired(true)
        ) as SlashCommandBuilder,
    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild) return;
        const { user, member } = interaction;
        const targetChannel = interaction.options.getChannel('vc', true) as import('discord.js').VoiceChannel;
        const newOwnerUser = interaction.options.getUser('owner', true);
        const isDeveloper = DEVELOPER_IDS.includes(user.id);
        const guildMember = member as GuildMember;
        const botMember = interaction.guild.members.me;
        const hasHigherRole = botMember && guildMember.roles.highest.position > botMember.roles.highest.position;
        const hasAdminPerm = guildMember.permissions.has(PermissionFlagsBits.Administrator);
        if (!isDeveloper && !(hasAdminPerm && hasHigherRole)) {
            await interaction.reply({
                content: '🚫 Access Denied. You must be a Bot Developer or an Administrator with a role higher than the bot.',
                flags: [MessageFlags.Ephemeral],
            });
            return;
        }
        const pvcState = getChannelState(targetChannel.id);
        const teamState = getTeamChannelState(targetChannel.id);
        if (!pvcState && !teamState) {
            await interaction.reply({
                content: '❌ This channel is not a registered Private Voice Channel or Team Voice Channel.',
                flags: [MessageFlags.Ephemeral],
            });
            return;
        }
        const currentOwnerId = pvcState?.ownerId || teamState?.ownerId;
        const isTeam = !!teamState;
        if (currentOwnerId === newOwnerUser.id) {
            await interaction.reply({
                content: '❌ That user is already the owner of this channel.',
                flags: [MessageFlags.Ephemeral],
            });
            return;
        }
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            if (isTeam) {
                // Update voiceManager first
                transferTeamOwnership(targetChannel.id, newOwnerUser.id);
                // Then DB
                await prisma.teamVoiceChannel.update({
                    where: { channelId: targetChannel.id },
                    data: { ownerId: newOwnerUser.id },
                });
                // Then stateStore
                stateStore.updateChannelState(targetChannel.id, { ownerId: newOwnerUser.id });
                await enforcer.enforceQuietly(targetChannel.id);
                await logAction({
                    action: LogAction.CHANNEL_TRANSFERRED,
                    guild: interaction.guild,
                    user: newOwnerUser,
                    channelName: targetChannel.name,
                    channelId: targetChannel.id,
                    details: `Team VC ownership transferred by ${guildMember.displayName}`,
                    isTeamChannel: true,
                });
            } else {
                // transferChannelOwnership already updates voiceManager, DB, and stateStore
                await transferChannelOwnership(
                    interaction.guild,
                    targetChannel.id,
                    currentOwnerId!,
                    newOwnerUser.id,
                    guildMember,
                    targetChannel.name || 'Voice Channel'
                );
            }
            await interaction.editReply({
                content: `✅ Successfully force-transferred **${targetChannel.name}** to **${newOwnerUser.username}**.`,
            });
        } catch (error) {
            console.error('[PvcOsTransfer] Error:', error);
            await interaction.editReply({
                content: '❌ An error occurred while transferring the channel.',
            });
        }
    },
};

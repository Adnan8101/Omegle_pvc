import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    GuildMember,
} from 'discord.js';
import type { Command } from '../client';
import { transferChannelOwnership } from '../utils/channelActions';
import { isChannelOwner, getChannelState } from '../utils/voiceManager';
import { logAction, LogAction } from '../utils/logger';

const DEVELOPER_IDS = ['1232861270030221353', '985442502150397984', '946669037213880340']; // Replace with actual IDs if provided, or empty

export const command: Command = {
    data: new SlashCommandBuilder()
        .setName('pvc_os_transfer')
        .setDescription('Force transfer ownership of a PVC (Admin/Dev only)')
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
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        if (!interaction.guild) return;

        const { user, member } = interaction;
        const targetChannel = interaction.options.getChannel('vc', true) as import('discord.js').VoiceChannel;
        const newOwnerUser = interaction.options.getUser('owner', true);


        // Security Check: Developer or Admin Role > Bot Role
        const isDeveloper = DEVELOPER_IDS.includes(user.id);

        let hasHigherRole = false;
        const guildMember = member as GuildMember;
        const botMember = interaction.guild.members.me;

        if (botMember && guildMember.roles.highest.position > botMember.roles.highest.position) {
            hasHigherRole = true;
        }

        // Allow if Developer OR (Admin Perms AND Higher Role)
        // Note: Default permissions already restrict to Admin, but adding strict hierarchy check as requested
        if (!isDeveloper && !hasHigherRole) {
            await interaction.reply({
                content: '🚫 Access Denied. You must be a Developer or have a role higher than the bot to use this.',
                ephemeral: true,
            });
            return;
        }

        const channelState = getChannelState(targetChannel.id);
        if (!channelState) {
            await interaction.reply({
                content: '❌ This channel is not a registered Private Voice Channel.',
                ephemeral: true,
            });
            return;
        }

        if (channelState.ownerId === newOwnerUser.id) {
            await interaction.reply({
                content: '❌ That user is already the owner of this channel.',
                ephemeral: true,
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            await transferChannelOwnership(
                interaction.guild,
                targetChannel.id,
                channelState.ownerId,
                newOwnerUser.id,
                guildMember,
                targetChannel.name || 'Voice Channel'
            );

            await interaction.editReply({
                content: `✅ Successfully force-transferred **${targetChannel.name}** to **${newOwnerUser.username}**.`,
            });

        } catch (error) {
            console.error(error);
            await interaction.editReply({
                content: '❌ An error occurred while transferring the channel.',
            });
        }
    },
};

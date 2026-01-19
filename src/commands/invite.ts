import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../client';
import { Config } from '../config';

const data = new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Get the bot invite link with all necessary permissions')
    .setDMPermission(true);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // Required permissions for the PVC bot
    const permissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.UseVAD,
        PermissionFlagsBits.ManageMessages,
    ];

    // Calculate permission value
    const permissionValue = permissions.reduce((acc, perm) => acc | perm, 0n);

    // Generate invite URL
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${Config.clientId}&permissions=${permissionValue}&scope=bot%20applications.commands`;

    const embed = new EmbedBuilder()
        .setTitle('Invite Private Voice Channel Bot')
        .setDescription(
            'Click the link below to add this bot to your server with all the necessary permissions.\n\n' +
            '**Required Permissions:**\n' +
            '• View Channels\n' +
            '• Manage Channels\n' +
            '• Manage Roles\n' +
            '• Send Messages\n' +
            '• Embed Links\n' +
            '• Attach Files\n' +
            '• Read Message History\n' +
            '• Connect (Voice)\n' +
            '• Speak (Voice)\n' +
            '• Move Members\n' +
            '• Use Voice Activity\n' +
            '• Manage Messages'
        )
        .setColor(0x5865F2)
        .addFields({
            name: 'Invite Link',
            value: `[Click here to invite the bot](${inviteUrl})`,
        })
        .setFooter({ text: 'After adding, use /pvc_setup to configure the system' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

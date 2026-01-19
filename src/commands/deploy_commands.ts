import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
    EmbedBuilder,
} from 'discord.js';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';

const data = new SlashCommandBuilder()
    .setName('deploy_commands')
    .setDescription('Deploy all slash commands globally to all servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    // Check admin permissions
    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const { REST, Routes } = await import('discord.js');
        const { Config } = await import('../config');
        
        // Import all commands
        const { command: pvcSetup } = await import('./pvc_setup');
        const { command: adminStrictness } = await import('./admin_strictness');
        const { command: pvcStatus } = await import('./pvc_status');
        const { command: pvcCommandChannel } = await import('./pvc_command_channel');
        const { command: pvcStaffRole } = await import('./pvc_staff_role');
        const { command: pvcCleanup } = await import('./pvc_setup_delete');
        const { command: invite } = await import('./invite');
        const { command: refreshPvc } = await import('./refresh_pvc');
        const { command: deployCommandsCmd } = await import('./deploy_commands');

        const commands = [
            pvcSetup.data.toJSON(),
            adminStrictness.data.toJSON(),
            pvcStatus.data.toJSON(),
            pvcCommandChannel.data.toJSON(),
            pvcStaffRole.data.toJSON(),
            pvcCleanup.data.toJSON(),
            invite.data.toJSON(),
            refreshPvc.data.toJSON(),
            deployCommandsCmd.data.toJSON(),
        ];

        const rest = new REST().setToken(Config.token);

        // Deploy globally (to all servers)
        const route = Routes.applicationCommands(Config.clientId);

        await rest.put(route, { body: commands });

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Commands Deployed')
            .setDescription(`Successfully deployed ${commands.length} slash commands **globally** to all servers!`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Deployment Failed')
            .setDescription('Failed to deploy commands. Check console for errors.')
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
}

export const command: Command = { data, execute };

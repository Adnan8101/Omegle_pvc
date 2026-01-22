import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    type ChatInputCommandInteraction,
} from 'discord.js';
import prisma from '../utils/database';
import { registerTeamInterfaceChannel } from '../utils/voiceManager';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';

const data = new SlashCommandBuilder()
    .setName('team_setup')
    .setDescription('Set up the Duo/Trio/Squad voice channel system')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(option =>
        option
            .setName('category')
            .setDescription('The category where team channels will be created')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory)
    )
    .addChannelOption(option =>
        option
            .setName('logs_channel')
            .setDescription('The channel where team VC actions will be logged')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        return;
    }

    if (!await canRunAdminCommand(interaction)) {
        await interaction.reply({ content: '❌ You need a role higher than the bot to use this command, or be the bot developer.', ephemeral: true });
        return;
    }

    const category = interaction.options.getChannel('category', true);
    const logsChannel = interaction.options.getChannel('logs_channel', true);

    if (category.type !== ChannelType.GuildCategory) {
        await interaction.reply({ content: 'Please select a valid category channel.', ephemeral: true });
        return;
    }

    if (logsChannel.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'Logs channel must be a text channel.', ephemeral: true });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const guild = interaction.guild;

        const duoVc = await guild.channels.create({
            name: 'Create Duo',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        const trioVc = await guild.channels.create({
            name: 'Create Trio',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        const squadVc = await guild.channels.create({
            name: 'Create Squad',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        const logsWebhook = await (logsChannel as any).createWebhook({
            name: 'Team VC Logger',
            reason: 'For logging Team VC actions',
        });

        await prisma.teamVoiceSettings.upsert({
            where: { guildId: guild.id },
            update: {
                categoryId: category.id,
                duoVcId: duoVc.id,
                trioVcId: trioVc.id,
                squadVcId: squadVc.id,
                logsChannelId: logsChannel.id,
                logsWebhookUrl: logsWebhook.url,
            },
            create: {
                guildId: guild.id,
                categoryId: category.id,
                duoVcId: duoVc.id,
                trioVcId: trioVc.id,
                squadVcId: squadVc.id,
                logsChannelId: logsChannel.id,
                logsWebhookUrl: logsWebhook.url,
            },
        });

        registerTeamInterfaceChannel(guild.id, 'duo', duoVc.id);
        registerTeamInterfaceChannel(guild.id, 'trio', trioVc.id);
        registerTeamInterfaceChannel(guild.id, 'squad', squadVc.id);

        await logAction({
            action: LogAction.TEAM_SETUP,
            guild: guild,
            user: interaction.user,
            details: `Team VC System set up with category: ${category.name}, logs: ${logsChannel}`,
        });

        await interaction.editReply(
            `✅ Team VC System set up successfully!\n\n` +
            `**Category:** ${category.name}\n` +
            `**Create Duo:** ${duoVc}\n` +
            `**Create Trio:** ${trioVc}\n` +
            `**Create Squad:** ${squadVc}\n` +
            `**Logs Channel:** ${logsChannel}\n\n` +
            `Users can now join these channels to create team voice channels.`
        );
    } catch (error) {
        await interaction.editReply('Failed to set up Team VC system. Check bot permissions.');
    }
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

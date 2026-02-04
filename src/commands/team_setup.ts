import {
    SlashCommandBuilder,
    ChannelType,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    EmbedBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import { registerTeamInterfaceChannel } from '../utils/voiceManager';
import type { Command } from '../client';
import { canRunAdminCommand } from '../utils/permissions';
import { logAction, LogAction } from '../utils/logger';
import { validateServerCommand, validateAdminCommand, validateChannelType } from '../utils/commandValidation';
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
    if (!await validateServerCommand(interaction)) return;
    if (!await validateAdminCommand(interaction)) return;
    const category = interaction.options.getChannel('category', true);
    const logsChannel = interaction.options.getChannel('logs_channel', true);
    if (!await validateChannelType(interaction, category, ChannelType.GuildCategory, 'Please select a valid category channel.')) return;
    if (!await validateChannelType(interaction, logsChannel, ChannelType.GuildText, 'Logs channel must be a text channel.')) return;
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    
    const guild = interaction.guild;
    if (!guild) {
        await interaction.editReply({ content: 'This command can only be used in a server.' });
        return;
    }
    
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
        let logsWebhook;
        try {
            const webhooks = await (logsChannel as any).fetchWebhooks();
            logsWebhook = webhooks.find((w: any) => w.owner?.id === interaction.client.user?.id && w.name === 'Team VC Logger');
            if (!logsWebhook) {
                const botWebhooks = webhooks.filter((w: any) => w.owner?.id === interaction.client.user?.id);
                if (webhooks.size >= 15 && botWebhooks.size > 0) {
                    console.log('[Team Setup] Webhook limit reached, cleaning up old bot webhooks...');
                    for (const oldWebhook of botWebhooks.values()) {
                        try {
                            await oldWebhook.delete('Cleaning up old webhooks');
                        } catch {}
                    }
                }
                logsWebhook = await (logsChannel as any).createWebhook({
                    name: 'Team VC Logger',
                    reason: 'For logging Team VC actions',
                });
            }
        } catch (webhookError: any) {
            throw new Error(`Failed to setup webhook: ${webhookError.message}`);
        }
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
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Team Voice Channel System Setup Complete')
            .setDescription('Users can now join the channels below to create team voice channels.')
            .addFields(
                {
                    name: 'Category',
                    value: `${category.name}`,
                    inline: true,
                },
                {
                    name: 'Logs Channel',
                    value: `${logsChannel}`,
                    inline: true,
                },
                {
                    name: 'Create Duo (2 members)',
                    value: `${duoVc}`,
                    inline: true,
                },
                {
                    name: 'Create Trio (3 members)',
                    value: `${trioVc}`,
                    inline: true,
                },
                {
                    name: 'Create Squad (4 members)',
                    value: `${squadVc}`,
                    inline: true,
                },
            )
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        await interaction.editReply('Failed to set up Team VC system. Check bot permissions.');
    }
}
export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

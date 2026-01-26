import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    TextChannel,
    CategoryChannel
} from 'discord.js';
import prisma from '../../utils/database';
import type { Command } from '../../client';
import { transcriptService } from '../../services/transcriptService';
import { modMailService } from '../../services/modmailService';

const data = new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the current ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addStringOption(option =>
        option.setName('reason')
            .setDescription('Reason for closing')
            .setRequired(false)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const channel = interaction.channel as TextChannel;
    const reason = interaction.options.getString('reason') || 'No reason provided';

    const ticket = await prisma.modMailTicket.findFirst({
        where: {
            channelId: channel.id,
            status: { in: ['OPEN', 'CLAIMED'] }
        }
    });

    if (!ticket) {
        await interaction.reply({ content: '❌ This command can only be used in an active ticket.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.reply('🔒 Closing ticket...');

    // 1. Update DB
    await prisma.modMailTicket.update({
        where: { id: ticket.id },
        data: {
            status: 'CLOSED',
            closedAt: new Date(),
            closedBy: interaction.user.id
        }
    });

    // 2. Generate Transcript
    const transcript = await transcriptService.generateTranscript(channel);

    // 3. Send to Logs
    const settings = await prisma.modMailSettings.findUnique({ where: { guildId: interaction.guild.id } });
    if (settings?.logsChannelId) {
        const logsChannel = interaction.guild.channels.cache.get(settings.logsChannelId) as TextChannel;
        if (logsChannel) {
            await logsChannel.send({
                content: `📕 **Ticket Closed**\n**User:** <@${ticket.userId}>\n**Closer:** ${interaction.user}\n**Reason:** ${reason}\n**Transcript:**`,
                files: [transcript]
            });
        }
    }

    // 4. Send to User
    const user = await interaction.guild.members.fetch(ticket.userId).catch(() => null);
    if (user) {
        try {
            await user.send(`**Ticket Closed**\nReason: ${reason}\n\nSend a new message to open a new ticket.`);
        } catch (e) {
            // User likely has DMs closed
        }
    }

    // 5. Move to Closed Category and Rename
    if (settings?.closedCategoryId) {
        await channel.setParent(settings.closedCategoryId);
        await channel.lockPermissions(); // Sync with closed category (Staff only)
    }

    // Rename
    // Strip prefixes like displayed in name
    // e.g. claimed-username-ticket -> closed-username-ticket
    // username-ticket -> closed-username-ticket
    const currentName = channel.name.replace('claimed-', '');
    await channel.setName(`closed-${currentName}`).catch(() => { });

    await channel.send({
        content: `✅ Ticket Closed by ${interaction.user}. Transcript generated below.`,
        files: [transcript]
    });

    // 6. Delete channel ? 
    // Spec says: "Move channel, Rename channel". Implementation says "Closed: Ticket archived".
    // So we KEEP the channel in the Closed category.
}

export const command: Command = {
    data: data as any,
    execute
};

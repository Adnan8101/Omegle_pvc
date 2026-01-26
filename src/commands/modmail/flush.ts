import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    ChannelType
} from 'discord.js';
import prisma from '../../utils/database';
import type { Command } from '../../client';
import { logAction, LogAction } from '../../utils/logger';

const data = new SlashCommandBuilder()
    .setName('flush')
    .setDescription('Flush ModMail state for a user (Admin Only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addUserOption(option =>
        option.setName('user')
            .setDescription('The user to flush')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const user = interaction.options.getUser('user', true);

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    // 1. Find all active/pending tickets for this user in this guild
    const tickets = await prisma.modMailTicket.findMany({
        where: {
            guildId: interaction.guild.id,
            userId: user.id,
            status: { in: ['OPEN', 'PENDING', 'CLAIMED'] }
        }
    });

    if (tickets.length === 0) {
        await interaction.editReply(`No active or pending tickets found for ${user}.`);
        return;
    }

    let deletedCount = 0;
    let channelDeletedCount = 0;

    for (const ticket of tickets) {
        // Delete Channel if exists
        if (ticket.channelId) {
            const channel = interaction.guild.channels.cache.get(ticket.channelId);
            if (channel) {
                await channel.delete('ModMail Flush Command').catch(() => { });
                channelDeletedCount++;
            }
        }

        // Delete from DB
        await prisma.modMailTicket.delete({ where: { id: ticket.id } });
        deletedCount++;
    }

    await interaction.editReply(`✅ **Flushed User State**\n- Deleted DB Entries: ${deletedCount}\n- Deleted Channels: ${channelDeletedCount}\n\n${user} can now open a fresh ticket.`);

    // Log if logging enabled
    await logAction({
        action: LogAction.TICKET_FLUSHED,
        guild: interaction.guild,
        user: interaction.user,
        details: `Flushed ModMail state for ${user.tag} (${user.id})`
    });
}

export const command: Command = {
    data: data as any,
    execute
};

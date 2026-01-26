import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    TextChannel
} from 'discord.js';
import prisma from '../../utils/database';
import type { Command } from '../../client';
import { client } from '../../client';

const data = new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim the current ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const ticket = await prisma.modMailTicket.findFirst({
        where: {
            channelId: interaction.channelId,
            status: 'OPEN'
        }
    });

    if (!ticket) {
        await interaction.reply({ content: '❌ This command can only be used in an OPEN ticket.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Update DB
    await prisma.modMailTicket.update({
        where: { id: ticket.id },
        data: {
            status: 'CLAIMED',
            staffClaimedBy: interaction.user.id
        }
    });

    // Rename Channel
    const channel = interaction.channel as TextChannel;
    const newName = `claimed-${channel.name.replace('claimed-', '')}`; // Prevent double prefix
    await channel.setName(newName).catch(() => { });

    await interaction.reply(`👮‍♂️ Ticket claimed by ${interaction.user}`);

    const { modMailService } = await import('../../services/modmailService');
    await modMailService.logModMail(
        interaction.guild,
        '📌 Ticket Claimed',
        `Ticket claimed by ${interaction.user}`,
        [{ name: 'Ticket', value: ticket.userId }] // Could fetch user tag but ID is safe
    );
}

export const command: Command = {
    data,
    execute
};



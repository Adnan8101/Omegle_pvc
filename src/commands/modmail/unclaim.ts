import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    type ChatInputCommandInteraction,
    TextChannel
} from 'discord.js';
import prisma from '../../utils/database';
import type { Command } from '../../client';

const data = new SlashCommandBuilder()
    .setName('unclaim')
    .setDescription('Release the current ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const ticket = await prisma.modMailTicket.findFirst({
        where: {
            channelId: interaction.channelId,
            status: 'CLAIMED'
        }
    });

    if (!ticket) {
        await interaction.reply({ content: '❌ This command can only be used in a CLAIMED ticket.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    // Update DB
    await prisma.modMailTicket.update({
        where: { id: ticket.id },
        data: {
            status: 'OPEN',
            staffClaimedBy: null
        }
    });

    // Rename Channel
    const channel = interaction.channel as TextChannel;
    const newName = channel.name.replace('claimed-', '');
    await channel.setName(newName).catch(() => { });

    await interaction.reply(`👐 Ticket unclaimed by ${interaction.user}. It is now OPEN.`);

    const { modMailService } = await import('../../services/modmailService');
    await modMailService.logModMail(
        interaction.guild,
        '🔓 Ticket Unclaimed',
        `Ticket unclaimed by ${interaction.user}`,
        [{ name: 'Ticket', value: ticket.userId }]
    );
}
export const command: Command = {
    data,
    execute
};

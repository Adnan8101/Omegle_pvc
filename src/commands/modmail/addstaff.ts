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
    .setName('addstaff')
    .setDescription('Add a staff member or role to the ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addMentionableOption(option =>
        option.setName('target')
            .setDescription('User or Role to add')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) return;

    const ticket = await prisma.modMailTicket.findFirst({
        where: {
            channelId: interaction.channelId,
            status: { in: ['OPEN', 'CLAIMED'] }
        }
    });

    if (!ticket) {
        await interaction.reply({ content: '❌ This command can only be used in an active ticket.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    const target = interaction.options.getMentionable('target', true);
    const channel = interaction.channel as TextChannel;

    // Add permissions
    const targetId = (target as any).id;
    await channel.permissionOverwrites.edit(targetId, {
        ViewChannel: true,
        SendMessages: true,
        AttachFiles: true,
        EmbedLinks: true
    });

    await interaction.reply(`✅ Added ${target} to the ticket.`);
}

export const command: Command = {
    data: data as any,
    execute
};

import {
    SlashCommandBuilder,
    CommandInteraction,
    ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
    ButtonStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ComponentType,
    Role,
} from 'discord.js';
import type { Command } from '../client';

const data = new SlashCommandBuilder()
    .setName('banminors')
    .setDescription('Prepare to ban all members with a specific role')
    .addRoleOption(option =>
        option
            .setName('role')
            .setDescription('The role to ban members from')
            .setRequired(true)
    );

async function execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
        await interaction.reply({ content: 'This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });
        return;
    }

    await interaction.deferReply();
    await interaction.guild.members.fetch();

    const role = interaction.options.getRole('role') as Role;

    // Fallback if members size is not available directly (though normally it is in cached roles)
    const memberCount = role.members?.size ?? 'some';

    const embed = new EmbedBuilder()
        .setTitle('Mass Ban Confirmation')
        .setDescription(`Shall I ban all **${memberCount}** members from ${role}?`)
        .setColor(0xFF0000);

    const confirmButton = new ButtonBuilder()
        .setCustomId('fun_ban_confirm')
        .setLabel('Yes, Ban All')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('fun_ban_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(confirmButton, cancelButton);

    const response = await interaction.editReply({
        embeds: [embed],
        components: [row],
    });

    const collector = response.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60000,
    });

    collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
            await i.reply({ content: 'You cannot use these buttons.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        if (i.customId === 'fun_ban_confirm') {
            await i.update({
                content: `Loda lele mc ${interaction.guild?.name || 'server'} Minor se hi chalta`,
                embeds: [],
                components: []
            });
            collector.stop();
        } else if (i.customId === 'fun_ban_cancel') {
            await i.update({ content: 'Cancelled.', embeds: [], components: [] });
            collector.stop();
        }
    });

    collector.on('end', collected => {
        if (collected.size === 0) {
            interaction.editReply({ components: [] }).catch(() => { });
        }
    });
}

export const command: Command = {
    data: data as unknown as import('discord.js').SlashCommandBuilder,
    execute,
};

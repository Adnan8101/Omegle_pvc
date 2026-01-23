import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import type { Command } from '../client';
import { inspect } from 'util';
import prisma from '../utils/database';

const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];

export const command: Command = {
    data: new SlashCommandBuilder()
        .setName('eval')
        .setDescription('Evaluate JavaScript code (Developer only)')
        .addStringOption(option =>
            option
                .setName('code')
                .setDescription('The code to evaluate')
                .setRequired(true)
        ) as SlashCommandBuilder,

    async execute(interaction: ChatInputCommandInteraction) {
        if (!DEVELOPER_IDS.includes(interaction.user.id)) {
            await interaction.reply({
                content: '🚫 This command is restricted to bot developers only.',
                flags: [MessageFlags.Ephemeral],
            });
            return;
        }

        const code = interaction.options.getString('code', true);

        const client = interaction.client;
        const channel = interaction.channel;
        const guild = interaction.guild;
        const member = interaction.member;
        const user = interaction.user;

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            let evaled = await eval(`(async () => { ${code} })()`);

            if (typeof evaled !== 'string') {
                evaled = inspect(evaled, { depth: 2 });
            }

            if (evaled.length > 1900) evaled = evaled.substring(0, 1900) + '...';

            const embed = new EmbedBuilder()
                .setTitle('✅ Eval Result')
                .setDescription(`\`\`\`js\n${evaled}\n\`\`\``)
                .setColor(0x57F287)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error: any) {
            const embed = new EmbedBuilder()
                .setTitle('❌ Eval Error')
                .setDescription(`\`\`\`js\n${error.message || error}\n\`\`\``)
                .setColor(0xFF0000)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        }
    },
};

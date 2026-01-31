import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '../utils/database';

export const command = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency and database connection'),

    async execute(interaction: ChatInputCommandInteraction) {
        const sent = await interaction.deferReply({ fetchReply: true });
        
        // API Latency
        const apiLatency = sent.createdTimestamp - interaction.createdTimestamp;
        
        // WebSocket Latency
        const wsLatency = interaction.client.ws.ping;
        
        // Database Latency
        const dbStart = Date.now();
        try {
            await prisma.$queryRaw`SELECT 1`;
        } catch (e) {
            // Database error
        }
        const dbLatency = Date.now() - dbStart;

        const embed = new EmbedBuilder()
            .setTitle('Pong!')
            .setColor(0x2b2d31)
            .addFields(
                { name: 'API Latency', value: `${apiLatency}ms`, inline: true },
                { name: 'WebSocket Latency', value: `${wsLatency}ms`, inline: true },
                { name: 'Database Latency', value: `${dbLatency}ms`, inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};

export default command;

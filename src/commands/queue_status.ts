import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { CommandInteraction } from 'discord.js';
import { vcQueueService } from '../services/vcQueueService';
export const data = new SlashCommandBuilder()
    .setName('queue_status')
    .setDescription('Check your position in the VC creation queue');
export async function execute(interaction: CommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const request = await vcQueueService.getUserRequest(interaction.user.id, interaction.guildId!);
        if (!request) {
            const embed = new EmbedBuilder()
                .setColor(0x808080)
                .setTitle('❌ Not in Queue')
                .setDescription('You don\'t have any pending VC creation requests.\n\nJoin a VC interface channel to create your voice channel!')
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            return;
        }
        const position = await vcQueueService.getQueuePosition(request.id);
        const queueSize = await vcQueueService.getQueueSize(interaction.guildId!);
        const stats = await vcQueueService.getStats(interaction.guildId || undefined);
        const estimatedWaitSeconds = Math.max(
            position * 3, 
            request.retryCount * 5 
        );
        const embed = new EmbedBuilder()
            .setColor(request.status === 'PROCESSING' ? 0x00FF00 : 0xFFA500)
            .setTitle(`⏳ ${request.status === 'PROCESSING' ? 'Creating Your VC' : 'In Queue'}`)
            .setDescription(
                `**Status:** ${request.status}\n` +
                `**Queue Position:** #${position} of ${queueSize}\n` +
                `**Request Type:** ${request.requestType.replace('_', ' ')}\n` +
                `**Retry Count:** ${request.retryCount}\n` +
                `**Estimated Wait:** ~${estimatedWaitSeconds}s\n\n` +
                (request.lastError 
                    ? `⚠️ **Last Error:** ${request.lastError.substring(0, 100)}...\n\n`
                    : '') +
                `💡 **Tip:** Stay in the interface channel - you'll be moved automatically when ready!`
            )
            .addFields([
                {
                    name: '📊 Server Queue Stats',
                    value: 
                        `Pending: ${stats.pending}\n` +
                        `Processing: ${stats.processing}\n` +
                        `Retrying: ${stats.retrying}\n` +
                        `Completed: ${stats.completed}`,
                    inline: true
                },
                {
                    name: '⏱️ Your Request',
                    value: 
                        `Created: <t:${Math.floor(request.createdAt.getTime() / 1000)}:R>\n` +
                        `Updated: <t:${Math.floor(request.updatedAt.getTime() / 1000)}:R>\n` +
                        `Expires: <t:${Math.floor(request.expiresAt.getTime() / 1000)}:R>`,
                    inline: true
                }
            ])
            .setTimestamp()
            .setFooter({ text: 'Infinite retry enabled - your VC is guaranteed!' });
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[QueueStatus] Error:', error);
        await interaction.editReply({
            content: '❌ Failed to fetch queue status. Please try again.'
        });
    }
}

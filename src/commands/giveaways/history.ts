import { prisma } from '../../utils/database';
import { 
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    AttachmentBuilder,
    PermissionFlagsBits,
    MessageFlags
} from 'discord.js';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
import { Theme } from '../../utils/giveaway/theme';
import ExcelJS from 'exceljs';
const ITEMS_PER_PAGE = 5;
export default {
    data: new SlashCommandBuilder()
        .setName('ghistory')
        .setDescription('View giveaway history for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addBooleanOption(option =>
            option.setName('export')
                .setDescription('Export history to Excel file')
                .setRequired(false)),
    async execute(interaction: ChatInputCommandInteraction) {
        const DEVELOPER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];
        if (!DEVELOPER_IDS.includes(interaction.user.id)) {
            return; 
        }
        const exportToExcel = interaction.options.getBoolean('export') || false;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const guildId = interaction.guildId!;
            const giveaways = await prisma.giveaway.findMany({
                where: { guildId },
                orderBy: { createdAt: 'desc' },
                include: {
                    winners: true
                }
            });
            if (giveaways.length === 0) {
                return interaction.editReply(`${Emojis.CROSS} No giveaway history found for this server.`);
            }
            if (exportToExcel) {
                await this.exportToExcel(interaction, giveaways);
            } else {
                await this.showPaginatedHistory(interaction, giveaways);
            }
        } catch (error: any) {
            let errorMessage = `${Emojis.CROSS} Failed to fetch giveaway history.`;
            if (error.code === 'P2021') {
                errorMessage = `${Emojis.CROSS} Database table not found. Please run migrations.`;
            } else if (error.code === 'P2002') {
                errorMessage = `${Emojis.CROSS} Database constraint error.`;
            } else if (error.message) {
                errorMessage = `${Emojis.CROSS} Failed to fetch giveaway history: ${error.message}`;
            }
            await interaction.editReply(errorMessage);
        }
    },
    async showPaginatedHistory(interaction: ChatInputCommandInteraction, giveaways: any[]) {
        const totalPages = Math.ceil(giveaways.length / ITEMS_PER_PAGE);
        let currentPage = 0;
        const generateEmbed = (page: number) => {
            const start = page * ITEMS_PER_PAGE;
            const end = start + ITEMS_PER_PAGE;
            const pageGiveaways = giveaways.slice(start, end);
            const embed = new EmbedBuilder()
                .setTitle('Giveaway History')
                .setColor(Theme.EmbedColor)
                .setFooter({ text: `Page ${page + 1} of ${totalPages} | Total Giveaways: ${giveaways.length}` })
                .setTimestamp();
            for (const gw of pageGiveaways) {
                const startTime = Math.floor(Number(gw.createdAt) / 1000);
                const endTime = Math.floor(Number(gw.endTime) / 1000);
                const duration = this.formatDuration(Number(gw.endTime) - Number(gw.createdAt));
                const winners = gw.winners.length > 0 
                    ? gw.winners.map((w: any) => `<@${w.userId}>`).join(', ')
                    : 'No winners';
                const status = gw.ended ? 'Ended' : 'Active';
                const forcedWinnersText = gw.forcedWinners 
                    ? gw.forcedWinners.split(',').filter((id: string) => id.trim()).map((id: string) => `<@${id.trim()}>`).join(', ')
                    : 'None';
                const fieldValue = [
                    `**Status:** ${status}`,
                    `**Prize:** ${gw.prize}`,
                    `**Hosted By:** <@${gw.hostId}>`,
                    `**Winners Count:** ${gw.winnersCount}`,
                    `**Winners:** ${winners}`,
                    `**Forced Winners (WS):** ${forcedWinnersText}`,
                    `**Start:** <t:${startTime}:F>`,
                    `**End:** <t:${endTime}:F>`,
                    `**Duration:** ${duration}`,
                    `**Channel:** <#${gw.channelId}>`
                ].join('\n');
                embed.addFields({
                    name: `ID: ${gw.id} | ${gw.prize}`,
                    value: fieldValue,
                    inline: false
                });
            }
            return embed;
        };
        const generateButtons = (page: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('history_first')
                        .setLabel('First')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('history_prev')
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('history_next')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1),
                    new ButtonBuilder()
                        .setCustomId('history_last')
                        .setLabel('Last')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === totalPages - 1),
                    new ButtonBuilder()
                        .setCustomId('history_export')
                        .setLabel('Export to Excel')
                        .setStyle(ButtonStyle.Success)
                );
            return row;
        };
        const embed = generateEmbed(currentPage);
        const buttons = generateButtons(currentPage);
        const response = await interaction.editReply({ 
            embeds: [embed], 
            components: [buttons] 
        });
        const collector = response.createMessageComponentCollector({ 
            time: 600000 
        });
        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: 'These buttons are not for you.', flags: [MessageFlags.Ephemeral] });
            }
            if (i.customId === 'history_export') {
                await i.deferUpdate();
                await this.exportToExcel(interaction, giveaways);
                return;
            }
            if (i.customId === 'history_first') {
                currentPage = 0;
            } else if (i.customId === 'history_prev') {
                currentPage = Math.max(0, currentPage - 1);
            } else if (i.customId === 'history_next') {
                currentPage = Math.min(totalPages - 1, currentPage + 1);
            } else if (i.customId === 'history_last') {
                currentPage = totalPages - 1;
            }
            await i.update({ 
                embeds: [generateEmbed(currentPage)], 
                components: [generateButtons(currentPage)] 
            });
        });
        collector.on('end', async () => {
            try {
                await interaction.editReply({ components: [] });
            } catch (e) {
            }
        });
    },
    async exportToExcel(interaction: ChatInputCommandInteraction, giveaways: any[]) {
        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Giveaway History');
            worksheet.columns = [
                { header: 'ID', key: 'id', width: 10 },
                { header: 'Prize', key: 'prize', width: 30 },
                { header: 'Status', key: 'status', width: 10 },
                { header: 'Hosted By', key: 'hostId', width: 20 },
                { header: 'Winners Count', key: 'winnersCount', width: 15 },
                { header: 'Winners', key: 'winners', width: 40 },
                { header: 'Start Time', key: 'startTime', width: 25 },
                { header: 'End Time', key: 'endTime', width: 25 },
                { header: 'Duration', key: 'duration', width: 15 },
                { header: 'Channel ID', key: 'channelId', width: 20 },
                { header: 'Message ID', key: 'messageId', width: 20 }
            ];
            worksheet.getRow(1).font = { bold: true };
            worksheet.getRow(1).fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF5865F2' }
            };
            for (const gw of giveaways) {
                const startTime = new Date(Number(gw.createdAt));
                const endTime = new Date(Number(gw.endTime));
                const duration = this.formatDuration(Number(gw.endTime) - Number(gw.createdAt));
                const winners = gw.winners.length > 0 
                    ? gw.winners.map((w: any) => w.userId).join(', ')
                    : 'No winners';
                worksheet.addRow({
                    id: gw.id,
                    prize: gw.prize,
                    status: gw.ended ? 'Ended' : 'Active',
                    hostId: gw.hostId,
                    winnersCount: gw.winnersCount,
                    winners: winners,
                    startTime: startTime.toLocaleString(),
                    endTime: endTime.toLocaleString(),
                    duration: duration,
                    channelId: gw.channelId,
                    messageId: gw.messageId
                });
            }
            const buffer = await workbook.xlsx.writeBuffer();
            const attachment = new AttachmentBuilder(Buffer.from(buffer), { 
                name: `giveaway-history-${interaction.guildId}-${Date.now()}.xlsx` 
            });
            await interaction.followUp({ 
                content: `${Emojis.TICK} Exported ${giveaways.length} giveaways to Excel.`,
                files: [attachment],
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            await interaction.followUp({ 
                content: `${Emojis.CROSS} Failed to export to Excel.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }
    },
    formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    },
    async prefixRun(message: any, args: string[]) {
        return message.reply({
            content: `${Emojis.CROSS} Please use the slash command: \`/ghistory\``
        });
    }
};

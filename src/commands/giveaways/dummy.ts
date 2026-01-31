import { prisma } from '../../utils/database';
import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Theme } from '../../utils/giveaway/theme';
import { Emojis } from '../../utils/giveaway/emojis';
import { giveawayEndedEmbed } from '../../utils/giveaway/embeds';

export default {
    data: new SlashCommandBuilder()
        .setName('dummy')
        .setDescription('Preview how giveaway end message will look (without ending giveaway)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option =>
            option.setName('message_id')
                .setDescription('The message ID of the giveaway')
                .setRequired(true)),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }
        await this.run(interaction, interaction.options.getString('message_id', true));
    },

    async prefixRun(message: any, args: string[]) {
        if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return;
        }
        
        if (args.length < 1) {
            const embed = new EmbedBuilder()
                .setDescription(`${Emojis.CROSS} **Usage:** \`!dummy <message_id>\``)
                .setColor(Theme.ErrorColor);
            return message.channel.send({ embeds: [embed] });
        }
        
        await this.run(message, args[0]);
    },

    async run(ctx: any, messageId: string) {
        const isInteraction = !!ctx.options;

        if (isInteraction) {
            await ctx.deferReply({ ephemeral: true });
        }

        try {
            // Fetch giveaway from database
            const giveaway = await prisma.giveaway.findUnique({
                where: { messageId }
            });

            if (!giveaway) {
                const embed = new EmbedBuilder()
                    .setDescription(`${Emojis.CROSS} Giveaway not found with that message ID.`)
                    .setColor(Theme.ErrorColor);
                
                if (isInteraction) {
                    return ctx.editReply({ embeds: [embed] });
                }
                return ctx.channel.send({ embeds: [embed] });
            }

            // Get participants
            const participants = await prisma.giveawayParticipant.findMany({
                where: { giveawayId: giveaway.id },
                select: { userId: true }
            });

            let participantCount = participants.length;

            // Add forced winners to participant count
            if (giveaway.forcedWinners) {
                const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                participantCount += forcedWinnersCount;
            }

            // Check if giveaway already ended and has winners
            let winners: string[];
            if (giveaway.ended) {
                const existingWinners = await prisma.giveawayWinner.findMany({
                    where: { giveawayId: giveaway.id },
                    select: { userId: true }
                });
                winners = existingWinners.map(w => w.userId);
            } else {
                // For active giveaways, check if winners are pre-calculated
                if (giveaway.preCalculatedWinners) {
                    winners = giveaway.preCalculatedWinners.split(',').filter((id: string) => id.trim());
                } else {
                    // Simulate winner selection (dummy - just pick random participants)
                    const participantIds = participants.map(p => p.userId);
                    
                    // Handle forced winners first
                    const forcedWinners: string[] = [];
                    if (giveaway.forcedWinners) {
                        forcedWinners.push(...giveaway.forcedWinners.split(',').filter((id: string) => id.trim()));
                    }

                    // Add random participants to fill remaining winner slots
                    const remainingCount = giveaway.winnersCount - forcedWinners.length;
                    const shuffled = participantIds
                        .filter(id => !forcedWinners.includes(id))
                        .sort(() => 0.5 - Math.random())
                        .slice(0, Math.max(0, remainingCount));

                    winners = [...forcedWinners, ...shuffled];
                }
            }

            // Create the ended giveaway embed (preview)
            const embed = giveawayEndedEmbed(giveaway, winners, participantCount);
            const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';

            // Create winner announcement message (preview)
            let winnerMessage = '';
            if (winners.length > 0) {
                const mentions = winners.map(id => `<@${id}>`).join(", ");
                winnerMessage = `**GIVEAWAY WINNER${winners.length > 1 ? 'S' : ''}**\n\n${mentions}\n\nCongratulations! You won **${giveaway.prize}**!\nHosted by <@${giveaway.hostId}>`;
            } else {
                winnerMessage = `No valid participants for the giveaway: **${giveaway.prize}**`;
            }

            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('Giveaway Link')
                        .setStyle(ButtonStyle.Link)
                        .setURL(`https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`)
                );

            // Create preview info embed
            const previewInfo = new EmbedBuilder()
                .setTitle('🎭 Dummy Giveaway Preview')
                .setDescription(
                    `**This is a preview of how your giveaway will look when it ends.**\n\n` +
                    `${Emojis.TICK} Giveaway Status: ${giveaway.ended ? '**Ended**' : '**Active**'}\n` +
                    `${Emojis.TICK} Total Participants: **${participantCount}**\n` +
                    `${Emojis.TICK} Winners to Select: **${giveaway.winnersCount}**\n` +
                    `${giveaway.preCalculatedWinners ? `${Emojis.TICK} Winners Pre-calculated: **Yes** ✨\n` : ''}\n` +
                    `**Below is how the end message will appear:**`
                )
                .setColor(Theme.EmbedColor)
                .setFooter({ text: 'This is just a preview - original giveaway is NOT affected' });

            // Send preview
            if (isInteraction) {
                await ctx.editReply({
                    embeds: [previewInfo],
                    ephemeral: true
                });
                
                // Send the actual preview in separate messages
                await ctx.followUp({
                    content: `${gwEmoji} **Giveaway Ended** ${gwEmoji}`,
                    embeds: [embed],
                    ephemeral: true
                });

                await ctx.followUp({
                    content: winnerMessage,
                    components: [row],
                    ephemeral: true
                });
            } else {
                await ctx.channel.send({ embeds: [previewInfo] });
                await ctx.channel.send({
                    content: `${gwEmoji} **Giveaway Ended** ${gwEmoji}`,
                    embeds: [embed]
                });
                await ctx.channel.send({
                    content: winnerMessage,
                    components: [row]
                });
            }

        } catch (error) {
            console.error('Dummy preview error:', error);
            const embed = new EmbedBuilder()
                .setDescription(`${Emojis.CROSS} Failed to generate preview. Please check the message ID.`)
                .setColor(Theme.ErrorColor);

            if (isInteraction) {
                return ctx.editReply({ embeds: [embed] });
            }
            return ctx.channel.send({ embeds: [embed] });
        }
    }
};

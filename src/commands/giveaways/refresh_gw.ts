import { prisma } from '../../utils/database';
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits, TextChannel, MessageFlags } from 'discord.js';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Theme } from '../../utils/giveaway/theme';
import { Emojis } from '../../utils/giveaway/emojis';
import { createGiveawayEmbed, giveawayEndedEmbed } from '../../utils/giveaway/embeds';
export default {
    data: new SlashCommandBuilder()
        .setName('refresh_gw')
        .setDescription('Refresh all giveaway embeds with database values')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option =>
            option.setName('target')
                .setDescription('Refresh all giveaways or specific message ID')
                .setRequired(false)
                .addChoices(
                    { name: 'All Giveaways', value: 'all' },
                    { name: 'Specific Message ID', value: 'id' }
                ))
        .addStringOption(option =>
            option.setName('message_id')
                .setDescription('The message ID of the giveaway (if target is "id")')
                .setRequired(false)),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }
        await this.run(interaction);
    },
    async prefixRun(message: any, args: string[]) {
        if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return;
        }
        const target = args[0] || 'all';
        const messageId = args[1];
        await this.run(message, target, messageId);
    },
    async run(ctx: any, targetArg?: string, messageIdArg?: string) {
        const guildId = ctx.guildId!;
        const isInteraction = !!ctx.options;
        let target = targetArg;
        let messageId = messageIdArg;
        if (isInteraction) {
            target = ctx.options.getString('target') || 'all';
            messageId = ctx.options.getString('message_id');
            await ctx.deferReply({ flags: [MessageFlags.Ephemeral] });
        } else {
            target = target || 'all';
        }
        try {
            if (target === 'id' && messageId) {
                const giveaway = await prisma.giveaway.findUnique({
                    where: { messageId }
                });
                if (!giveaway || giveaway.guildId !== guildId) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} Giveaway not found with that message ID in this server.`)
                        .setColor(Theme.ErrorColor);
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
                try {
                    const channel = ctx.client.channels.cache.get(giveaway.channelId) as TextChannel;
                    if (!channel) throw new Error('Channel not found');
                    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
                    if (!message) throw new Error('Message not found');
                    if (giveaway.ended) {
                        const winners = await prisma.giveawayWinner.findMany({
                            where: { giveawayId: giveaway.id },
                            select: { userId: true }
                        });
                        let participantCount = await prisma.giveawayParticipant.count({
                            where: { giveawayId: giveaway.id }
                        });
                        if (giveaway.forcedWinners) {
                            const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                            participantCount += forcedWinnersCount;
                        }
                        const winnerIds = winners.map(w => w.userId);
                        const embed = giveawayEndedEmbed(giveaway, winnerIds, participantCount);
                        const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';
                        await message.edit({
                            content: `${gwEmoji} **Giveaway Ended** ${gwEmoji}`,
                            embeds: [embed]
                        });
                    } else {
                        let participantCount = await prisma.giveawayParticipant.count({
                            where: { giveawayId: giveaway.id }
                        });
                        if (giveaway.forcedWinners) {
                            const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                            participantCount += forcedWinnersCount;
                        }
                        const embed = createGiveawayEmbed(giveaway, participantCount);
                        const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';
                        await message.edit({
                            content: `${gwEmoji} **New Giveaway** ${gwEmoji}`,
                            embeds: [embed]
                        });
                    }
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.TICK} Successfully refreshed giveaway!`)
                        .setColor(Theme.EmbedColor);
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                } catch (error) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} Failed to refresh giveaway. Channel or message not found.`)
                        .setColor(Theme.ErrorColor);
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
            }
            const giveaways = await prisma.giveaway.findMany({
                where: { guildId }
            });
            if (giveaways.length === 0) {
                const embed = new EmbedBuilder()
                    .setDescription(`${Emojis.CROSS} No giveaways found in this server.`)
                    .setColor(Theme.ErrorColor)
                    .setTimestamp();
                if (isInteraction) {
                    return ctx.editReply({ embeds: [embed] });
                }
                return ctx.channel.send({ embeds: [embed] });
            }
            let refreshedCount = 0;
            let failedCount = 0;
            let skippedCount = 0;
            for (const giveaway of giveaways) {
                try {
                    const channel = ctx.client.channels.cache.get(giveaway.channelId) as TextChannel;
                    if (!channel) {
                        failedCount++;
                        continue;
                    }
                    const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
                    if (!message) {
                        failedCount++;
                        continue;
                    }
                    if (giveaway.ended) {
                        const winners = await prisma.giveawayWinner.findMany({
                            where: { giveawayId: giveaway.id },
                            select: { userId: true }
                        });
                        let participantCount = await prisma.giveawayParticipant.count({
                            where: { giveawayId: giveaway.id }
                        });
                        if (giveaway.forcedWinners) {
                            const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                            participantCount += forcedWinnersCount;
                        }
                        const winnerIds = winners.map(w => w.userId);
                        const embed = giveawayEndedEmbed(giveaway, winnerIds, participantCount);
                        const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';
                        await message.edit({
                            content: `${gwEmoji} **Giveaway Ended** ${gwEmoji}`,
                            embeds: [embed]
                        });
                    } else {
                        let participantCount = await prisma.giveawayParticipant.count({
                            where: { giveawayId: giveaway.id }
                        });
                        if (giveaway.forcedWinners) {
                            const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                            participantCount += forcedWinnersCount;
                        }
                        const embed = createGiveawayEmbed(giveaway, participantCount);
                        const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';
                        await message.edit({
                            content: `${gwEmoji} **New Giveaway** ${gwEmoji}`,
                            embeds: [embed]
                        });
                    }
                    refreshedCount++;
                } catch (error) {
                    skippedCount++;
                    continue;
                }
            }
            const resultParts = [];
            if (refreshedCount > 0) {
                resultParts.push(`${Emojis.TICK} Successfully refreshed **${refreshedCount}** giveaway${refreshedCount !== 1 ? 's' : ''}`);
            }
            if (skippedCount > 0) {
                resultParts.push(`⚠️ Skipped **${skippedCount}** giveaway${skippedCount !== 1 ? 's' : ''} (failed to update)`);
            }
            if (failedCount > 0) {
                resultParts.push(`${Emojis.CROSS} Failed **${failedCount}** giveaway${failedCount !== 1 ? 's' : ''} (channel/message not found)`);
            }
            const embed = new EmbedBuilder()
                .setTitle('Giveaway Refresh Complete')
                .setDescription(resultParts.join('\n\n'))
                .setColor(Theme.EmbedColor)
                .setTimestamp()
                .setFooter({ text: `Total: ${giveaways.length} giveaways processed` });
            if (isInteraction) {
                return ctx.editReply({ embeds: [embed] });
            }
            return ctx.channel.send({ embeds: [embed] });
        } catch (error) {
            const embed = new EmbedBuilder()
                .setDescription(`${Emojis.CROSS} Failed to refresh giveaways. Please try again.`)
                .setColor(Theme.ErrorColor)
                .setTimestamp();
            if (isInteraction) {
                return ctx.editReply({ embeds: [embed] });
            }
            return ctx.channel.send({ embeds: [embed] });
        }
    }
};

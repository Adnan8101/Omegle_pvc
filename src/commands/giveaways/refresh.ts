import { prisma } from '../../utils/database';
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits, TextChannel, MessageFlags } from 'discord.js';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Theme } from '../../utils/giveaway/theme';
import { Emojis } from '../../utils/giveaway/emojis';
import { createGiveawayEmbed } from '../../utils/giveaway/embeds';
export default {
    data: new SlashCommandBuilder()
        .setName('grefresh')
        .setDescription('Refresh giveaway embed(s) with updated UI')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option =>
            option.setName('target')
                .setDescription('Refresh all giveaways or specific message ID')
                .setRequired(true)
                .addChoices(
                    { name: 'All Active Giveaways', value: 'all' },
                    { name: 'Specific Message ID', value: 'id' }
                ))
        .addStringOption(option =>
            option.setName('messageid')
                .setDescription('The message ID of the giveaway (only if target is "id")')
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
        const target = args[0]?.toLowerCase();
        if (!target || !['all', 'id'].includes(target)) {
            const embed = new EmbedBuilder()
                .setDescription(`${Emojis.CROSS} **Invalid Usage**\n\`\`\`!grefresh <all|id> [messageId]\`\`\``)
                .setColor(Theme.ErrorColor)
                .setTimestamp();
            return message.channel.send({ embeds: [embed] });
        }
        await this.run(message, target, args[1]);
    },
    async run(ctx: any, target?: string, messageId?: string) {
        const guildId = ctx.guildId!;
        const isInteraction = !!ctx.options;
        if (isInteraction) {
            target = ctx.options.getString('target', true);
            messageId = ctx.options.getString('messageid');
        }
        if (isInteraction) {
            await ctx.deferReply({ flags: [MessageFlags.Ephemeral] });
        }
        try {
            if (target === 'all') {
                const giveaways = await prisma.giveaway.findMany({
                    where: { 
                        guildId, 
                        ended: false 
                    }
                });
                if (giveaways.length === 0) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} No active giveaways found in this server.`)
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
                let refreshedCount = 0;
                let failedCount = 0;
                for (const giveaway of giveaways) {
                    try {
                        const channel = ctx.client.channels.cache.get(giveaway.channelId) as TextChannel;
                        if (!channel) {
                            failedCount++;
                            continue;
                        }
                        const message = await channel.messages.fetch(giveaway.messageId);
                        const participantCount = await prisma.giveawayParticipant.count({
                            where: { giveawayId: giveaway.id }
                        });
                        const embed = createGiveawayEmbed(giveaway, participantCount);
                        await message.edit({ embeds: [embed] });
                        refreshedCount++;
                    } catch (error) {
                        failedCount++;
                    }
                }
                const resultEmbed = new EmbedBuilder()
                    .setDescription(`${Emojis.TICK} Successfully refreshed **${refreshedCount}** giveaway(s).${failedCount > 0 ? `\n⚠️ Failed to refresh **${failedCount}** giveaway(s).` : ''}`)
                    .setColor(Theme.SuccessColor)
                    .setTimestamp();
                if (isInteraction) {
                    return ctx.editReply({ embeds: [resultEmbed] });
                }
                return ctx.channel.send({ embeds: [resultEmbed] });
            } else if (target === 'id') {
                if (!messageId) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} Please provide a message ID when using \`id\` target.\n\`\`\`!grefresh id <messageId>\`\`\``)
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
                const giveaway = await prisma.giveaway.findUnique({
                    where: { messageId }
                });
                if (!giveaway) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} No giveaway found with that message ID.`)
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
                if (giveaway.guildId !== guildId) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} That giveaway is not from this server.`)
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
                try {
                    const channel = ctx.client.channels.cache.get(giveaway.channelId) as TextChannel;
                    if (!channel) {
                        throw new Error('Channel not found');
                    }
                    const message = await channel.messages.fetch(giveaway.messageId);
                    const participantCount = await prisma.giveawayParticipant.count({
                        where: { giveawayId: giveaway.id }
                    });
                    const embed = createGiveawayEmbed(giveaway, participantCount);
                    await message.edit({ embeds: [embed] });
                    const successEmbed = new EmbedBuilder()
                        .setDescription(`${Emojis.TICK} Successfully refreshed giveaway **${giveaway.prize}**\n[Jump to Message](https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId})`)
                        .setColor(Theme.SuccessColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [successEmbed] });
                    }
                    return ctx.channel.send({ embeds: [successEmbed] });
                } catch (error) {
                    const embed = new EmbedBuilder()
                        .setDescription(`${Emojis.CROSS} Failed to refresh giveaway. The message may have been deleted.`)
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    if (isInteraction) {
                        return ctx.editReply({ embeds: [embed] });
                    }
                    return ctx.channel.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            const embed = new EmbedBuilder()
                .setDescription(`${Emojis.CROSS} An error occurred while refreshing giveaways.`)
                .setColor(Theme.ErrorColor)
                .setTimestamp();
            if (isInteraction) {
                return ctx.editReply({ embeds: [embed] });
            }
            return ctx.channel.send({ embeds: [embed] });
        }
    }
};

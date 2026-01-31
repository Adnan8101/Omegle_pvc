import { prisma } from '../../utils/database';
import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, TextChannel } from 'discord.js';
import { createGiveawayEmbed } from '../../utils/giveaway/embeds';
import { hasGiveawayPermissions, hasGiveawayPermissionsMessage } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
import { validateDuration, calculateEndTimeFromString, toBigInt } from '../../utils/giveaway/timeUtils';

const GIVEAWAY_EMOJI = '<a:Exe_Gw:1455059165150974095>';

export default {
    data: new SlashCommandBuilder()
        .setName('gstart')
        .setDescription('Quick start a giveaway - Prize, Winners, Duration')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option => option.setName('prize').setDescription('Prize to give away').setRequired(true))
        .addIntegerOption(option => option.setName('winners').setDescription('Number of winners').setRequired(true))
        .addStringOption(option => option.setName('duration').setDescription('Duration (e.g. 30s, 1m, 1h)').setRequired(true)),

    requiresPermissions: true,

    async checkPermissions(message: any): Promise<boolean> {
        return await hasGiveawayPermissionsMessage(message);
    },

    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }

        const prize = interaction.options.getString('prize', true);
        const winners = interaction.options.getInteger('winners', true);
        const durationStr = interaction.options.getString('duration', true);

        await this.run(interaction, interaction.channel as TextChannel, durationStr, winners, prize);
    },

    async prefixRun(message: any, args: string[]) {
        if (args.length < 3) {
            return message.reply({
                content: `${Emojis.CROSS} **Usage:** \`!gstart <prize> <winners> <duration>\`\n\n**Examples:**\n• \`!gstart Nitro 1 1h\`\n• \`!gstart 100 Inr 1 10m\`\n• \`!gstart Discord Nitro 2 30m\`\n• \`!gstart $50 Gift Card 3 7d\``
            });
        }

        // Last argument should be duration
        const durationStr = args[args.length - 1];
        const validation = validateDuration(durationStr);
        
        if (!validation.isValid) {
            return message.reply({
                content: `${Emojis.CROSS} Invalid duration format: ${durationStr}\n\n**Valid formats:** 30s, 5m, 1h, 7d, 2w`
            });
        }

        // Second to last argument should be winners
        const winnersStr = args[args.length - 2];
        let winners = parseInt(winnersStr);
        
        if (isNaN(winners) || winners < 1) {
            return message.reply({
                content: `${Emojis.CROSS} Invalid winners count: ${winnersStr}\n\nWinners must be a number between 1 and 50.`
            });
        }

        if (winners > 50) winners = 50;

        // Everything else is the prize
        const prize = args.slice(0, args.length - 2).join(' ').trim();
        
        if (!prize) {
            return message.reply({
                content: `${Emojis.CROSS} Please provide a prize name!`
            });
        }

        await this.run(message, message.channel, durationStr, winners, prize);
    },

    async run(ctx: any, channel: TextChannel, durationStr: string, winners: number, prize: string) {
        const validation = validateDuration(durationStr);
        if (!validation.isValid) {
            return ctx.reply?.({ content: `${Emojis.CROSS} ${validation.error}`, ephemeral: true });
        }

        const endTimeMs = calculateEndTimeFromString(durationStr);
        if (!endTimeMs) {
            return ctx.reply?.({ content: `${Emojis.CROSS} Invalid duration. Use: 30s, 2m, 1h, 7d`, ephemeral: true });
        }

        const hostId = ctx.user?.id || ctx.author.id;
        const guildId = ctx.guildId;

        try {
            if (ctx.deferReply) await ctx.deferReply({ ephemeral: true });

            const giveawayData = {
                channelId: channel.id,
                guildId,
                hostId,
                prize,
                winnersCount: winners,
                endTime: toBigInt(endTimeMs),
                createdAt: toBigInt(Date.now()),
                emoji: GIVEAWAY_EMOJI
            };

            // Create temporary object for embed with required fields
            const gForEmbed: any = { ...giveawayData, messageId: '', id: 0 };
            const embed = createGiveawayEmbed(gForEmbed, 0);
            const message = await channel.send({ content: `${GIVEAWAY_EMOJI} **New Giveaway** ${GIVEAWAY_EMOJI}`, embeds: [embed] });
            await message.react(GIVEAWAY_EMOJI);

            await prisma.giveaway.create({
                data: { ...giveawayData, messageId: message.id }
            });

            const successMsg = `${Emojis.TICK} Giveaway started in ${channel}!`;

            if (ctx.editReply) {
                await ctx.editReply(successMsg);
            } else {
                const reply = await ctx.reply(successMsg);
                setTimeout(() => {
                    ctx.delete?.().catch(() => { });
                    reply.delete?.().catch(() => { });
                }, 3000);
            }
        } catch (error) {
            const failMsg = `${Emojis.CROSS} Failed to start giveaway.`;
            if (ctx.editReply) await ctx.editReply(failMsg);
            else await ctx.reply?.(failMsg);
        }
    }
};

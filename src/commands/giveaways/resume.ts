import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
import { prisma } from '../../utils/database';
export default {
    data: new SlashCommandBuilder()
        .setName('gresume')
        .setDescription('Resume a paused giveaway')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option =>
            option.setName('message_id')
                .setDescription('The message ID of the giveaway')
                .setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }
        const messageId = interaction.options.getString('message_id', true);
        try {
            const giveaway = await prisma.giveaway.findUnique({
                where: { messageId }
            });
            if (!giveaway) {
                return interaction.reply({
                    content: `${Emojis.CROSS} Giveaway not found.`,
                    flags: [MessageFlags.Ephemeral]
                });
            }
            if (giveaway.ended) {
                return interaction.reply({
                    content: `${Emojis.CROSS} This giveaway has already ended.`,
                    flags: [MessageFlags.Ephemeral]
                });
            }
            if (!(giveaway as any).paused) {
                return interaction.reply({
                    content: `${Emojis.CROSS} This giveaway is not paused or pause feature not available.`,
                    flags: [MessageFlags.Ephemeral]
                });
            }
            const pauseDuration = Date.now() - Number((giveaway as any).pausedAt || Date.now());
            const newEndTime = Number(giveaway.endTime) + pauseDuration;
            await prisma.giveaway.update({
                where: { messageId },
                data: {
                    ...(giveaway.hasOwnProperty('paused') ? {
                        paused: false,
                        pausedAt: null
                    } : {}),
                    endTime: BigInt(newEndTime)
                } as any
            });
            await interaction.reply({
                content: `${Emojis.TICK} Giveaway resumed successfully. The end time has been extended.`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error: any) {
            await interaction.reply({
                content: `${Emojis.CROSS} Failed to resume giveaway: ${error.message}`,
                flags: [MessageFlags.Ephemeral]
            });
        }
    },
    async prefixRun(message: any, args: string[]) {
        if (!message.member?.permissions.has('ManageGuild')) {
            return;
        }
        if (args.length === 0) {
            return message.reply(`${Emojis.CROSS} Usage: \`!gresume <message_id>\``);
        }
        const messageId = args[0];
        try {
            const giveaway = await prisma.giveaway.findUnique({
                where: { messageId }
            });
            if (!giveaway) {
                return message.reply(`${Emojis.CROSS} Giveaway not found.`);
            }
            if (giveaway.ended) {
                return message.reply(`${Emojis.CROSS} This giveaway has already ended.`);
            }
            if (!(giveaway as any).paused) {
                return message.reply(`${Emojis.CROSS} This giveaway is not paused or pause feature not available.`);
            }
            const pauseDuration = Date.now() - Number((giveaway as any).pausedAt || Date.now());
            const newEndTime = Number(giveaway.endTime) + pauseDuration;
            await prisma.giveaway.update({
                where: { messageId },
                data: {
                    ...(giveaway.hasOwnProperty('paused') ? {
                        paused: false,
                        pausedAt: null
                    } : {}),
                    endTime: BigInt(newEndTime)
                } as any
            });
            const reply = await message.reply(`${Emojis.TICK} Giveaway resumed successfully. The end time has been extended.`);
            setTimeout(async () => {
                try {
                    await message.delete().catch(() => {});
                    await reply.delete().catch(() => {});
                } catch (e) {}
            }, 3000);
        } catch (error: any) {
            await message.reply(`${Emojis.CROSS} Failed to resume giveaway: ${error.message}`);
        }
    }
};

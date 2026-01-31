import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { GiveawayService } from '../../services/GiveawayService';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';

export default {
    data: new SlashCommandBuilder()
        .setName('greroll')
        .setDescription('Reroll a winner for an ended giveaway')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option => option.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true)),

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
        if (args.length < 1) return message.reply(`${Emojis.CROSS} Usage: \`!greroll <message_id>\``);
        await this.run(message, args[0]);
    },

    async run(ctx: any, messageId: string) {
        try {
            const service = new GiveawayService(ctx.client);
            const winners = await service.rerollGiveaway(messageId);

            if (winners.length > 0) {
                await ctx.reply?.({ content: `${Emojis.TICK} Successfully rerolled!`, flags: [MessageFlags.Ephemeral] });
                setTimeout(() => ctx.deleteReply?.().catch(() => { }), 3000);
            } else {
                await ctx.reply?.({ content: `${Emojis.CROSS} Could not find a new winner.`, flags: [MessageFlags.Ephemeral] });
            }
        } catch (error: any) {
            await ctx.reply?.({ content: `${Emojis.CROSS} ${error.message || 'Failed to reroll.'}`, flags: [MessageFlags.Ephemeral] });
        }
    }
};

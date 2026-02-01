import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { GiveawayService } from '../../services/GiveawayService';
import { hasGiveawayPermissions, hasGiveawayPermissionsMessage } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
export default {
    data: new SlashCommandBuilder()
        .setName('gend')
        .setDescription('End a giveaway immediately')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option => option.setName('message_id').setDescription('Message ID of the giveaway').setRequired(true)),
    requiresPermissions: true,
    async checkPermissions(message: any): Promise<boolean> {
        return await hasGiveawayPermissionsMessage(message);
    },
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }
        await this.run(interaction, interaction.options.getString('message_id', true));
    },
    async prefixRun(message: any, args: string[]) {
        if (args.length < 1) return message.reply(`${Emojis.CROSS} Usage: \`!gend <message_id>\``);
        await this.run(message, args[0]);
    },
    async run(ctx: any, messageId: string) {
        try {
            const service = new GiveawayService(ctx.client);
            await service.endGiveaway(messageId);
            await ctx.reply?.({ content: `${Emojis.TICK} Giveaway ended.`, flags: [MessageFlags.Ephemeral] });
        } catch (error) {
            await ctx.reply?.({ content: `${Emojis.CROSS} Failed to end giveaway. Check ID.`, flags: [MessageFlags.Ephemeral] });
        }
    }
};

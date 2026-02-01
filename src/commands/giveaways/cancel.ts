import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { GiveawayService } from '../../services/GiveawayService';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
export default {
    data: new SlashCommandBuilder()
        .setName('gcancel')
        .setDescription('Cancel a giveaway')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option => option.setName('message_id').setDescription('The message ID of the giveaway').setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }
        try {
            const service = new GiveawayService(interaction.client);
            await service.cancelGiveaway(interaction.options.getString('message_id', true));
            await interaction.reply({ content: `${Emojis.TICK} Giveaway cancelled.`, flags: [MessageFlags.Ephemeral] });
        } catch (error: any) {
            await interaction.reply({ content: `${Emojis.CROSS} ${error.message}`, flags: [MessageFlags.Ephemeral] });
        }
    },
    async prefixRun(message: any, args: string[]) {
        if (!message.member?.permissions.has('ManageGuild')) {
            return;
        }
        if (args.length === 0) return message.reply(`${Emojis.CROSS} Usage: \`!gcancel <message_id>\``);
        try {
            const service = new GiveawayService(message.client);
            await service.cancelGiveaway(args[0]);
            const reply = await message.reply(`${Emojis.TICK} Giveaway cancelled.`);
            setTimeout(() => {
                message.delete?.().catch(() => { });
                reply.delete?.().catch(() => { });
            }, 3000);
        } catch (error: any) {
            await message.reply(`${Emojis.CROSS} ${error.message}`);
        }
    }
};

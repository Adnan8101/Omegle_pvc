import { prisma } from '../../utils/database';

import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType, TextChannel, EmbedBuilder, MessageFlags } from 'discord.js';
import { createGiveawayEmbed } from '../../utils/giveaway/embeds';
import { hasGiveawayPermissions } from '../../utils/giveaway/permissions';
import { Emojis } from '../../utils/giveaway/emojis';
import {
    parseDuration,
    validateDuration,
    calculateEndTimeFromString,
    toBigInt,
    formatDuration
} from '../../utils/giveaway/timeUtils';


export default {
    data: new SlashCommandBuilder()
        .setName('gcreate')
        .setDescription('Start a new giveaway')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

        .addStringOption(option =>
            option.setName('prize')
                .setDescription('Prize to give away')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('winners')
                .setDescription('Number of winners')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Duration (e.g. 10m, 1h, 2d)')
                .setRequired(true))

        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('Channel to host the giveaway in (default: current channel)')
                .addChannelTypes(ChannelType.GuildText))

        .addRoleOption(option =>
            option.setName('role_requirement')
                .setDescription('Required role to enter'))
        .addIntegerOption(option =>
            option.setName('invite_requirement')
                .setDescription('Minimum invites required'))
        .addBooleanOption(option =>
            option.setName('captcha')
                .setDescription('Require captcha verification'))
        .addIntegerOption(option =>
            option.setName('message_required')
                .setDescription('Minimum messages required to enter'))
        .addIntegerOption(option =>
            option.setName('voice')
                .setDescription('Minimum voice minutes required'))

        .addRoleOption(option =>
            option.setName('winner_role')
                .setDescription('Role to give to winners'))
        .addRoleOption(option =>
            option.setName('assign_role')
                .setDescription('Role to assign to participants'))

        .addStringOption(option =>
            option.setName('custom_message')
                .setDescription('Custom message to display in giveaway'))
        .addStringOption(option =>
            option.setName('thumbnail')
                .setDescription('URL for giveaway thumbnail'))
        .addStringOption(option =>
            option.setName('custom_emoji')
                .setDescription('Custom emoji for giveaway reaction'))
        .addStringOption(option =>
            option.setName('increase_chance')
                .setDescription('Increase winning chances for specific groups')
                .addChoices(
                    { name: 'Role (members with specific role)', value: 'role' },
                    { name: 'Booster (server boosters)', value: 'booster' },
                    { name: 'Role + Booster (highest chance)', value: 'role_booster' }
                ))
        .addRoleOption(option =>
            option.setName('increase_chance_role')
                .setDescription('Role for increased chances (required if increase_chance is role or role_booster)')),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!await hasGiveawayPermissions(interaction)) {
            return;
        }

        const prize = interaction.options.getString('prize', true);
        const winners = interaction.options.getInteger('winners', true);
        const durationStr = interaction.options.getString('duration', true);
        const channel = interaction.options.getChannel('channel') as TextChannel || interaction.channel as TextChannel;


        const validation = validateDuration(durationStr);
        if (!validation.isValid) {
            return interaction.reply({
                content: `${Emojis.CROSS} ${validation.error}`,
                flags: [MessageFlags.Ephemeral]
            });
        }


        const endTimeMs = calculateEndTimeFromString(durationStr);
        if (!endTimeMs) {
            return interaction.reply({
                content: `${Emojis.CROSS} Invalid duration format. Use: 30s, 2m, 1h, 7d`,
                flags: [MessageFlags.Ephemeral]
            });
        }

        if (winners < 1) {
            return interaction.reply({ content: `${Emojis.CROSS} Invalid number of winners.`, flags: [MessageFlags.Ephemeral] });
        }


        const roleReq = interaction.options.getRole('role_requirement');
        const inviteReq = interaction.options.getInteger('invite_requirement') || 0;
        const accountAgeReq = interaction.options.getInteger('account_age') || 0;
        const serverAgeReq = interaction.options.getInteger('server_age') || 0;
        const captchaReq = interaction.options.getBoolean('captcha') || false;
        const messageReq = interaction.options.getInteger('message_required') || 0;
        const voiceReq = interaction.options.getInteger('voice') || 0;
        const customMessage = interaction.options.getString('custom_message');
        const assignRole = interaction.options.getRole('assign_role');
        const winnerRole = interaction.options.getRole('winner_role');
        const thumbnail = interaction.options.getString('thumbnail');
        const customEmoji = interaction.options.getString('custom_emoji') || "<a:Exe_Gw:1455059165150974095>";
        const increaseChance = interaction.options.getString('increase_chance') || null;
        const increaseChanceRole = interaction.options.getRole('increase_chance_role');

        // Validate increase_chance_role requirement
        if (increaseChance && (increaseChance === 'role' || increaseChance === 'role_booster') && !increaseChanceRole) {
            return interaction.reply({
                content: `${Emojis.CROSS} You must select a role for \`increase_chance_role\` when using role-based increased chances.`,
                flags: [MessageFlags.Ephemeral]
            });
        }

        const giveawayData = {
            channelId: channel.id,
            guildId: interaction.guildId!,
            hostId: interaction.user.id,
            prize: prize,
            winnersCount: winners,
            endTime: toBigInt(endTimeMs),
            createdAt: toBigInt(Date.now()),
            roleRequirement: roleReq?.id || null,
            inviteRequirement: inviteReq,
            accountAgeRequirement: accountAgeReq,
            serverAgeRequirement: serverAgeReq,
            captchaRequirement: captchaReq,
            messageRequired: messageReq,
            voiceRequirement: voiceReq,
            customMessage: customMessage || null,
            assignRole: assignRole?.id || null,
            winnerRole: winnerRole?.id || null,
            thumbnail: thumbnail || null,
            emoji: customEmoji,
            increaseChance: increaseChance,
            increaseChanceRole: increaseChanceRole?.id || null
        };

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const gForEmbed: any = { ...giveawayData, messageId: "", id: 0 };
            const embed = createGiveawayEmbed(gForEmbed, 0);

            const message = await channel.send({ content: `${customEmoji} **New Giveaway** ${customEmoji}`, embeds: [embed] });
            await message.react(customEmoji);


            const giveaway = await prisma.giveaway.create({
                data: {
                    ...giveawayData,
                    messageId: message.id
                }
            });

            const reply = await interaction.editReply(`${Emojis.TICK} Giveaway created successfully in ${channel}!`);

            setTimeout(async () => {
                try {
                    await interaction.deleteReply().catch(() => { });
                } catch (e) { }
            }, 3000);

        } catch (error) {
            await interaction.editReply(`${Emojis.CROSS} Failed to create giveaway.`);
        }
    },

    async prefixRun(message: any, args: string[]) {

        const command = message.client.application.commands.cache.find((c: any) => c.name === 'gcreate');
        const commandId = command ? command.id : '0';



        await message.reply({
            content: `${Emojis.CROSS} The \`!gcreate\` command has been moved to slash commands only.\n\nPlease use </gcreate:${commandId}> instead!`
        });
    }
};

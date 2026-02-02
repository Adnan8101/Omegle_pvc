import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import prisma from '../utils/database';
const DEVELOPER_IDS = [
    '929297205796417597', 
];
export default {
    data: new SlashCommandBuilder()
        .setName('cleardata')
        .setDescription('[DEV ONLY] Emergency database cleanup - removes all PVC/Team data')
        .addStringOption(option =>
            option
                .setName('confirm')
                .setDescription('Type "CONFIRM DELETE ALL" to proceed')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction: ChatInputCommandInteraction) {
        if (!DEVELOPER_IDS.includes(interaction.user.id)) {
            return interaction.reply({
                content: '❌ This command is only available to developers.',
                ephemeral: true,
            });
        }
        const confirmation = interaction.options.getString('confirm', true);
        if (confirmation !== 'CONFIRM DELETE ALL') {
            return interaction.reply({
                content: '❌ Invalid confirmation. You must type exactly: `CONFIRM DELETE ALL`',
                ephemeral: true,
            });
        }
        await interaction.deferReply({ ephemeral: true });
        try {
            console.log(`[ClearData] 🚨 Emergency database clear initiated by ${interaction.user.tag} (${interaction.user.id})`);
            const [pvcCount, teamCount, pvcPermCount, teamPermCount, ownerPermCount] = await Promise.all([
                prisma.privateVoiceChannel.count(),
                prisma.teamVoiceChannel.count(),
                prisma.voicePermission.count(),
                prisma.teamVoicePermission.count(),
                prisma.ownerPermission.count(),
            ]);
            console.log(`[ClearData] 📊 Records to delete: ${pvcCount} PVCs, ${teamCount} Teams, ${pvcPermCount} PVC perms, ${teamPermCount} Team perms, ${ownerPermCount} Owner perms`);
            await prisma.$transaction([
                prisma.voicePermission.deleteMany({}),
                prisma.teamVoicePermission.deleteMany({}),
                prisma.ownerPermission.deleteMany({}),
                prisma.privateVoiceChannel.deleteMany({}),
                prisma.teamVoiceChannel.deleteMany({}),
            ]);
            console.log(`[ClearData] ✅ All voice channel data cleared from database`);
            const { clearGuildState, clearAllChannels } = await import('../utils/voiceManager');
            const { stateStore } = await import('../vcns/index');
            clearAllChannels();
            clearGuildState(interaction.guildId!);
            stateStore.clearGuild(interaction.guildId!);
            console.log(`[ClearData] ✅ All memory state cleared`);
            await interaction.editReply({
                content: [
                    '✅ **Emergency database cleanup completed!**',
                    '',
                    '📊 **Deleted:**',
                    `• ${pvcCount} Private Voice Channels`,
                    `• ${teamCount} Team Voice Channels`,
                    `• ${pvcPermCount} PVC Permissions`,
                    `• ${teamPermCount} Team Permissions`,
                    `• ${ownerPermCount} Owner Permissions`,
                    '',
                    '🧹 **Memory state cleared**',
                    '',
                    '⚠️ **Note:** Discord channels still exist. Use `/refresh_pvc` to re-register existing channels, or delete them manually.'
                ].join('\n'),
            });
        } catch (error: any) {
            console.error(`[ClearData] ❌ Error during database clear:`, error);
            await interaction.editReply({
                content: `❌ **Error during database clear:**\n\`\`\`${error.message}\`\`\``,
            });
        }
    },
};

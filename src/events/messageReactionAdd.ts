import { type MessageReaction, type User, EmbedBuilder, PartialMessageReaction, PartialUser } from 'discord.js';
import prisma from '../utils/database';
import { safeSetChannelName } from '../utils/discordApi';
import { logAction, LogAction } from '../utils/logger';

export async function handleMessageReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Fetch partial data if needed
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch {
            return;
        }
    }

    if (user.partial) {
        try {
            await user.fetch();
        } catch {
            return;
        }
    }

    // Check if this is a checkmark reaction
    if (reaction.emoji.name !== '✅') return;

    const message = reaction.message;
    if (!message.guild) return;

    // Check if this message is a pending rename request
    const pendingRequest = await prisma.pendingRenameRequest.findUnique({
        where: { messageId: message.id },
    });

    if (!pendingRequest) return;

    // Verify reactor has staff role
    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: message.guild.id },
    });

    if (!settings?.staffRoleId) return;

    const member = await message.guild.members.fetch(user.id as string);
    if (!member.roles.cache.has(settings.staffRoleId)) {
        // Not a staff member, ignore reaction
        return;
    }

    // Staff approved! Process rename
    await prisma.pendingRenameRequest.delete({ where: { id: pendingRequest.id } });

    const result = await safeSetChannelName(message.guild, pendingRequest.channelId, pendingRequest.newName);

    const approvedEmbed = new EmbedBuilder()
        .setTitle('✅ Rename Approved')
        .setDescription(
            `**User:** <@${pendingRequest.userId}>\n` +
            `**New Name:** ${pendingRequest.newName}\n` +
            `**Approved by:** <@${user.id}>`
        )
        .setColor(0x00FF00)
        .setFooter({ text: `Approved by ${user.username}` })
        .setTimestamp();

    await message.edit({ embeds: [approvedEmbed] });

    await logAction({
        action: LogAction.RENAME_APPROVED,
        guild: message.guild,
        user: user as User,
        channelId: pendingRequest.channelId,
        targetUser: { id: pendingRequest.userId } as any,
        details: `Renamed to "${pendingRequest.newName}" - Approved by ${user.username}`,
    });
}

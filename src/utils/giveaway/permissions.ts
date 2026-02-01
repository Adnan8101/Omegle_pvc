import { prisma } from '../database';
import { CommandInteraction, PermissionFlagsBits, GuildMember, Message } from 'discord.js';
export async function hasGiveawayPermissions(interaction: CommandInteraction): Promise<boolean> {
    const member = interaction.member as GuildMember;
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }
    const config = await prisma.giveawayConfig.findUnique({
        where: { guildId: interaction.guildId! }
    });
    if (config?.managerRole && member.roles.cache.has(config.managerRole)) {
        return true;
    }
    return false;
}
export async function hasGiveawayPermissionsMessage(message: Message): Promise<boolean> {
    if (!message.member || !message.guildId) return false;
    if (message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return true;
    }
    const config = await prisma.giveawayConfig.findUnique({
        where: { guildId: message.guildId }
    });
    if (config?.managerRole && message.member.roles.cache.has(config.managerRole)) {
        return true;
    }
    return false;
}

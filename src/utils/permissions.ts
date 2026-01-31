import { PermissionsBitField, type VoiceChannel, type GuildMember, type ChatInputCommandInteraction } from 'discord.js';
const BOT_DEVELOPER_ID = '929297205796417597';
const AUTHORIZED_USER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];
export interface PermissionDiff {
    targetId: string;
    allow: bigint;
    deny: bigint;
}
export async function canRunAdminCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild || !interaction.member) {
        return false;
    }
    if (interaction.user.id === BOT_DEVELOPER_ID) {
        return true;
    }
    const member = interaction.member as GuildMember;
    const botMember = await interaction.guild.members.fetchMe();
    const userHighestRole = member.roles.highest;
    const botHighestRole = botMember.roles.highest;
    return userHighestRole.position > botHighestRole.position;
}
export async function canToggleStrictness(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild || !interaction.member) {
        return false;
    }
    if (interaction.guild.ownerId === interaction.user.id) {
        return true;
    }
    if (AUTHORIZED_USER_IDS.includes(interaction.user.id)) {
        return true;
    }
    return false;
}
export function calculatePermissionDiff(
    channel: VoiceChannel,
    targetId: string,
    desiredAllow: bigint,
    desiredDeny: bigint
): PermissionDiff | null {
    const existing = channel.permissionOverwrites.cache.get(targetId);
    if (!existing) {
        if (desiredAllow !== 0n || desiredDeny !== 0n) {
            return { targetId, allow: desiredAllow, deny: desiredDeny };
        }
        return null;
    }
    const currentAllow = existing.allow.bitfield;
    const currentDeny = existing.deny.bitfield;
    if (currentAllow === desiredAllow && currentDeny === desiredDeny) {
        return null;
    }
    return { targetId, allow: desiredAllow, deny: desiredDeny };
}
export function getLockPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.Connect,
    };
}
export function getUnlockPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: 0n,
    };
}
export function getHidePermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.ViewChannel,
    };
}
export function getUnhidePermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: 0n,
    };
}
export function getPermitPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.Connect |
            PermissionsBitField.Flags.SendMessages | PermissionsBitField.Flags.EmbedLinks |
            PermissionsBitField.Flags.AttachFiles,
        deny: 0n,
    };
}
export function getBanPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.Connect,
    };
}
export function getOwnerPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow:
            PermissionsBitField.Flags.ViewChannel |
            PermissionsBitField.Flags.Connect |
            PermissionsBitField.Flags.Speak |
            PermissionsBitField.Flags.Stream |
            PermissionsBitField.Flags.SendMessages |
            PermissionsBitField.Flags.EmbedLinks |
            PermissionsBitField.Flags.AttachFiles |
            PermissionsBitField.Flags.MuteMembers |
            PermissionsBitField.Flags.DeafenMembers |
            PermissionsBitField.Flags.ManageChannels,
        deny: 0n,
    };
}

import { PermissionsBitField, type VoiceChannel, type GuildMember, type ChatInputCommandInteraction } from 'discord.js';

const BOT_DEVELOPER_ID = '929297205796417597';
const AUTHORIZED_USER_IDS = ['929297205796417597', '1267528540707098779', '1305006992510947328'];

export interface PermissionDiff {
    targetId: string;
    allow: bigint;
    deny: bigint;
}

/**
 * Check if user can run admin commands.
 * Allowed if:
 * 1. User is the bot developer
 * 2. User's highest role is above the bot's highest role
 */
export async function canRunAdminCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild || !interaction.member) {
        return false;
    }

    // Bot developer has full access
    if (interaction.user.id === BOT_DEVELOPER_ID) {
        return true;
    }

    const member = interaction.member as GuildMember;
    const botMember = await interaction.guild.members.fetchMe();

    // Get highest role positions
    const userHighestRole = member.roles.highest;
    const botHighestRole = botMember.roles.highest;

    // User's role must be higher than bot's role
    return userHighestRole.position > botHighestRole.position;
}

/**
 * Check if user can toggle admin strictness.
 * Allowed if:
 * 1. User is the server owner
 * 2. User is one of the 3 authorized users (bot dev + 2 others)
 */
export async function canToggleStrictness(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guild || !interaction.member) {
        return false;
    }

    // Check if user is server owner
    if (interaction.guild.ownerId === interaction.user.id) {
        return true;
    }

    // Check if user is one of the authorized users
    if (AUTHORIZED_USER_IDS.includes(interaction.user.id)) {
        return true;
    }

    return false;
}

/**
 * Calculates permission differences to minimize API calls.
 * Only returns changes that need to be applied.
 */
export function calculatePermissionDiff(
    channel: VoiceChannel,
    targetId: string,
    desiredAllow: bigint,
    desiredDeny: bigint
): PermissionDiff | null {
    const existing = channel.permissionOverwrites.cache.get(targetId);

    if (!existing) {
        // No existing override, need to create
        if (desiredAllow !== 0n || desiredDeny !== 0n) {
            return { targetId, allow: desiredAllow, deny: desiredDeny };
        }
        return null;
    }

    const currentAllow = existing.allow.bitfield;
    const currentDeny = existing.deny.bitfield;

    // Check if any change is needed
    if (currentAllow === desiredAllow && currentDeny === desiredDeny) {
        return null;
    }

    return { targetId, allow: desiredAllow, deny: desiredDeny };
}

/**
 * Lock a voice channel - prevents anyone from joining
 */
export function getLockPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.Connect,
    };
}

/**
 * Unlock a voice channel - restores join access
 */
export function getUnlockPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: 0n,
    };
}

/**
 * Hide a voice channel - makes it invisible
 */
export function getHidePermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.ViewChannel,
    };
}

/**
 * Unhide a voice channel - restores visibility
 */
export function getUnhidePermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: 0n,
    };
}

/**
 * Get permissions for a permitted user/role
 */
export function getPermitPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.Connect,
        deny: 0n,
    };
}

/**
 * Get permissions for a banned user/role
 */
export function getBanPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow: 0n,
        deny: PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.Connect,
    };
}

/**
 * Get owner permissions for a private voice channel
 */
export function getOwnerPermissions(): { allow: bigint; deny: bigint } {
    return {
        allow:
            PermissionsBitField.Flags.ViewChannel |
            PermissionsBitField.Flags.Connect |
            PermissionsBitField.Flags.Speak |
            PermissionsBitField.Flags.Stream |
            PermissionsBitField.Flags.MuteMembers |
            PermissionsBitField.Flags.DeafenMembers |
            PermissionsBitField.Flags.MoveMembers |
            PermissionsBitField.Flags.ManageChannels,
        deny: 0n,
    };
}

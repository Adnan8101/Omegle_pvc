import { PermissionsBitField, type VoiceChannel } from 'discord.js';

export interface PermissionDiff {
    targetId: string;
    allow: bigint;
    deny: bigint;
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

/**
 * Safe Discord API Wrappers
 * Validates resources before API calls and returns graceful errors
 */

import { ChannelType, type VoiceChannel, type Guild, type GuildMember, DiscordAPIError } from 'discord.js';
import { executeWithRateLimit } from './rateLimit';
import { unregisterChannel } from './voiceManager';
import prisma from './database';

// Result type for safe operations
export interface SafeResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    code?: number;
}

// Known Discord error codes
const DISCORD_ERRORS = {
    UNKNOWN_CHANNEL: 10003,
    UNKNOWN_GUILD: 10004,
    UNKNOWN_MEMBER: 10007,
    UNKNOWN_USER: 10013,
    MISSING_PERMISSIONS: 50013,
    RATE_LIMITED: 429,
};

/**
 * Check if a channel exists and is a voice channel
 */
export async function validateVoiceChannel(guild: Guild, channelId: string): Promise<VoiceChannel | null> {
    try {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            // Try to fetch from API
            const fetched = await guild.channels.fetch(channelId).catch(() => null);
            if (!fetched || fetched.type !== ChannelType.GuildVoice) {
                await cleanupStaleChannel(channelId);
                return null;
            }
            return fetched as VoiceChannel;
        }
        if (channel.type !== ChannelType.GuildVoice) return null;
        return channel as VoiceChannel;
    } catch {
        await cleanupStaleChannel(channelId);
        return null;
    }
}

/**
 * Remove stale channel from database and memory
 */
async function cleanupStaleChannel(channelId: string): Promise<void> {
    unregisterChannel(channelId);
    await prisma.privateVoiceChannel.delete({
        where: { channelId },
    }).catch(() => { }); // Ignore if already deleted
}

/**
 * Safely edit a voice channel's name
 */
export async function safeSetChannelName(
    guild: Guild,
    channelId: string,
    name: string
): Promise<SafeResult<VoiceChannel>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        return { success: false, error: 'Channel no longer exists', code: DISCORD_ERRORS.UNKNOWN_CHANNEL };
    }

    try {
        const result = await executeWithRateLimit(`edit:${channelId}`, () =>
            channel.setName(name)
        );
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely edit a voice channel's permissions
 */
export async function safeEditPermissions(
    guild: Guild,
    channelId: string,
    targetId: string,
    permissions: any
): Promise<SafeResult<void>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        return { success: false, error: 'Channel no longer exists', code: DISCORD_ERRORS.UNKNOWN_CHANNEL };
    }

    try {
        await executeWithRateLimit(`perms:${channelId}`, () =>
            channel.permissionOverwrites.edit(targetId, permissions)
        );
        return { success: true };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely delete a voice channel
 */
export async function safeDeleteChannel(
    guild: Guild,
    channelId: string
): Promise<SafeResult<void>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        // Channel already gone, just clean up DB
        await cleanupStaleChannel(channelId);
        return { success: true };
    }

    try {
        await executeWithRateLimit(`delete:${channelId}`, () =>
            channel.delete()
        );
        await cleanupStaleChannel(channelId);
        return { success: true };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely set user limit on channel
 */
export async function safeSetUserLimit(
    guild: Guild,
    channelId: string,
    limit: number
): Promise<SafeResult<VoiceChannel>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        return { success: false, error: 'Channel no longer exists', code: DISCORD_ERRORS.UNKNOWN_CHANNEL };
    }

    try {
        const result = await executeWithRateLimit(`edit:${channelId}`, () =>
            channel.setUserLimit(limit)
        );
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely set bitrate on channel
 */
export async function safeSetBitrate(
    guild: Guild,
    channelId: string,
    bitrate: number
): Promise<SafeResult<VoiceChannel>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        return { success: false, error: 'Channel no longer exists', code: DISCORD_ERRORS.UNKNOWN_CHANNEL };
    }

    try {
        const result = await executeWithRateLimit(`edit:${channelId}`, () =>
            channel.setBitrate(bitrate)
        );
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely set RTC region on channel
 */
export async function safeSetRegion(
    guild: Guild,
    channelId: string,
    region: string | null
): Promise<SafeResult<VoiceChannel>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        return { success: false, error: 'Channel no longer exists', code: DISCORD_ERRORS.UNKNOWN_CHANNEL };
    }

    try {
        const result = await executeWithRateLimit(`edit:${channelId}`, () =>
            channel.setRTCRegion(region)
        );
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}

/**
 * Safely disconnect a member
 */
export async function safeDisconnectMember(
    member: GuildMember
): Promise<SafeResult<void>> {
    try {
        await executeWithRateLimit(`disconnect:${member.id}`, () =>
            member.voice.disconnect()
        );
        return { success: true };
    } catch (error) {
        const discordError = error as DiscordAPIError;
        return {
            success: false,
            error: discordError.message || 'Failed to disconnect member',
            code: discordError.code as number,
        };
    }
}

/**
 * Handle Discord API errors gracefully
 */
function handleDiscordError(error: unknown, channelId?: string): SafeResult<any> {
    const discordError = error as DiscordAPIError;

    // Unknown channel - clean up stale data
    if (discordError.code === DISCORD_ERRORS.UNKNOWN_CHANNEL && channelId) {
        cleanupStaleChannel(channelId);
    }

    return {
        success: false,
        error: discordError.message || 'An API error occurred',
        code: discordError.code as number,
    };
}

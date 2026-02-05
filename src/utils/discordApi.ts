import { ChannelType, type VoiceChannel, type Guild, type GuildMember, DiscordAPIError } from 'discord.js';
import { vcnsBridge } from '../vcns/bridge';
import { unregisterChannel } from './voiceManager';
import prisma from './database';
let recordBotEditFn: ((channelId: string) => void) | null = null;
export function setRecordBotEditFn(fn: (channelId: string) => void): void {
    recordBotEditFn = fn;
}
function notifyBotEdit(channelId: string): void {
    if (recordBotEditFn) {
        recordBotEditFn(channelId);
    }
}
export interface SafeResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    code?: number;
}
const DISCORD_ERRORS = {
    UNKNOWN_CHANNEL: 10003,
    UNKNOWN_GUILD: 10004,
    UNKNOWN_MEMBER: 10007,
    UNKNOWN_USER: 10013,
    MISSING_PERMISSIONS: 50013,
    RATE_LIMITED: 429,
};
export async function validateVoiceChannel(guild: Guild, channelId: string): Promise<VoiceChannel | null> {
    try {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
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
async function cleanupStaleChannel(channelId: string): Promise<void> {
    unregisterChannel(channelId);
    await prisma.privateVoiceChannel.deleteMany({
        where: { channelId },
    }).catch(() => { });
}
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
        notifyBotEdit(channelId);
        const result = await channel.setName(name);
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
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
        notifyBotEdit(channelId);
        await vcnsBridge.editPermission({
            guild,
            channelId,
            targetId,
            permissions,
        });
        return { success: true };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
export async function safeDeleteChannel(
    guild: Guild,
    channelId: string
): Promise<SafeResult<void>> {
    const channel = await validateVoiceChannel(guild, channelId);
    if (!channel) {
        await cleanupStaleChannel(channelId);
        return { success: true };
    }
    try {
        await vcnsBridge.deleteVC({
            guild,
            channelId,
            isTeam: false,
        });
        await cleanupStaleChannel(channelId);
        return { success: true };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
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
        notifyBotEdit(channelId);
        const result = await channel.setUserLimit(limit);
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
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
        notifyBotEdit(channelId);
        const result = await channel.setBitrate(bitrate);
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
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
        notifyBotEdit(channelId);
        const result = await channel.setRTCRegion(region);
        return { success: true, data: result };
    } catch (error) {
        return handleDiscordError(error, channelId);
    }
}
export async function safeDisconnectMember(
    member: GuildMember
): Promise<SafeResult<void>> {
    try {
        await vcnsBridge.kickUser({
            guild: member.guild,
            channelId: member.voice.channelId || '',
            userId: member.id,
            reason: 'Disconnected via safeDisconnectMember',
            isImmediate: false,
        });
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
function handleDiscordError(error: unknown, channelId?: string): SafeResult<any> {
    const discordError = error as DiscordAPIError;
    if (discordError.code === DISCORD_ERRORS.UNKNOWN_CHANNEL && channelId) {
        cleanupStaleChannel(channelId);
    }
    return {
        success: false,
        error: discordError.message || 'An API error occurred',
        code: discordError.code as number,
    };
}

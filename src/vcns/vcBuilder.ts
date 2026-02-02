import {
    ChannelType,
    type Guild,
    type VoiceChannel,
    PermissionFlagsBits,
    type OverwriteResolvable,
} from 'discord.js';
import { client } from '../client';
import { stateStore } from './stateStore';
import { rateGovernor } from './rateGovernor';
import { lockManager } from './lockManager';
import { IntentAction, VCNS_CONFIG } from './types';
import prisma from '../utils/database';
import { recordBotEdit } from '../events/channelUpdate';
import { vcCreateLockKey } from './resourceKeys';
export interface VCBuildOptions {
    guildId: string;
    categoryId: string;
    ownerId: string;
    name: string;
    isTeamChannel: boolean;
    teamType?: 'DUO' | 'TRIO' | 'SQUAD';
    userLimit?: number;
    bitrate?: number;
    customPermissions?: OverwriteResolvable[];
    skipDbWrite?: boolean;
    skipLock?: boolean;
    lockHolder?: string; 
}
export interface VCBuildResult {
    success: boolean;
    channelId?: string;
    error?: string;
    retryable?: boolean;
    rateLimitHit?: boolean;
    rateLimitRetryAfter?: number;
}
export async function buildVC(options: VCBuildOptions): Promise<VCBuildResult> {
    const { guildId, categoryId, ownerId, name, isTeamChannel, teamType, userLimit, bitrate, customPermissions, skipDbWrite, skipLock, lockHolder } = options;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
        return { success: false, error: 'Guild not found', retryable: false };
    }
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
        return { success: false, error: 'Category not found', retryable: false };
    }
    const lockKey = vcCreateLockKey(guildId, ownerId);
    const effectiveLockHolder = lockHolder || `vcBuilder:${ownerId}`;
    const needsLock = !skipLock;
    if (needsLock) {
        if (!lockManager.acquire(lockKey, effectiveLockHolder, VCNS_CONFIG.VC_CREATE_LOCK_DURATION_MS, 'VC creation')) {
            return { success: false, error: 'Creation lock failed - operation in progress', retryable: true };
        }
    }
    try {
        const existingChannel = stateStore.getChannelByOwner(guildId, ownerId);
        if (existingChannel) {
            if (needsLock) lockManager.release(lockKey, effectiveLockHolder);
            return { success: false, error: 'User already owns a channel', retryable: false };
        }
        const permissionOverwrites: OverwriteResolvable[] = customPermissions || buildDefaultPermissions(guild, ownerId);
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildVoice,
            parent: categoryId,
            userLimit: userLimit ?? 0,
            bitrate: bitrate ?? VCNS_CONFIG.DEFAULT_BITRATE,
            permissionOverwrites,
        }) as VoiceChannel;
        recordBotEdit(channel.id);
        
        // Add Discord permissions for permanent access users
        try {
            const permanentAccessUsers = await prisma.ownerPermission.findMany({
                where: { guildId, ownerId, targetType: 'user' }
            });
            
            if (permanentAccessUsers.length > 0) {
                for (const perm of permanentAccessUsers) {
                    try {
                        await channel.permissionOverwrites.create(perm.targetId, {
                            ViewChannel: true,
                            Connect: true,
                            SendMessages: true,
                            EmbedLinks: true,
                            AttachFiles: true,
                        });
                    } catch (permErr) {
                        console.error(`[VCBuilder] ⚠️ Failed to add permission for ${perm.targetId}:`, permErr);
                    }
                }
            }
        } catch (permCheckErr) {
            console.error(`[VCBuilder] ⚠️ Failed to check permanent access users:`, permCheckErr);
        }
        
        if (!skipDbWrite) {
            try {
                await writeToDatabase(channel.id, guildId, ownerId, isTeamChannel, teamType);
            } catch (dbError: any) {
                console.error(`[VCBuilder] ❌ DB write failed, deleting Discord channel ${channel.id}:`, dbError.message);
                await channel.delete('DB write failed - cleanup').catch(() => {});
                return { success: false, error: `Database write failed: ${dbError.message}`, retryable: false };
            }
        }
        stateStore.registerChannel({
            channelId: channel.id,
            guildId,
            ownerId,
            isLocked: false, 
            isHidden: false,
            userLimit: userLimit ?? 0,
            isTeamChannel,
            teamType,
            operationPending: false,
            lastModified: Date.now(),
        });
        
        // Also register to voiceManager for dual-tracking
        const { registerChannel, registerTeamChannel } = await import('../utils/voiceManager');
        if (isTeamChannel) {
            registerTeamChannel(channel.id, guildId, ownerId, teamType?.toLowerCase() as any, false);
        } else {
            registerChannel(channel.id, guildId, ownerId, false);
        }
        
        rateGovernor.recordAction(IntentAction.VC_CREATE, 30);
        rateGovernor.recordSuccess(`channel:${guildId}`);
        return {
            success: true,
            channelId: channel.id,
        };
    } catch (error: any) {
        const result = handleError(error, guildId);
        return result;
    } finally {
        if (needsLock) {
            lockManager.release(lockKey, effectiveLockHolder);
        }
    }
}
function buildDefaultPermissions(guild: Guild, ownerId: string): OverwriteResolvable[] {
    return [
        {
            id: ownerId,
            allow: [
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.Stream,
                PermissionFlagsBits.MoveMembers,
            ],
        },
        {
            id: client.user!.id,
            allow: [
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.MoveMembers,
            ],
        },
    ];
}
async function writeToDatabase(
    channelId: string,
    guildId: string,
    ownerId: string,
    isTeamChannel: boolean,
    teamType?: 'DUO' | 'TRIO' | 'SQUAD',
): Promise<boolean> {
    try {
        console.log(`[VCBuilder] 📝 Writing channel ${channelId} to database (guild: ${guildId}, owner: ${ownerId}, team: ${isTeamChannel})`);
        if (isTeamChannel) {
            const teamSettings = await prisma.teamVoiceSettings.findUnique({
                where: { guildId }
            });
            if (!teamSettings) {
                console.error(`[VCBuilder] ❌ CRITICAL: TeamVoiceSettings not found for guild ${guildId} - cannot create Team channel`);
                throw new Error(`TeamVoiceSettings not found for guild ${guildId}`);
            }
        } else {
            const guildSettings = await prisma.guildSettings.findUnique({
                where: { guildId }
            });
            if (!guildSettings) {
                console.error(`[VCBuilder] ❌ CRITICAL: GuildSettings not found for guild ${guildId} - cannot create PVC`);
                throw new Error(`GuildSettings not found for guild ${guildId}`);
            }
        }
        if (isTeamChannel) {
            await prisma.teamVoiceChannel.create({
                data: {
                    channelId,
                    guildId,
                    ownerId,
                    teamType: teamType!,
                    isLocked: false, 
                    isHidden: false,
                },
            });
        } else {
            await prisma.privateVoiceChannel.create({
                data: {
                    channelId,
                    guildId,
                    ownerId,
                    isLocked: false, 
                    isHidden: false,
                },
            });
        }
        const verification = isTeamChannel 
            ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } })
            : await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (!verification) {
            console.error(`[VCBuilder] ❌ CRITICAL: Channel ${channelId} created but NOT found in database after write!`);
            throw new Error(`Channel ${channelId} not found in database after write`);
        }
        console.log(`[VCBuilder] ✅ Channel ${channelId} written and VERIFIED in database successfully`);
        return true;
    } catch (error: any) {
        console.error(`[VCBuilder] ❌ Database write failed for channel ${channelId}:`, {
            error: error.message,
            code: error.code,
            channelId,
            guildId,
            ownerId,
            isTeamChannel,
            teamType
        });
        throw error;
    }
}
function handleError(error: any, guildId: string): VCBuildResult {
    if (error?.status === 429 || error?.code === 429) {
        const retryAfter = (error.retry_after || 1) * 1000;
        const isGlobal = error.message?.includes('global') || false;
        rateGovernor.recordRateLimitHit(`channel:${guildId}`, retryAfter, isGlobal);
        return {
            success: false,
            error: 'Rate limited',
            retryable: true,
            rateLimitHit: true,
            rateLimitRetryAfter: retryAfter,
        };
    }
    const retryableCodes = [10003, 50013];
    const isRetryable = (error?.status >= 500 && error?.status < 600) || retryableCodes.includes(error?.code);
    return {
        success: false,
        error: error.message || 'Unknown error',
        retryable: isRetryable,
    };
}

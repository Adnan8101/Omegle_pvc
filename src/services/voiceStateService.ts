import { ChannelType, type VoiceChannel, PermissionFlagsBits } from 'discord.js';
import prisma from '../utils/database';
import { enforcer } from './enforcerService';
import { invalidateChannelPermissions } from '../utils/cache';
import { client } from '../client';
export class VoiceStateService {
    static async getVCState(channelId: string): Promise<any | null> {
        let state = await prisma.privateVoiceChannel.findUnique({
            where: { channelId },
            include: { permissions: true },
        });
        if (!state) {
            state = await prisma.teamVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true },
            }) as any;
        }
        return state;
    }
    static async isManaged(channelId: string): Promise<boolean> {
        const state = await this.getVCState(channelId);
        return !!state;
    }
    static async getOwnerId(channelId: string): Promise<string | null> {
        const state = await this.getVCState(channelId);
        return state?.ownerId || null;
    }
    static async setLock(channelId: string, isLocked: boolean): Promise<void> {
        if (isLocked) {
            const channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
            if (channel && channel.type === ChannelType.GuildVoice) {
                const state = await this.getVCState(channelId);
                if (state) {
                    const ownerId = state.ownerId;
                    const currentMembers = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== ownerId);
                    for (const member of currentMembers) {
                        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
                        if (pvc) {
                            const existingPerm = await prisma.voicePermission.findUnique({
                                where: {
                                    channelId_targetId: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                },
                            }).catch(() => null);
                            if (!existingPerm) {
                                await prisma.voicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                            }
                        } else {
                            const existingPerm = await prisma.teamVoicePermission.findUnique({
                                where: {
                                    channelId_targetId: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                },
                            }).catch(() => null);
                            if (!existingPerm) {
                                await prisma.teamVoicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                            }
                        }
                    }
                    invalidateChannelPermissions(channelId);
                }
            }
        }
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { isLocked },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { isLocked },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async setHidden(channelId: string, isHidden: boolean): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { isHidden },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { isHidden },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async setUserLimit(channelId: string, limit: number): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { userLimit: limit },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { userLimit: limit },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async setBitrate(channelId: string, bitrate: number): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { bitrate },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { bitrate },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async setRegion(channelId: string, region: string | null): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { rtcRegion: region },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { rtcRegion: region },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async addPermit(channelId: string, targetId: string, targetType: 'user' | 'role'): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.voicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'permit', targetType },
                create: { channelId, targetId, targetType, permission: 'permit' },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoicePermission.upsert({
                    where: { channelId_targetId: { channelId, targetId } },
                    update: { permission: 'permit', targetType },
                    create: { channelId, targetId, targetType, permission: 'permit' },
                });
            }
        }
        invalidateChannelPermissions(channelId);
        await enforcer.enforceQuietly(channelId);
    }
    static async removePermit(channelId: string, targetId: string): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.voicePermission.deleteMany({
                where: { channelId, targetId, permission: 'permit' },
            });
        } else {
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId, targetId, permission: 'permit' },
            });
        }
        invalidateChannelPermissions(channelId);
        await enforcer.enforceQuietly(channelId);
    }
    static async addBan(channelId: string, targetId: string, targetType: 'user' | 'role'): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.voicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'ban', targetType },
                create: { channelId, targetId, targetType, permission: 'ban' },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoicePermission.upsert({
                    where: { channelId_targetId: { channelId, targetId } },
                    update: { permission: 'ban', targetType },
                    create: { channelId, targetId, targetType, permission: 'ban' },
                });
            }
        }
        invalidateChannelPermissions(channelId);
        await enforcer.enforceQuietly(channelId);
    }
    static async removeBan(channelId: string, targetId: string): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.voicePermission.deleteMany({
                where: { channelId, targetId, permission: 'ban' },
            });
        } else {
            await prisma.teamVoicePermission.deleteMany({
                where: { channelId, targetId, permission: 'ban' },
            });
        }
        invalidateChannelPermissions(channelId);
        await enforcer.enforceQuietly(channelId);
    }
    static async transferOwnership(channelId: string, newOwnerId: string): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { ownerId: newOwnerId },
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { ownerId: newOwnerId },
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
    static async updateSettings(
        channelId: string,
        settings: {
            isLocked?: boolean;
            isHidden?: boolean;
            userLimit?: number;
            bitrate?: number;
            rtcRegion?: string | null;
        }
    ): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: settings,
            });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: settings,
                });
            }
        }
        await enforcer.enforceQuietly(channelId);
    }
}

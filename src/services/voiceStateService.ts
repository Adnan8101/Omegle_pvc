import { ChannelType, type VoiceChannel, PermissionFlagsBits } from 'discord.js';
import prisma from '../utils/database';
import { enforcer } from './enforcerService';
import { invalidateChannelPermissions } from '../utils/cache';

/**
 * VOICE STATE SERVICE
 * 
 * This service is the ONLY way to modify PVC/Team channel state.
 * It ensures:
 * 1. DB is updated FIRST (source of truth)
 * 2. Then Discord is synced via enforcer
 * 3. No direct Discord API calls bypass this
 */
export class VoiceStateService {
    /**
     * Get the authoritative state of a VC from the database.
     * This is THE TRUTH - Discord state may differ temporarily.
     */
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

    /**
     * Check if a channel is a PVC or Team channel
     */
    static async isManaged(channelId: string): Promise<boolean> {
        const state = await this.getVCState(channelId);
        return !!state;
    }

    /**
     * Get the owner ID of a managed channel
     */
    static async getOwnerId(channelId: string): Promise<string | null> {
        const state = await this.getVCState(channelId);
        return state?.ownerId || null;
    }

    // ==================== LOCK/UNLOCK ====================

    /**
     * Lock a PVC - DB first, then enforce
     */
    static async setLock(channelId: string, isLocked: boolean): Promise<void> {
        // Try PVC first
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        
        if (pvc) {
            await prisma.privateVoiceChannel.update({
                where: { channelId },
                data: { isLocked },
            });
        } else {
            // Try Team channel
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { isLocked },
                });
            }
        }

        // Enforce the new state immediately
        await enforcer.enforce(channelId);
    }

    // ==================== HIDE/UNHIDE ====================

    /**
     * Hide/Unhide a channel - DB first, then enforce
     */
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

        await enforcer.enforce(channelId);
    }

    // ==================== USER LIMIT ====================

    /**
     * Set user limit - DB first, then enforce
     */
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

        await enforcer.enforce(channelId);
    }

    // ==================== BITRATE ====================

    /**
     * Set bitrate - DB first, then enforce
     */
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

        await enforcer.enforce(channelId);
    }

    // ==================== REGION ====================

    /**
     * Set region - DB first, then enforce
     */
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

        await enforcer.enforce(channelId);
    }

    // ==================== PERMISSIONS ====================

    /**
     * Add a permit for a user/role - DB first, then enforce
     */
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
        await enforcer.enforce(channelId);
    }

    /**
     * Remove a permit for a user/role - DB first, then enforce
     */
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
        await enforcer.enforce(channelId);
    }

    /**
     * Add a ban for a user/role - DB first, then enforce
     */
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
        await enforcer.enforce(channelId);
    }

    /**
     * Remove a ban for a user/role - DB first, then enforce
     */
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
        await enforcer.enforce(channelId);
    }

    // ==================== OWNERSHIP ====================

    /**
     * Transfer ownership - DB first, then enforce
     */
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

        await enforcer.enforce(channelId);
    }

    // ==================== BATCH OPERATIONS ====================

    /**
     * Update multiple settings at once - DB first, then single enforce
     */
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

        await enforcer.enforce(channelId);
    }
}

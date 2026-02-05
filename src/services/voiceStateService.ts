import { ChannelType, type VoiceChannel, PermissionFlagsBits } from 'discord.js';
import prisma from '../utils/database';
import { enforcer } from './enforcerService';
import { invalidateChannelPermissions } from '../utils/cache';
import { client } from '../client';
import { stateStore } from '../vcns/index';
export class VoiceStateService {
    private static async addTempPermitToDb(channelId: string, userId: string, userTag: string): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            const existingPerm = await prisma.voicePermission.findUnique({
                where: { channelId_targetId: { channelId, targetId: userId } },
            }).catch(() => null);
            if (!existingPerm || existingPerm.permission !== 'permit') {
                await prisma.voicePermission.deleteMany({
                    where: { channelId, targetId: userId },
                }).catch(() => {});
                await prisma.voicePermission.create({
                    data: {
                        channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    },
                }).catch(() => {});
                console.log(`[VoiceStateService] ✅ Added temp permit (PVC DB) for ${userTag} (${userId})`);
            }
        } else {
            const existingPerm = await prisma.teamVoicePermission.findUnique({
                where: { channelId_targetId: { channelId, targetId: userId } },
            }).catch(() => null);
            if (!existingPerm || existingPerm.permission !== 'permit') {
                await prisma.teamVoicePermission.deleteMany({
                    where: { channelId, targetId: userId },
                }).catch(() => {});
                await prisma.teamVoicePermission.create({
                    data: {
                        channelId,
                        targetId: userId,
                        targetType: 'user',
                        permission: 'permit',
                    },
                }).catch(() => {});
                console.log(`[VoiceStateService] ✅ Added temp permit (Team DB) for ${userTag} (${userId})`);
            }
        }
    }
    private static async updateChannelDb(channelId: string, data: any): Promise<void> {
        const pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        if (pvc) {
            await prisma.privateVoiceChannel.update({ where: { channelId }, data });
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({ where: { channelId }, data });
            }
        }
    }
    private static async autoRecover(channelId: string): Promise<boolean> {
        const memoryState = stateStore.getChannelState(channelId);
        if (!memoryState) {
            return false; 
        }
        console.log(`[VoiceStateService] ⚠️ Auto-recovery: Channel ${channelId} in MEMORY but not DB`);
        try {
            if (memoryState.isTeamChannel) {
                await prisma.teamVoiceChannel.create({
                    data: {
                        channelId,
                        guildId: memoryState.guildId,
                        ownerId: memoryState.ownerId,
                        teamType: (memoryState.teamType?.toUpperCase() as 'DUO' | 'TRIO' | 'SQUAD') || 'DUO',
                        isLocked: memoryState.isLocked || false,
                        isHidden: memoryState.isHidden || false,
                    },
                });
            } else {
                await prisma.privateVoiceChannel.create({
                    data: {
                        channelId,
                        guildId: memoryState.guildId,
                        ownerId: memoryState.ownerId,
                        isLocked: memoryState.isLocked || false,
                        isHidden: memoryState.isHidden || false,
                    },
                });
            }
            console.log(`[VoiceStateService] ✅ Auto-recovery successful for ${channelId}`);
            return true;
        } catch (error: any) {
            console.error(`[VoiceStateService] ❌ Auto-recovery failed for ${channelId}:`, error.message);
            return false;
        }
    }
    static async getVCState(channelId: string, forceRefreshPermissions: boolean = false): Promise<any | null> {
        try {
            console.log(`[VoiceStateService] 🔍 getVCState called for channelId: ${channelId}, forceRefresh=${forceRefreshPermissions}`);
            const memoryState = stateStore.getChannelState(channelId);
            let state = await prisma.privateVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true },
            });
            if (state) {
                if (memoryState) {
                    state.isLocked = memoryState.isLocked;
                    state.isHidden = memoryState.isHidden;
                    state.userLimit = memoryState.userLimit || 0;
                    console.log(`[VoiceStateService] ✅ Found PVC in DB + merged stateStore: channelId=${channelId}, ownerId=${state.ownerId}, isLocked=${state.isLocked}, isHidden=${state.isHidden}`);
                } else {
                    console.log(`[VoiceStateService] ✅ Found PVC in DB: channelId=${channelId}, ownerId=${state.ownerId}, isLocked=${state.isLocked}`);
                }
                return state;
            }
            console.log(`[VoiceStateService] ⚠️ Not found in privateVoiceChannel, checking teamVoiceChannel...`);
            state = await prisma.teamVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true },
            }) as any;
            if (state) {
                if (memoryState) {
                    state.isLocked = memoryState.isLocked;
                    state.isHidden = memoryState.isHidden;
                    state.userLimit = memoryState.userLimit || 0;
                    console.log(`[VoiceStateService] ✅ Found Team VC in DB + merged stateStore: channelId=${channelId}, ownerId=${state.ownerId}, isLocked=${state.isLocked}, isHidden=${state.isHidden}`);
                } else {
                    console.log(`[VoiceStateService] ✅ Found Team VC in DB: channelId=${channelId}, ownerId=${state.ownerId}`);
                }
                return state;
            }
            console.log(`[VoiceStateService] ❌ Channel ${channelId} NOT FOUND in any database table`);
            return null;
        } catch (error: any) {
            console.error(`[VoiceStateService] ❌ Database error querying channel ${channelId}:`, error.message);
            return null;
        }
    }
    static async isManaged(channelId: string): Promise<boolean> {
        const state = await this.getVCState(channelId);
        return !!state;
    }
    static async getOwnerId(channelId: string): Promise<string | null> {
        const state = await this.getVCState(channelId);
        return state?.ownerId || null;
    }
    private static syncToStateStore(channelId: string, updates: Partial<{ isLocked: boolean; isHidden: boolean; userLimit: number }>): void {
        const existing = stateStore.getChannelState(channelId);
        if (existing) {
            stateStore.updateChannelState(channelId, updates);
            console.log(`[VoiceStateService] Synced state to stateStore for ${channelId}:`, updates);
        }
    }
    static async setLock(channelId: string, isLocked: boolean): Promise<void> {
        this.syncToStateStore(channelId, { isLocked });
        console.log(`[VoiceStateService] ✅ Updated stateStore IMMEDIATELY: isLocked=${isLocked} for channel ${channelId}`);
        const channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
        const { recordBotEdit } = await import('../events/channelUpdate');
        if (isLocked) {
            if (channel && channel.type === ChannelType.GuildVoice) {
                const state = await this.getVCState(channelId);
                if (state) {
                    const ownerId = state.ownerId;
                    const currentMembers = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== ownerId);
                    console.log(`[VoiceStateService] 🔒 Locking channel ${channelId} - giving TEMPORARY permits to ${currentMembers.length} members`);
                    recordBotEdit(channelId);
                    const { vcnsBridge } = await import('../vcns/bridge');
                    for (const member of currentMembers) {
                        try {
                            await vcnsBridge.editPermission({
                                guild: channel.guild,
                                channelId,
                                targetId: member.id,
                                permissions: {
                                    Connect: true,
                                    ViewChannel: null, 
                                },
                                allowWhenHealthy: true, 
                            });
                            console.log(`[VoiceStateService] ✅ Set Discord Connect permission for ${member.user.tag} (${member.id})`);
                        } catch (err) {
                            console.error(`[VoiceStateService] ❌ Failed to set Discord permission for ${member.id}:`, err);
                        }
                    }
                    for (const member of currentMembers) {
                        const { addTempLockPermit } = await import('../utils/voiceManager');
                        addTempLockPermit(channelId, member.id);
                        await this.addTempPermitToDb(channelId, member.id, member.user.tag);
                    }
                    invalidateChannelPermissions(channelId);
                }
            }
        }
        await this.updateChannelDb(channelId, { isLocked });
        console.log(`[VoiceStateService] ✅ Updated DB: isLocked=${isLocked} for channel ${channelId}`);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                recordBotEdit(channelId);
                const currentOverwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
                const permUpdate: any = {
                    Connect: isLocked ? false : null, 
                };
                if (currentOverwrite?.deny.has(PermissionFlagsBits.ViewChannel)) {
                    permUpdate.ViewChannel = false;
                } else if (currentOverwrite?.allow.has(PermissionFlagsBits.ViewChannel)) {
                    permUpdate.ViewChannel = true;
                }
                await channel.permissionOverwrites.edit(channel.guild.id, permUpdate);
                console.log(`[VoiceStateService] ✅ Lock ${isLocked ? 'enabled' : 'disabled'} for channel ${channelId}`);
            } catch (error) {
                console.error(`[VoiceStateService] ❌ Failed to update/verify Discord permission for lock:`, error);
                throw error; 
            }
        }
    }
    static async setHidden(channelId: string, isHidden: boolean): Promise<void> {
        this.syncToStateStore(channelId, { isHidden });
        console.log(`[VoiceStateService] ✅ Updated stateStore IMMEDIATELY: isHidden=${isHidden} for channel ${channelId}`);
        const channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
        const { recordBotEdit } = await import('../events/channelUpdate');
        if (isHidden) {
            if (channel && channel.type === ChannelType.GuildVoice) {
                const state = await this.getVCState(channelId);
                if (state) {
                    const ownerId = state.ownerId;
                    const currentMembers = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== ownerId);
                    console.log(`[VoiceStateService] 🙈 Hiding channel ${channelId} - giving TEMPORARY permits to ${currentMembers.length} members`);
                    recordBotEdit(channelId);
                    const { vcnsBridge } = await import('../vcns/bridge');
                    for (const member of currentMembers) {
                        try {
                            await vcnsBridge.editPermission({
                                guild: channel.guild,
                                channelId,
                                targetId: member.id,
                                permissions: {
                                    ViewChannel: true,
                                    Connect: null, 
                                },
                                allowWhenHealthy: true, 
                            });
                            console.log(`[VoiceStateService] ✅ Set Discord ViewChannel permission for ${member.user.tag} (${member.id})`);
                        } catch (err) {
                            console.error(`[VoiceStateService] ❌ Failed to set Discord permission for ${member.id}:`, err);
                        }
                    }
                    for (const member of currentMembers) {
                        const { addTempLockPermit } = await import('../utils/voiceManager');
                        addTempLockPermit(channelId, member.id);
                        await this.addTempPermitToDb(channelId, member.id, member.user.tag);
                    }
                    invalidateChannelPermissions(channelId);
                }
            }
        }
        await this.updateChannelDb(channelId, { isHidden });
        console.log(`[VoiceStateService] ✅ Updated DB: isHidden=${isHidden} for channel ${channelId}`);
        if (channel && channel.type === ChannelType.GuildVoice) {
            try {
                recordBotEdit(channelId);
                const currentOverwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
                const permUpdate: any = {
                    ViewChannel: isHidden ? false : null, 
                };
                if (currentOverwrite?.deny.has(PermissionFlagsBits.Connect)) {
                    permUpdate.Connect = false;
                } else if (currentOverwrite?.allow.has(PermissionFlagsBits.Connect)) {
                    permUpdate.Connect = true;
                }
                await channel.permissionOverwrites.edit(channel.guild.id, permUpdate);
                console.log(`[VoiceStateService] ✅ Hidden ${isHidden ? 'enabled' : 'disabled'} for channel ${channelId}`);
            } catch (error) {
                console.error(`[VoiceStateService] ❌ Failed to update/verify Discord permission for hidden:`, error);
                throw error; 
            }
        }
    }
    static async setUserLimit(channelId: string, limit: number): Promise<void> {
        await this.updateChannelDb(channelId, { userLimit: limit });
        this.syncToStateStore(channelId, { userLimit: limit });
        await enforcer.enforceQuietly(channelId);
    }
    static async setBitrate(channelId: string, bitrate: number): Promise<void> {
        await this.updateChannelDb(channelId, { bitrate });
        await enforcer.enforceQuietly(channelId);
    }
    static async setRegion(channelId: string, region: string | null): Promise<void> {
        await this.updateChannelDb(channelId, { rtcRegion: region });
        await enforcer.enforceQuietly(channelId);
    }
    static async addPermit(channelId: string, targetId: string, targetType: 'user' | 'role'): Promise<void> {
        let pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        let team = !pvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
        if (!pvc && !team) {
            const recovered = await this.autoRecover(channelId);
            if (recovered) {
                pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
                team = !pvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
            }
        }
        if (pvc) {
            await prisma.voicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'permit', targetType },
                create: { channelId, targetId, targetType, permission: 'permit' },
            });
        } else if (team) {
            await prisma.teamVoicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'permit', targetType },
                create: { channelId, targetId, targetType, permission: 'permit' },
            });
        } else {
            throw new Error(`Channel ${channelId} not found in database and auto-recovery failed`);
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
        const { removeTempLockPermit } = await import('../utils/voiceManager');
        removeTempLockPermit(channelId, targetId);
        invalidateChannelPermissions(channelId);
        await enforcer.enforceQuietly(channelId);
    }
    static async addBan(channelId: string, targetId: string, targetType: 'user' | 'role'): Promise<void> {
        let pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
        let team = !pvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
        if (!pvc && !team) {
            const recovered = await this.autoRecover(channelId);
            if (recovered) {
                pvc = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
                team = !pvc ? await prisma.teamVoiceChannel.findUnique({ where: { channelId } }) : null;
            }
        }
        if (pvc) {
            await prisma.voicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'ban', targetType },
                create: { channelId, targetId, targetType, permission: 'ban' },
            });
        } else if (team) {
            await prisma.teamVoicePermission.upsert({
                where: { channelId_targetId: { channelId, targetId } },
                update: { permission: 'ban', targetType },
                create: { channelId, targetId, targetType, permission: 'ban' },
            });
        } else {
            throw new Error(`Channel ${channelId} not found in database and auto-recovery failed`);
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

import { ChannelType, type VoiceChannel, PermissionFlagsBits } from 'discord.js';
import prisma from '../utils/database';
import { enforcer } from './enforcerService';
import { invalidateChannelPermissions } from '../utils/cache';
import { client } from '../client';
import { stateStore } from '../vcns/index';
export class VoiceStateService {
    static async getVCState(channelId: string): Promise<any | null> {
        try {
            console.log(`[VoiceStateService] 🔍 getVCState called for channelId: ${channelId}`);
            let state = await prisma.privateVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true },
            });
            if (state) {
                console.log(`[VoiceStateService] ✅ Found PVC in DB: channelId=${channelId}, ownerId=${state.ownerId}, isLocked=${state.isLocked}`);
                return state;
            }
            console.log(`[VoiceStateService] ⚠️ Not found in privateVoiceChannel, checking teamVoiceChannel...`);
            state = await prisma.teamVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true },
            }) as any;
            if (state) {
                console.log(`[VoiceStateService] ✅ Found Team VC in DB: channelId=${channelId}, ownerId=${state.ownerId}`);
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
        const channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
        const { recordBotEdit } = await import('../events/channelUpdate');
        
        if (isLocked) {
            // When locking: give temporary permits to all current members (except owner)
            if (channel && channel.type === ChannelType.GuildVoice) {
                const state = await this.getVCState(channelId);
                if (state) {
                    const ownerId = state.ownerId;
                    const currentMembers = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== ownerId);
                    
                    console.log(`[VoiceStateService] 🔒 Locking channel ${channelId} - giving TEMPORARY permits to ${currentMembers.length} members`);
                    
                    // FIRST: Set Discord permissions to allow Connect for each current member
                    // This must happen BEFORE we deny Connect for @everyone
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
                                    ViewChannel: null, // Keep existing
                                },
                            });
                            console.log(`[VoiceStateService] ✅ Set Discord Connect permission for ${member.user.tag} (${member.id})`);
                        } catch (err) {
                            console.error(`[VoiceStateService] ❌ Failed to set Discord permission for ${member.id}:`, err);
                        }
                    }
                    
                    // SECOND: Add to database and memory
                    for (const member of currentMembers) {
                        // Track in memory as temporary permit
                        const { addTempLockPermit } = await import('../utils/voiceManager');
                        addTempLockPermit(channelId, member.id);
                        
                        // Also add to database for access protection to see
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
                            
                            if (!existingPerm || existingPerm.permission !== 'permit') {
                                // Delete any existing permission first
                                await prisma.voicePermission.deleteMany({
                                    where: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                }).catch(() => {});
                                
                                // Create temporary permit
                                await prisma.voicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                                
                                console.log(`[VoiceStateService] ✅ Added temp permit (DB) for ${member.user.tag} (${member.id})`);
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
                            
                            if (!existingPerm || existingPerm.permission !== 'permit') {
                                // Delete any existing permission first
                                await prisma.teamVoicePermission.deleteMany({
                                    where: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                }).catch(() => {});
                                
                                // Create temporary permit
                                await prisma.teamVoicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                                
                                console.log(`[VoiceStateService] ✅ Added temp permit (DB) for ${member.user.tag} (${member.id})`);
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
            
            const verification = await prisma.privateVoiceChannel.findUnique({ where: { channelId } });
            if (verification?.isLocked !== isLocked) {
                console.error(`[VoiceStateService] ❌ Lock update verification FAILED! Expected isLocked=${isLocked}, got isLocked=${verification?.isLocked}`);
            } else {
                console.log(`[VoiceStateService] ✅ Updated and VERIFIED PVC ${channelId} in DB: isLocked=${isLocked}`);
            }
        } else {
            const team = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
            if (team) {
                await prisma.teamVoiceChannel.update({
                    where: { channelId },
                    data: { isLocked },
                });
                
                const verification = await prisma.teamVoiceChannel.findUnique({ where: { channelId } });
                if (verification?.isLocked !== isLocked) {
                    console.error(`[VoiceStateService] ❌ Team lock update verification FAILED! Expected isLocked=${isLocked}, got isLocked=${verification?.isLocked}`);
                } else {
                    console.log(`[VoiceStateService] ✅ Updated and VERIFIED Team ${channelId} in DB: isLocked=${isLocked}`);
                }
            } else {
                console.error(`[VoiceStateService] ❌ CRITICAL: Channel ${channelId} NOT FOUND in database! Cannot set lock state. This channel needs /refresh_pvc to be re-registered.`);
                return; 
            }
        }
        
        this.syncToStateStore(channelId, { isLocked });
        
        // LAST: Update @everyone permission (deny Connect when locked)
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
                console.log(`[VoiceStateService] Lock ${isLocked ? 'enabled' : 'disabled'} - Connect=${isLocked ? 'DENY' : 'NEUTRAL'} for channel ${channelId}`);
            } catch (error) {
                console.error(`[VoiceStateService] Failed to update Discord permission for lock:`, error);
            }
        }
        
        await enforcer.enforceQuietly(channelId);
    }
    static async setHidden(channelId: string, isHidden: boolean): Promise<void> {
        const channel = client.channels.cache.get(channelId) as VoiceChannel | undefined;
        const { recordBotEdit } = await import('../events/channelUpdate');
        
        if (isHidden) {
            // When hiding: give temporary permits to all current members (except owner)
            if (channel && channel.type === ChannelType.GuildVoice) {
                const state = await this.getVCState(channelId);
                if (state) {
                    const ownerId = state.ownerId;
                    const currentMembers = Array.from(channel.members.values())
                        .filter(m => !m.user.bot && m.id !== ownerId);
                    
                    console.log(`[VoiceStateService] 🙈 Hiding channel ${channelId} - giving TEMPORARY permits to ${currentMembers.length} members`);
                    
                    // FIRST: Set Discord permissions to allow ViewChannel for each current member
                    // This must happen BEFORE we deny ViewChannel for @everyone
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
                                    Connect: null, // Keep existing
                                },
                            });
                            console.log(`[VoiceStateService] ✅ Set Discord ViewChannel permission for ${member.user.tag} (${member.id})`);
                        } catch (err) {
                            console.error(`[VoiceStateService] ❌ Failed to set Discord permission for ${member.id}:`, err);
                        }
                    }
                    
                    // SECOND: Add to database and memory
                    for (const member of currentMembers) {
                        // Track in memory as temporary permit
                        const { addTempLockPermit } = await import('../utils/voiceManager');
                        addTempLockPermit(channelId, member.id);
                        
                        // Also add to database for access protection to see
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
                            
                            if (!existingPerm || existingPerm.permission !== 'permit') {
                                // Delete any existing permission first
                                await prisma.voicePermission.deleteMany({
                                    where: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                }).catch(() => {});
                                
                                // Create temporary permit
                                await prisma.voicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                                
                                console.log(`[VoiceStateService] ✅ Added temp permit (DB) for ${member.user.tag} (${member.id})`);
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
                            
                            if (!existingPerm || existingPerm.permission !== 'permit') {
                                // Delete any existing permission first
                                await prisma.teamVoicePermission.deleteMany({
                                    where: {
                                        channelId,
                                        targetId: member.id,
                                    },
                                }).catch(() => {});
                                
                                // Create temporary permit
                                await prisma.teamVoicePermission.create({
                                    data: {
                                        channelId,
                                        targetId: member.id,
                                        targetType: 'user',
                                        permission: 'permit',
                                    },
                                }).catch(() => {}); 
                                
                                console.log(`[VoiceStateService] ✅ Added temp permit (DB) for ${member.user.tag} (${member.id})`);
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
        
        this.syncToStateStore(channelId, { isHidden });
        
        // LAST: Update @everyone permission (deny ViewChannel when hidden)
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
                console.log(`[VoiceStateService] Hidden ${isHidden ? 'enabled' : 'disabled'} - ViewChannel=${isHidden ? 'DENY' : 'NEUTRAL'} for channel ${channelId}`);
            } catch (error) {
                console.error(`[VoiceStateService] Failed to update Discord permission for hidden:`, error);
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
        this.syncToStateStore(channelId, { userLimit: limit });
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
        
        // Also remove from temp lock permits if it exists
        const { removeTempLockPermit } = await import('../utils/voiceManager');
        removeTempLockPermit(channelId, targetId);
        
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

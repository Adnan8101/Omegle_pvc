import type { Client, Guild, GuildMember, ChannelType } from 'discord.js';
import { vcQueueService, VCRequestStatus, VCRequestType } from './vcQueueService';
import { vcnsBridge } from '../vcns/bridge';
import { registerChannel, registerTeamChannel, releaseCreationLock } from '../utils/voiceManager';
import prisma from '../utils/database';
export class VCQueueWorker {
    private static instance: VCQueueWorker;
    private client: Client | null = null;
    private running = false;
    private workerInterval: NodeJS.Timeout | null = null;
    private readonly WORKER_INTERVAL_MS = 1000; 
    private readonly MAX_CONCURRENT = 3; 
    private readonly MAX_CONCURRENT_PER_GUILD = 2; 
    private activeWorkers = 0;
    private activePerGuild = new Map<string, number>(); 
    private rateLimitedUntil: number = 0; 
    private constructor() {}
    public static getInstance(): VCQueueWorker {
        if (!VCQueueWorker.instance) {
            VCQueueWorker.instance = new VCQueueWorker();
        }
        return VCQueueWorker.instance;
    }
    public async start(client: Client): Promise<void> {
        if (this.running) {
            console.log('[VCQueueWorker] Already running');
            return;
        }
        this.client = client;
        this.running = true;
        console.log('[VCQueueWorker] 🚀 Starting VC Creation Queue Worker...');
        const pendingRequests = await vcQueueService.loadPendingRequests();
        console.log(`[VCQueueWorker] 📥 Loaded ${pendingRequests.length} pending requests`);
        this.workerInterval = setInterval(() => {
            this.processQueue();
        }, this.WORKER_INTERVAL_MS);
        console.log('[VCQueueWorker] ✅ Worker started');
    }
    public stop(): void {
        this.running = false;
        if (this.workerInterval) {
            clearInterval(this.workerInterval);
            this.workerInterval = null;
        }
        console.log('[VCQueueWorker] ⏹️ Worker stopped');
    }
    private async processQueue(): Promise<void> {
        if (!this.running || !this.client) return;
        if (Date.now() < this.rateLimitedUntil) {
            const remainingMs = this.rateLimitedUntil - Date.now();
            console.log(`[VCQueueWorker] ⏸️ Rate-limited, pausing for ${Math.ceil(remainingMs / 1000)}s`);
            return;
        }
        await vcQueueService.cleanupExpired();
        if (this.activeWorkers >= this.MAX_CONCURRENT) {
            return;
        }
        const request = await vcQueueService.getNextRequest();
        if (!request) {
            return;
        }
        const guildActive = this.activePerGuild.get(request.guildId) || 0;
        if (guildActive >= this.MAX_CONCURRENT_PER_GUILD) {
            console.log(`[VCQueueWorker] ⏸️ Guild ${request.guildId} at fairness limit (${guildActive}/${this.MAX_CONCURRENT_PER_GUILD})`);
            return;
        }
        this.activeWorkers++;
        this.activePerGuild.set(request.guildId, guildActive + 1);
        this.processRequest(request)
            .catch(error => {
                console.error(`[VCQueueWorker] Error processing request ${request.id}:`, error);
            })
            .finally(() => {
                this.activeWorkers--;
                const current = this.activePerGuild.get(request.guildId) || 1;
                this.activePerGuild.set(request.guildId, Math.max(0, current - 1));
            });
    }
    private async processRequest(request: any): Promise<void> {
        const { id, userId, guildId, requestType, channelName, parentId, permissionData } = request;
        console.log(`[VCQueueWorker] 🔄 Processing request ${id} for user ${userId}`);
        if (request.channelId) {
            console.log(`[VCQueueWorker] ✅ Request ${id} already has channelId ${request.channelId} - marking completed`);
            await vcQueueService.markCompleted(id, request.channelId);
            return;
        }
        await vcQueueService.markProcessing(id);
        try {
            const guild = this.client?.guilds.cache.get(guildId);
            if (!guild) {
                throw new Error(`Guild ${guildId} not found`);
            }
            let member: GuildMember;
            try {
                member = await guild.members.fetch(userId);
            } catch (error) {
                throw new Error(`Member ${userId} not found in guild ${guildId}`);
            }
            const interfaceChannelId = await this.getInterfaceChannelId(guild, requestType);
            if (!interfaceChannelId) {
                throw new Error('Interface channel not found');
            }
            if (!member.voice.channelId || member.voice.channelId !== interfaceChannelId) {
                console.log(`[VCQueueWorker] User ${userId} left interface channel - cancelling request ${id}`);
                await vcQueueService.cancelRequest(userId, guildId);
                return;
            }
            const permissionOverwrites = permissionData 
                ? JSON.parse(permissionData) 
                : [];
            const isTeam = requestType !== VCRequestType.PVC;
            const teamType = isTeam ? this.getTeamType(requestType) : undefined;
            console.log(`[VCQueueWorker] 🏗️ Creating VC for user ${userId}...`);
            const createResult = await vcnsBridge.createVC({
                guild,
                ownerId: userId,
                channelName,
                parentId,
                permissionOverwrites,
                isTeam,
                teamType,
            });
            if (!createResult || !createResult.channelId) {
                throw new Error('VC creation failed - no channel ID returned');
            }
            const channelId = createResult.channelId;
            console.log(`[VCQueueWorker] ✅ VC created: ${channelId}`);
            if (isTeam && teamType) {
                registerTeamChannel(channelId, guildId, userId, teamType, false);
            } else {
                registerChannel(channelId, guildId, userId, false);
            }
            if (isTeam) {
                await prisma.teamVoiceChannel.create({
                    data: {
                        channelId,
                        guildId,
                        ownerId: userId,
                        teamType: teamType!.toUpperCase() as any,
                    },
                });
            } else {
                await prisma.privateVoiceChannel.create({
                    data: {
                        channelId,
                        guildId,
                        ownerId: userId,
                    },
                });
            }
            const channel = guild.channels.cache.get(channelId);
            if (channel && channel.isVoiceBased() && member.voice.channelId) {
                try {
                    await member.voice.setChannel(channel);
                    console.log(`[VCQueueWorker] ✅ Moved user ${userId} to new channel ${channelId}`);
                } catch (error) {
                    console.error(`[VCQueueWorker] Failed to move user to new channel:`, error);
                }
            }
            await vcQueueService.markCompleted(id, channelId);
            this.runPostCreationTasks(guild, member, channel, channelId, isTeam, teamType).catch(err => {
                console.error(`[VCQueueWorker] Post-creation tasks error:`, err);
            });
            console.log(`[VCQueueWorker] 🎉 Request ${id} completed successfully`);
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            console.error(`[VCQueueWorker] ❌ Request ${id} failed:`, errorMessage);
            if (errorMessage.includes('rate limit') || errorMessage.includes('429') || error?.status === 429) {
                const retryAfter = error?.retryAfter || 60; 
                this.rateLimitedUntil = Date.now() + (retryAfter * 1000);
                console.log(`[VCQueueWorker] 🚨 Rate limit detected - pausing all workers for ${retryAfter}s`);
            }
            await vcQueueService.markFailedAndRetry(id, errorMessage);
        }
    }
    private async getInterfaceChannelId(guild: Guild, requestType: VCRequestType): Promise<string | null> {
        if (requestType === VCRequestType.PVC) {
            const settings = await prisma.guildSettings.findUnique({
                where: { guildId: guild.id },
            });
            return settings?.interfaceVcId || null;
        } else {
            const teamSettings = await prisma.teamVoiceSettings.findUnique({
                where: { guildId: guild.id },
            });
            switch (requestType) {
                case VCRequestType.TEAM_DUO:
                    return teamSettings?.duoVcId || null;
                case VCRequestType.TEAM_TRIO:
                    return teamSettings?.trioVcId || null;
                case VCRequestType.TEAM_SQUAD:
                    return teamSettings?.squadVcId || null;
                default:
                    return null;
            }
        }
    }
    private getTeamType(requestType: VCRequestType): 'duo' | 'trio' | 'squad' | undefined {
        switch (requestType) {
            case VCRequestType.TEAM_DUO:
                return 'duo';
            case VCRequestType.TEAM_TRIO:
                return 'trio';
            case VCRequestType.TEAM_SQUAD:
                return 'squad';
            default:
                return undefined;
        }
    }
    public getStats(): {
        running: boolean;
        activeWorkers: number;
        maxConcurrent: number;
    } {
        return {
            running: this.running,
            activeWorkers: this.activeWorkers,
            maxConcurrent: this.MAX_CONCURRENT,
        };
    }
    private async runPostCreationTasks(
        guild: any,
        member: any,
        channel: any,
        channelId: string,
        isTeam: boolean,
        teamType?: 'duo' | 'trio' | 'squad'
    ): Promise<void> {
        try {
            const { generateInterfaceImage, generateVcInterfaceEmbed, createInterfaceComponents } = await import('../utils/canvasGenerator');
            const { AttachmentBuilder } = await import('discord.js');
            const { addUserToJoinOrder } = await import('../utils/voiceManager');
            const { logAction, LogAction } = await import('../utils/logger');
            const { recordBotEdit } = await import('../events/channelUpdate');
            const { getOwnerPermissions: getCachedOwnerPerms } = await import('../utils/cache');
            addUserToJoinOrder(channelId, member.id);
            const savedPermissions = await getCachedOwnerPerms(guild.id, member.id);
            if (savedPermissions && savedPermissions.length > 0) {
                console.log(`[VCQueueWorker] 🔑 Applying ${savedPermissions.length} permanent access grants`);
                if (!isTeam) {
                    await prisma.voicePermission.createMany({
                        data: savedPermissions.map((p: any) => ({
                            channelId,
                            targetId: p.targetId,
                            targetType: p.targetType,
                            permission: p.permission,
                        })),
                        skipDuplicates: true,
                    }).catch(err => {
                        console.error(`[VCQueueWorker] Failed to add permissions to DB:`, err);
                    });
                }
                const validPermissions: any[] = [];
                const invalidTargetIds: string[] = [];
                for (const perm of savedPermissions) {
                    const isValidTarget = perm.targetType === 'role'
                        ? guild.roles.cache.has(perm.targetId)
                        : guild.members.cache.has(perm.targetId) || await guild.members.fetch(perm.targetId).catch(() => null);
                    if (isValidTarget) {
                        validPermissions.push(perm);
                    } else {
                        invalidTargetIds.push(perm.targetId);
                    }
                }
                if (invalidTargetIds.length > 0) {
                    console.log(`[VCQueueWorker] 🗑️ Removing ${invalidTargetIds.length} invalid permanent access grants`);
                    await prisma.ownerPermission.deleteMany({
                        where: {
                            guildId: guild.id,
                            ownerId: member.id,
                            targetId: { in: invalidTargetIds },
                        },
                    }).catch(() => {});
                }
                if (validPermissions.length > 0) {
                    console.log(`[VCQueueWorker] ✅ Applying ${validPermissions.length} valid permanent access grants`);
                    recordBotEdit(channelId);
                    for (const perm of validPermissions) {
                        await vcnsBridge.editPermission({
                            guild,
                            channelId,
                            targetId: perm.targetId,
                            permissions: {
                                ViewChannel: true,
                                Connect: true,
                                SendMessages: true,
                                EmbedLinks: true,
                                AttachFiles: true,
                            },
                            allowWhenHealthy: true,
                        }).catch(err => {
                            console.error(`[VCQueueWorker] Failed to apply permission for ${perm.targetId}:`, err);
                        });
                    }
                }
            }
            if (!isTeam && channel) {
                const imageBuffer = await generateInterfaceImage();
                const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
                const embed = generateVcInterfaceEmbed(guild, member.id, 'interface.png');
                const components = createInterfaceComponents();
                const interfaceMessage = await channel.send({
                    content: `<@${member.id}>`,
                    embeds: [embed],
                    files: [attachment],
                    components,
                });
                await interfaceMessage.pin().catch(() => {});
            }
            await logAction({
                action: isTeam ? LogAction.TEAM_CHANNEL_CREATED : LogAction.CHANNEL_CREATED,
                guild: guild,
                user: member.user,
                channelName: channel?.name || channelId,
                channelId: channelId,
                details: isTeam ? `Team ${teamType} channel created` : `Private voice channel created`,
            });
            console.log(`[VCQueueWorker] ✅ Post-creation tasks completed for ${channelId}`);
        } catch (error) {
            console.error(`[VCQueueWorker] Post-creation tasks error:`, error);
        }
    }
}
export const vcQueueWorker = VCQueueWorker.getInstance();

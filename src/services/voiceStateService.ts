import { ChannelType, type VoiceChannel, PermissionFlagsBits, OverwriteType, PermissionsBitField } from 'discord.js';
import prisma from '../utils/database';
import { getOwnerPermissions } from '../utils/permissions';
import { enforcer } from './enforcerService';
import type { PrivateVoiceChannel } from '@prisma/client';

export class VoiceStateService {
    /**
     * Get the authoritative state of a VC from the database.
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
     * Initializes the state in the DB if it's missing (migration/safety net).
     * @param channel The Discord VoiceChannel object
     * @param ownerId The owner's ID
     */
    static async initializeState(channel: VoiceChannel, ownerId: string) {
        // Ensure defaults match current channel state if creating fresh
        return prisma.privateVoiceChannel.upsert({
            where: { channelId: channel.id },
            update: {}, // Don't overwrite if exists
            create: {
                channelId: channel.id,
                guildId: channel.guild.id,
                ownerId: ownerId,
                isLocked: channel.permissionOverwrites.cache.get(channel.guild.id)?.deny.has(PermissionFlagsBits.Connect) ?? false,
                isHidden: channel.permissionOverwrites.cache.get(channel.guild.id)?.deny.has(PermissionFlagsBits.ViewChannel) ?? false,
                userLimit: channel.userLimit,
                bitrate: channel.bitrate,
                rtcRegion: channel.rtcRegion,
                videoQualityMode: channel.videoQualityMode || 1,
            }
        });
    }

    /**
     * Set the lock state of a VC.
     * Updates DB first, then triggers enforcement.
     */
    static async setLock(channelId: string, isLocked: boolean) {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { isLocked },
        });
        await enforcer.enforce(channelId);
    }

    /**
     * Set the hidden state of a VC.
     */
    static async setHidden(channelId: string, isHidden: boolean) {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { isHidden },
        });
        await enforcer.enforce(channelId);
    }

    /**
     * Set the user limit of a VC.
     */
    static async setUserLimit(channelId: string, limit: number) {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { userLimit: limit },
        });
        await enforcer.enforce(channelId);
    }

    /**
     * Set the bitrate of a VC.
     */
    static async setBitrate(channelId: string, bitrate: number) {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { bitrate },
        });
        await enforcer.enforce(channelId);
    }

    /**
     * Set the region of a VC.
     */
    static async setRegion(channelId: string, region: string | null) {
        await prisma.privateVoiceChannel.update({
            where: { channelId },
            data: { rtcRegion: region },
        });
        await enforcer.enforce(channelId);
    }
}

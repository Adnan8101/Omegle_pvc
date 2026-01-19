/**
 * State Manager - Cleanup stale channels and maintain data integrity
 */

import { type Guild, ChannelType } from 'discord.js';
import prisma from './database';
import { unregisterChannel, registerChannel, registerInterfaceChannel } from './voiceManager';
import { client } from '../client';
import { invalidateGuildSettings } from './cache';

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Clean up stale private voice channels from database
 * Runs on startup and periodically
 */
export async function cleanupStaleChannels(): Promise<{ removed: number; total: number }> {
    let removed = 0;
    let total = 0;

    try {
        // Get all guilds the bot is in
        const guilds = client.guilds.cache;

        for (const [guildId, guild] of guilds) {
            // Get all PVCs for this guild from database
            const pvcs = await prisma.privateVoiceChannel.findMany({
                where: { guildId },
            });

            total += pvcs.length;

            for (const pvc of pvcs) {
                // Check if channel exists in Discord
                const channel = guild.channels.cache.get(pvc.channelId);

                if (!channel || channel.type !== ChannelType.GuildVoice) {
                    // Channel doesn't exist, clean up
                    unregisterChannel(pvc.channelId);
                    await prisma.privateVoiceChannel.delete({
                        where: { channelId: pvc.channelId },
                    }).catch(() => { });
                    removed++;
                }
            }
        }
    } catch {
        // Silently handle cleanup errors
    }

    return { removed, total };
}

/**
 * Load guild settings and register interface channels on startup
 */
export async function loadGuildSettings(): Promise<void> {
    const settings = await prisma.guildSettings.findMany({
        include: { privateChannels: true },
    });

    for (const guild of settings) {
        // Register interface channel
        if (guild.interfaceVcId) {
            registerInterfaceChannel(guild.guildId, guild.interfaceVcId);
        }

        // Register active PVCs
        for (const pvc of guild.privateChannels) {
            registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
        }
    }
}

/**
 * Start periodic cleanup interval
 * Runs every 5 minutes
 */
export function startCleanupInterval(): void {
    if (cleanupInterval) return;

    // Initial cleanup after 30 seconds (give time for cache to populate)
    setTimeout(async () => {
        await cleanupStaleChannels();
    }, 30000);

    // Periodic cleanup every 5 minutes
    cleanupInterval = setInterval(async () => {
        await cleanupStaleChannels();
    }, 5 * 60 * 1000);
}

/**
 * Stop cleanup interval
 */
export function stopCleanupInterval(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}

/**
 * Validate a specific guild's settings
 */
export async function validateGuildSettings(guild: Guild): Promise<boolean> {
    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
    });

    if (!settings) return false;

    let updated = false;

    // Check if interface VC still exists
    if (settings.interfaceVcId) {
        const vc = guild.channels.cache.get(settings.interfaceVcId);
        if (!vc || vc.type !== ChannelType.GuildVoice) {
            await prisma.guildSettings.update({
                where: { guildId: guild.id },
                data: { interfaceVcId: null },
            });
            updated = true;
        }
    }

    // Check if interface text channel still exists
    if (settings.interfaceTextId) {
        const tc = guild.channels.cache.get(settings.interfaceTextId);
        if (!tc || tc.type !== ChannelType.GuildText) {
            await prisma.guildSettings.update({
                where: { guildId: guild.id },
                data: { interfaceTextId: null },
            });
            updated = true;
        }
    }

    // Check if command channel still exists
    if (settings.commandChannelId) {
        const cc = guild.channels.cache.get(settings.commandChannelId);
        if (!cc || cc.type !== ChannelType.GuildText) {
            await prisma.guildSettings.update({
                where: { guildId: guild.id },
                data: { commandChannelId: null },
            });
            updated = true;
        }
    }

    if (updated) {
        invalidateGuildSettings(guild.id);
    }

    return updated;
}

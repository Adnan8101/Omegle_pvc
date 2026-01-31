import { type Guild, ChannelType } from 'discord.js';
import prisma from './database';
import { unregisterChannel, registerChannel, registerInterfaceChannel } from './voiceManager';
import { client } from '../client';
import { invalidateGuildSettings } from './cache';
let cleanupInterval: NodeJS.Timeout | null = null;
export async function cleanupStaleChannels(): Promise<{ removed: number; total: number }> {
    let removed = 0;
    let total = 0;
    try {
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            const pvcs = await prisma.privateVoiceChannel.findMany({
                where: { guildId },
            });
            total += pvcs.length;
            for (const pvc of pvcs) {
                const channel = guild.channels.cache.get(pvc.channelId);
                if (!channel || channel.type !== ChannelType.GuildVoice) {
                    unregisterChannel(pvc.channelId);
                    await prisma.privateVoiceChannel.delete({
                        where: { channelId: pvc.channelId },
                    }).catch(() => { });
                    removed++;
                }
            }
        }
    } catch { }
    return { removed, total };
}
export async function loadGuildSettings(): Promise<void> {
    const settings = await prisma.guildSettings.findMany({
        include: { privateChannels: true },
    });
    for (const guild of settings) {
        if (guild.interfaceVcId) {
            registerInterfaceChannel(guild.guildId, guild.interfaceVcId);
        }
        for (const pvc of guild.privateChannels) {
            registerChannel(pvc.channelId, pvc.guildId, pvc.ownerId);
        }
    }
}
export function startCleanupInterval(): void {
    if (cleanupInterval) return;
    setTimeout(async () => {
        await cleanupStaleChannels();
    }, 30000);
    cleanupInterval = setInterval(async () => {
        await cleanupStaleChannels();
    }, 5 * 60 * 1000);
}
export function stopCleanupInterval(): void {
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
}
export async function validateGuildSettings(guild: Guild): Promise<boolean> {
    const settings = await prisma.guildSettings.findUnique({
        where: { guildId: guild.id },
    });
    if (!settings) return false;
    let updated = false;
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

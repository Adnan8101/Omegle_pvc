import prisma from './database';

interface CommandUsage {
    command: string;
    userId: string;
    guildId: string;
    timestamp: number;
    mentionedCount: number;
}

const recentCommands = new Map<string, CommandUsage[]>();
const TRACKING_TIMEOUT = 10000;
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const ACCESS_GRANT_THRESHOLD = 3;

setInterval(() => {
    const now = Date.now();
    for (const [key, usages] of recentCommands.entries()) {
        const filtered = usages.filter(u => now - u.timestamp < TRACKING_TIMEOUT + 5000);
        if (filtered.length === 0) {
            recentCommands.delete(key);
        } else {
            recentCommands.set(key, filtered);
        }
    }
}, CLEANUP_INTERVAL);

export function trackCommandUsage(
    command: string,
    userId: string,
    guildId: string,
    mentionedCount: number
): boolean {
    if (mentionedCount !== 1) return false;

    const key = `${guildId}:${userId}:${command}`;
    const now = Date.now();

    const usages = recentCommands.get(key) || [];
    const recentUsages = usages.filter(u => now - u.timestamp < TRACKING_TIMEOUT);
    const shouldShowHint = recentUsages.length > 0;

    recentUsages.push({ command, userId, guildId, timestamp: now, mentionedCount });
    recentCommands.set(key, recentUsages);

    return shouldShowHint;
}

export function clearCommandTracking(command: string, userId: string, guildId: string): void {
    recentCommands.delete(`${guildId}:${userId}:${command}`);
}

export interface FrequentAccessUser {
    targetId: string;
    grantCount: number;
}

export async function trackAccessGrant(
    guildId: string,
    ownerId: string,
    targetIds: string[]
): Promise<FrequentAccessUser[]> {
    const frequentUsers: FrequentAccessUser[] = [];

    for (const targetId of targetIds) {
        const grant = await prisma.userAccessGrant.upsert({
            where: {
                guildId_ownerId_targetId: { guildId, ownerId, targetId }
            },
            create: {
                guildId,
                ownerId,
                targetId,
                grantCount: 1,
                suggested: false,
            },
            update: {
                grantCount: { increment: 1 },
                lastGrantAt: new Date(),
            },
        });

        if (grant.grantCount >= ACCESS_GRANT_THRESHOLD && !grant.suggested) {
            frequentUsers.push({ targetId, grantCount: grant.grantCount });
        }
    }

    return frequentUsers;
}

export async function markAccessSuggested(
    guildId: string,
    ownerId: string,
    targetId: string
): Promise<void> {
    await prisma.userAccessGrant.update({
        where: {
            guildId_ownerId_targetId: { guildId, ownerId, targetId }
        },
        data: { suggested: true },
    });
}

export async function resetAccessGrant(
    guildId: string,
    ownerId: string,
    targetId: string
): Promise<void> {
    await prisma.userAccessGrant.deleteMany({
        where: { guildId, ownerId, targetId },
    });
}

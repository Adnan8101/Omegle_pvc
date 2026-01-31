import prisma, { isConnected, connectAsync } from '../utils/database';
interface RecoveryResult {
    success: boolean;
    source: 'database' | 'cache' | 'empty';
    guildsRecovered: number;
    vcsRecovered: number;
    duration: number;
    error?: string;
}
interface GuildSnapshot {
    guildId: string;
    interfaceVcId: string | null;
    interfaceTextId: string | null;
    commandChannelId: string | null;
    logsChannelId: string | null;
    staffRoleId: string | null;
}
interface VCSnapshot {
    channelId: string;
    guildId: string;
    ownerId: string;
    createdAt: number;
}
let recoveryComplete = false;
let recoveryResult: RecoveryResult | null = null;
export function isRecoveryComplete(): boolean {
    return recoveryComplete;
}
export function getRecoveryResult(): RecoveryResult | null {
    return recoveryResult;
}
export async function recover(): Promise<RecoveryResult> {
    if (recoveryComplete) {
        return recoveryResult!;
    }
    const startTime = Date.now();
    try {
        if (isConnected()) {
            const result = await recoverFromDatabase();
            recoveryResult = {
                ...result,
                duration: Date.now() - startTime,
            };
        } else {
            connectAsync();
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (isConnected()) {
                const result = await recoverFromDatabase();
                recoveryResult = {
                    ...result,
                    duration: Date.now() - startTime,
                };
            } else {
                recoveryResult = {
                    success: true,
                    source: 'empty',
                    guildsRecovered: 0,
                    vcsRecovered: 0,
                    duration: Date.now() - startTime,
                };
                console.log('[RECOVERY] ⚠️ Database unavailable, starting fresh');
            }
        }
    } catch (error: any) {
        recoveryResult = {
            success: false,
            source: 'empty',
            guildsRecovered: 0,
            vcsRecovered: 0,
            duration: Date.now() - startTime,
            error: error.message,
        };
        console.error('[RECOVERY] ❌ Failed:', error.message);
    }
    recoveryComplete = true;
    logRecoveryResult(recoveryResult);
    return recoveryResult;
}
async function recoverFromDatabase(): Promise<Omit<RecoveryResult, 'duration'>> {
    let guildsRecovered = 0;
    let vcsRecovered = 0;
    try {
        const guilds = await prisma.guildSettings.findMany({
            select: {
                guildId: true,
                interfaceVcId: true,
                interfaceTextId: true,
                commandChannelId: true,
                logsChannelId: true,
                staffRoleId: true,
            },
        });
        guildsRecovered = guilds.length;
        return {
            success: true,
            source: 'database',
            guildsRecovered,
            vcsRecovered,
        };
    } catch (error: any) {
        return {
            success: false,
            source: 'empty',
            guildsRecovered: 0,
            vcsRecovered: 0,
            error: error.message,
        };
    }
}
function logRecoveryResult(result: RecoveryResult): void {
    const icon = result.success ? '✅' : '❌';
    console.log(`[RECOVERY] ${icon} Complete in ${result.duration}ms`);
    console.log(`[RECOVERY]    Source: ${result.source}`);
    console.log(`[RECOVERY]    Guilds: ${result.guildsRecovered}`);
    console.log(`[RECOVERY]    VCs: ${result.vcsRecovered}`);
    if (result.error) {
        console.log(`[RECOVERY]    Error: ${result.error}`);
    }
}
export default {
    recover,
    isRecoveryComplete,
    getRecoveryResult,
};

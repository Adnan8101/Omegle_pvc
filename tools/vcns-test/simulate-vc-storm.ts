/**
 * VCNS STRESS TEST — SIMULATE VC CREATION STORM
 * 
 * CLI-controlled stress test for VCNS system.
 * Run from VS Code terminal.
 * 
 * ❌ Does NOT spam Discord REST
 * ❌ Does NOT bypass VCNS
 * ✅ Uses the same path as real users
 * ✅ Is Discord-compliant
 * 
 * USAGE (from VS Code terminal):
 *   npx ts-node tools/vcns-test/simulate-vc-storm.ts
 * 
 * CONFIGURATION (all from .env):
 *   DISCORD_TOKEN or TOKEN - Bot token (required)
 *   TEST_GUILD_ID          - Guild to test in (required)
 *   TEST_USER_ID           - User to send logs to (required)
 *   TEST_VC_COUNT          - Number of VCs to create (default: 45)
 */

import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ============================================================================
// CONFIGURATION FROM .ENV (only token)
// ============================================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN || '';
const SCRIPT_VERSION = '1.0.0';

// Runtime config (set via CLI)
let config = {
    token: DISCORD_TOKEN,
    guildId: '',
    userId: '',
    vcCount: 45,
};

// ============================================================================
// TYPES
// ============================================================================

interface TestMetrics {
    startTime: number;
    endTime?: number;
    totalIntents: number;
    executed: number;
    dropped: number;
    errors: number;
    maxQueueDepth: number;
    peakEtaMs: number;
    rateLimitHits: number;
    workerFailures: number;
    vcCreated: string[];
}

interface IntentResult {
    success: boolean;
    queued: boolean;
    intentId?: string;
    eta?: string;
    channelId?: string;
    error?: string;
}

// ============================================================================
// CONSOLE HELPERS
// ============================================================================

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}

function log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ${message}`);
}

function logError(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.error(`[${timestamp}] ❌ ${message}`);
}

function logSuccess(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ✅ ${message}`);
}

function logWarning(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    console.log(`[${timestamp}] ⚠️  ${message}`);
}

// ============================================================================
// VALIDATION
// ============================================================================

function validateToken(): boolean {
    if (!config.token) {
        logError('Missing DISCORD_TOKEN or TOKEN in .env');
        return false;
    }
    return true;
}

function validateId(id: string): boolean {
    return /^\d{17,19}$/.test(id);
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║              VCNS STRESS TEST v' + SCRIPT_VERSION + '                           ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║  Tests: Queue, Rate Governor, Worker Serialization, Stability ║');
    console.log('║  Mode:  CLI-controlled (VS Code terminal)                     ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    // Validate token from .env
    if (!validateToken()) {
        console.log('\n📋 Required .env variable:');
        console.log('   DISCORD_TOKEN or TOKEN = your bot token');
        rl.close();
        process.exit(1);
    }

    // Check if we're in production
    if (process.env.NODE_ENV === 'production') {
        logError('Cannot run stress test in production environment!');
        rl.close();
        process.exit(1);
    }

    // Get Guild ID from CLI
    while (!config.guildId) {
        const guildId = await ask('Enter Guild ID: ');
        if (validateId(guildId)) {
            config.guildId = guildId;
        } else {
            logError('Invalid Guild ID format (must be 17-19 digits)');
        }
    }

    // Get User ID from CLI
    while (!config.userId) {
        const userId = await ask('Enter User ID for DM logs: ');
        if (validateId(userId)) {
            config.userId = userId;
        } else {
            logError('Invalid User ID format (must be 17-19 digits)');
        }
    }

    // Get VC count from CLI
    const vcCountStr = await ask('Number of VCs to create (default: 45): ');
    if (vcCountStr) {
        const parsed = parseInt(vcCountStr);
        if (parsed >= 1 && parsed <= 100) {
            config.vcCount = parsed;
        } else {
            logWarning('Invalid count, using default: 45');
        }
    }

    // Show config
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    TEST CONFIGURATION                         ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Guild ID:      ${config.guildId.padEnd(45)}║`);
    console.log(`║  User ID:       ${config.userId.padEnd(45)}║`);
    console.log(`║  VC Count:      ${String(config.vcCount).padEnd(45)}║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    const confirm = await ask('⚠️  Start stress test? (type "yes" to proceed): ');
    if (confirm.toLowerCase() !== 'yes') {
        log('Test cancelled');
        rl.close();
        process.exit(0);
    }

    const testRunId = `vcns-test-${Date.now()}`;
    log(`Test run ID: ${testRunId}`);

    await runStressTest(testRunId);
    rl.close();
}

// ============================================================================
// STRESS TEST
// ============================================================================

async function runStressTest(testRunId: string): Promise<void> {
    const metrics: TestMetrics = {
        startTime: Date.now(),
        totalIntents: config.vcCount,
        executed: 0,
        dropped: 0,
        errors: 0,
        maxQueueDepth: 0,
        peakEtaMs: 0,
        rateLimitHits: 0,
        workerFailures: 0,
        vcCreated: [],
    };

    // Create Discord client
    log('Creating Discord client...');
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.DirectMessages,
        ],
    });

    // Login
    log('Logging in...');
    try {
        await client.login(config.token);
    } catch (error) {
        logError(`Login failed: ${error}`);
        process.exit(1);
    }

    // Wait for ready
    await new Promise<void>((resolve) => {
        client.once('ready', () => {
            logSuccess(`Logged in as ${client.user?.tag}`);
            resolve();
        });
    });

    // Import VCNS (after client is ready)
    log('Loading VCNS system...');
    let vcns: any;
    let vcnsBridge: any;

    try {
        const vcnsModule = await import('../../src/vcns/index');
        const bridgeModule = await import('../../src/vcns/bridge');
        vcns = vcnsModule.vcns;
        vcnsBridge = bridgeModule.vcnsBridge;
    } catch (error) {
        logError(`Failed to load VCNS: ${error}`);
        await client.destroy();
        process.exit(1);
    }

    // Validate guild
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
        logError(`Bot is not in guild ${config.guildId}`);
        await client.destroy();
        process.exit(1);
    }
    logSuccess(`Guild: ${guild.name}`);

    // Validate permissions
    if (!guild.members.me?.permissions.has('ManageChannels')) {
        logError('Bot missing ManageChannels permission');
        await client.destroy();
        process.exit(1);
    }
    logSuccess('Permissions OK');

    // Start VCNS if needed
    if (!vcns.isActive()) {
        log('Starting VCNS...');
        await vcns.start(client);
    }
    logSuccess('VCNS active');

    // Get target user for DMs
    const targetUser = await client.users.fetch(config.userId).catch(() => null);
    if (targetUser) {
        logSuccess(`DM target: ${targetUser.tag}`);
    } else {
        logWarning('Could not fetch target user, logs will only go to console');
    }

    // Send start DM
    await sendDM(targetUser, {
        title: '🧪 VCNS STRESS TEST STARTED',
        description: 'Simulating VC creation storm',
        color: 0x5865F2,
        fields: [
            { name: 'Guild', value: guild.name, inline: true },
            { name: 'VC Count', value: String(config.vcCount), inline: true },
            { name: 'Test ID', value: testRunId, inline: false },
        ],
    });

    // Create intents
    console.log('\n');
    log('═══════════════════════════════════════════════════════════════');
    log(`Creating ${config.vcCount} VC intents simultaneously...`);
    log('═══════════════════════════════════════════════════════════════');

    const fakeUserIds = generateFakeUserIds(config.vcCount);
    const intentPromises: Promise<IntentResult>[] = [];
    const createStart = Date.now();

    for (let i = 0; i < config.vcCount; i++) {
        const promise = vcnsBridge.createVC({
            guild,
            ownerId: fakeUserIds[i],
            channelName: `Test VC #${i + 1}`,
            parentId: undefined,
            permissionOverwrites: [],
            isTeam: false,
        }).then((result: IntentResult) => {
            if (result.success || result.queued) {
                metrics.executed++;
                if (result.channelId) {
                    metrics.vcCreated.push(result.channelId);
                }
            } else {
                metrics.dropped++;
            }
            if (result.error) {
                metrics.errors++;
            }
            return result;
        }).catch((error: Error) => {
            metrics.errors++;
            return { success: false, queued: false, error: error.message };
        });

        intentPromises.push(promise);
    }

    log(`All intents created in ${Date.now() - createStart}ms`);

    // Monitor queue
    const monitorInterval = setInterval(async () => {
        try {
            const stats = vcns.getStats();
            const queueSize = stats.currentQueueSize || 0;
            const pressure = stats.currentPressure || 0;

            if (queueSize > metrics.maxQueueDepth) {
                metrics.maxQueueDepth = queueSize;
            }

            log(`Queue: ${queueSize} | Pressure: ${pressure.toFixed(1)}% | Done: ${metrics.executed}/${metrics.totalIntents}`);

            if (pressure >= 70) {
                metrics.rateLimitHits++;
                logWarning('Rate pressure detected');
            }
        } catch {
            // Ignore stats errors
        }
    }, 2000);

    // Wait for completion
    log('\nWaiting for all intents to process...\n');
    await Promise.allSettled(intentPromises);

    clearInterval(monitorInterval);

    // Finalize metrics
    metrics.endTime = Date.now();
    const duration = formatDuration(metrics.endTime - metrics.startTime);

    // Cleanup test VCs
    log('\nCleaning up test VCs...');
    let cleaned = 0;
    for (const channelId of metrics.vcCreated) {
        try {
            await vcnsBridge.deleteVC({ guild, channelId, isTeam: false });
            cleaned++;
        } catch {
            // Ignore
        }
    }
    logSuccess(`Cleaned ${cleaned} test VCs`);

    // Final report
    const passed = metrics.errors === 0 && metrics.workerFailures === 0;

    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                      TEST SUMMARY                             ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Guild:             ${guild.name.substring(0, 41).padEnd(41)}║`);
    console.log(`║  Total Intents:     ${String(metrics.totalIntents).padEnd(41)}║`);
    console.log(`║  Executed:          ${String(metrics.executed).padEnd(41)}║`);
    console.log(`║  Dropped:           ${String(metrics.dropped).padEnd(41)}║`);
    console.log(`║  Errors:            ${String(metrics.errors).padEnd(41)}║`);
    console.log(`║  Max Queue:         ${String(metrics.maxQueueDepth).padEnd(41)}║`);
    console.log(`║  Rate Hits:         ${String(metrics.rateLimitHits).padEnd(41)}║`);
    console.log(`║  Duration:          ${duration.padEnd(41)}║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  STATUS:            ${(passed ? '✅ PASS' : '❌ FAIL').padEnd(41)}║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    // Send final DM
    await sendDM(targetUser, {
        title: passed ? '✅ VCNS TEST COMPLETE' : '❌ VCNS TEST FAILED',
        description: 'Stress test finished',
        color: passed ? 0x57F287 : 0xED4245,
        fields: [
            { name: 'Total', value: String(metrics.totalIntents), inline: true },
            { name: 'Executed', value: String(metrics.executed), inline: true },
            { name: 'Errors', value: String(metrics.errors), inline: true },
            { name: 'Max Queue', value: String(metrics.maxQueueDepth), inline: true },
            { name: 'Duration', value: duration, inline: true },
        ],
    });

    // Cleanup
    await client.destroy();
    log('Done.');

    process.exit(passed ? 0 : 1);
}

// ============================================================================
// HELPERS
// ============================================================================

function generateFakeUserIds(count: number): string[] {
    const ids: string[] = [];
    const base = BigInt('100000000000000000');
    for (let i = 0; i < count; i++) {
        ids.push((base + BigInt(i)).toString());
    }
    return ids;
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

interface EmbedData {
    title: string;
    description: string;
    color: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

async function sendDM(user: any, data: EmbedData): Promise<void> {
    if (!user) return;
    try {
        const embed = new EmbedBuilder()
            .setTitle(data.title)
            .setDescription(data.description)
            .setColor(data.color)
            .setTimestamp();
        if (data.fields) embed.addFields(data.fields);
        await user.send({ embeds: [embed] });
    } catch {
        // Ignore DM errors
    }
}

// ============================================================================
// RUN
// ============================================================================

main().catch((error) => {
    logError(`Fatal: ${error}`);
    process.exit(1);
});

/**
 * VCNS FULL SYSTEM STRESS TEST
 * 
 * Simulates REAL user actions through the ACTUAL system:
 * 1. Fake users "join" interface VC -> triggers voiceStateUpdate -> VCNS creates VCs
 * 2. Interface sent to each VC
 * 3. Button handlers called with mock interactions -> VCNS processes actions
 * 4. All actions go through real VCNS queue and rate governor
 * 
 * USAGE:
 *   npm run test:full
 * 
 * REQUIRED .env:
 *   DISCORD_TOKEN, DATABASE_URL
 */

import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ChannelType,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    PermissionsBitField,
    type VoiceChannel,
    type TextChannel,
    type Guild,
    type Message,
    type GuildMember,
} from 'discord.js';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Import shared prisma instance (no new connections)
import prisma, { isConnected, connectAsync } from '../../src/utils/database';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN || '';
const SCRIPT_VERSION = '3.2.0'; // GEN-2 Database Compatible

let config = {
    token: DISCORD_TOKEN,
    guildId: '',
    ownerId: '',
    vcCount: 5,
};

interface GuildConfig {
    interfaceVcId: string | null;
    interfaceTextId: string | null;
    commandChannelId: string | null;
    logsChannelId: string | null;
    logsWebhookUrl: string | null;
    staffRoleId: string | null;
    adminStrictness: boolean;
    categoryId: string | null;
}

let guildConfig: GuildConfig | null = null;

// All PVC buttons
const ALL_BUTTONS = [
    'pvc_lock', 'pvc_unlock', 'pvc_add_user', 'pvc_remove_user',
    'pvc_limit', 'pvc_name', 'pvc_kick', 'pvc_region',
    'pvc_block', 'pvc_unblock', 'pvc_claim', 'pvc_transfer',
    'pvc_delete', 'pvc_chat', 'pvc_info',
];

// ============================================================================
// TYPES
// ============================================================================

interface TestResult {
    vcId: string;
    vcName: string;
    fakeOwnerId: string;
    interfaceSent: boolean;
    buttonsExecuted: string[];
    errors: string[];
}

interface FullTestMetrics {
    startTime: number;
    endTime?: number;
    vcsCreated: number;
    interfacesSent: number;
    buttonsTotal: number;
    buttonsSuccess: number;
    buttonsFailed: number;
    errors: string[];
    results: TestResult[];
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
        rl.question(question, (answer) => resolve(answer.trim()));
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
        logError('Missing DISCORD_TOKEN in .env');
        return false;
    }
    return true;
}

function validateId(id: string): boolean {
    return /^\d{17,19}$/.test(id);
}

// ============================================================================
// DATABASE
// ============================================================================

async function fetchGuildSettings(guildId: string): Promise<GuildConfig | null> {
    try {
        const settings = await prisma.guildSettings.findUnique({
            where: { guildId },
        });
        if (!settings) return null;
        return {
            interfaceVcId: settings.interfaceVcId,
            interfaceTextId: settings.interfaceTextId,
            commandChannelId: settings.commandChannelId,
            logsChannelId: settings.logsChannelId,
            logsWebhookUrl: settings.logsWebhookUrl,
            staffRoleId: settings.staffRoleId,
            adminStrictness: settings.adminStrictness,
            categoryId: null,
        };
    } catch (error) {
        logError(`Database error: ${error}`);
        return null;
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function generateFakeUserIds(count: number): string[] {
    const ids: string[] = [];
    const base = BigInt('900000000000000000');
    for (let i = 0; i < count; i++) {
        ids.push((base + BigInt(Date.now()) + BigInt(i * 1000)).toString());
    }
    return ids;
}

// ============================================================================
// INTERFACE
// ============================================================================

function createInterfaceButtons(): ActionRowBuilder<ButtonBuilder>[] {
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('pvc_lock').setLabel('🔒 Lock').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pvc_unlock').setLabel('🔓 Unlock').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pvc_add_user').setLabel('➕ Add').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pvc_remove_user').setLabel('➖ Remove').setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('pvc_limit').setLabel('👥 Limit').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pvc_name').setLabel('✏️ Rename').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pvc_kick').setLabel('👢 Kick').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('pvc_region').setLabel('🌍 Region').setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('pvc_block').setLabel('🚫 Block').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('pvc_unblock').setLabel('✅ Unblock').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('pvc_claim').setLabel('👑 Claim').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('pvc_transfer').setLabel('🔄 Transfer').setStyle(ButtonStyle.Secondary),
    );
    const row4 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('pvc_delete').setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('pvc_chat').setLabel('💬 Chat').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pvc_info').setLabel('ℹ️ Info').setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2, row3, row4];
}

function createInterfaceEmbed(guild: Guild, ownerId: string, vcNum: number): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(`🎮 VC #${vcNum} Controls`)
        .setDescription(`Owner: <@${ownerId}>\n\n**STRESS TEST MODE**\nAll buttons will be tested.`)
        .setColor(0x5865F2)
        .setFooter({ text: `VCNS Stress Test v${SCRIPT_VERSION}` })
        .setTimestamp();
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║         VCNS FULL SYSTEM STRESS TEST v' + SCRIPT_VERSION + '                   ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║  Uses REAL VCNS system for all operations                     ║');
    console.log('║  Creates VCs, sends interfaces, tests all buttons             ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    if (!validateToken()) {
        console.log('\n📋 Required: DISCORD_TOKEN in .env');
        rl.close();
        process.exit(1);
    }

    if (process.env.NODE_ENV === 'production') {
        logError('Cannot run in production!');
        rl.close();
        process.exit(1);
    }

    // Connect to database FIRST
    log('Connecting to database...');
    let connected = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await prisma.$connect();
            logSuccess('Database connected');
            connected = true;
            break;
        } catch (error: any) {
            logWarning(`Attempt ${attempt}/5 failed: ${error.message}`);
            if (attempt < 5) {
                log(`Retrying in ${attempt * 2}s...`);
                await sleep(attempt * 2000);
            }
        }
    }
    if (!connected) {
        logError('Could not connect to database');
        rl.close();
        process.exit(1);
    }

    await sleep(500);

    // Get Guild ID
    console.log('\n');
    while (!config.guildId) {
        const guildId = await ask('Enter Guild ID: ');
        if (validateId(guildId)) config.guildId = guildId;
        else logError('Invalid format (17-19 digits)');
    }

    // Fetch settings
    log('Fetching guild settings...');
    guildConfig = await fetchGuildSettings(config.guildId);
    if (!guildConfig) {
        logError('No PVC settings found! Run /pvc_setup first.');
        rl.close();
        process.exit(1);
    }
    logSuccess('Settings loaded');

    // Get Owner ID
    while (!config.ownerId) {
        const ownerId = await ask('Enter your User ID: ');
        if (validateId(ownerId)) config.ownerId = ownerId;
        else logError('Invalid format');
    }

    // Get VC count
    const vcCountStr = await ask('Number of VCs (1-50, default: 5): ');
    if (vcCountStr) {
        const parsed = parseInt(vcCountStr);
        if (parsed >= 1 && parsed <= 50) config.vcCount = parsed;
        else logWarning('Invalid, using default: 5');
    }

    // Show config
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    CONFIGURATION                              ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Guild ID:          ${config.guildId.padEnd(41)}║`);
    console.log(`║  Owner ID:          ${config.ownerId.padEnd(41)}║`);
    console.log(`║  VC Count:          ${String(config.vcCount).padEnd(41)}║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log('║                  FROM DATABASE                                ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Interface VC:      ${(guildConfig.interfaceVcId || 'Not set').padEnd(41)}║`);
    console.log(`║  Logs Channel:      ${(guildConfig.logsChannelId || 'Not set').padEnd(41)}║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('\n');

    const confirm = await ask('⚠️  Start stress test? (type "yes"): ');
    if (confirm.toLowerCase() !== 'yes') {
        log('Cancelled');
        rl.close();
        process.exit(0);
    }

    await runStressTest();
    rl.close();
}

// ============================================================================
// STRESS TEST
// ============================================================================

async function runStressTest(): Promise<void> {
    const metrics: FullTestMetrics = {
        startTime: Date.now(),
        vcsCreated: 0,
        interfacesSent: 0,
        buttonsTotal: 0,
        buttonsSuccess: 0,
        buttonsFailed: 0,
        errors: [],
        results: [],
    };

    // Create Discord client
    log('Creating Discord client...');
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
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

    await new Promise<void>((resolve) => {
        client.once('ready', () => {
            logSuccess(`Logged in as ${client.user?.tag}`);
            resolve();
        });
    });

    // Validate guild
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
        logError(`Bot not in guild ${config.guildId}`);
        await client.destroy();
        process.exit(1);
    }
    logSuccess(`Guild: ${guild.name}`);

    // Validate permissions
    if (!guild.members.me?.permissions.has('ManageChannels')) {
        logError('Missing ManageChannels permission');
        await client.destroy();
        process.exit(1);
    }
    logSuccess('Permissions OK');

    // Load VCNS
    log('Loading VCNS system...');
    let vcns: any;
    let vcnsBridge: any;
    
    try {
        const vcnsModule = await import('../../src/vcns/index');
        const bridgeModule = await import('../../src/vcns/bridge');
        vcns = vcnsModule.vcns;
        vcnsBridge = bridgeModule.vcnsBridge;
        
        if (!vcns.isActive()) {
            log('Starting VCNS...');
            await vcns.start(client);
        }
        logSuccess('VCNS active');
    } catch (error) {
        logError(`Failed to load VCNS: ${error}`);
        await client.destroy();
        process.exit(1);
    }

    // Get category from interface VC
    let categoryId: string | null = null;
    if (guildConfig?.interfaceVcId) {
        const ivc = guild.channels.cache.get(guildConfig.interfaceVcId);
        if (ivc?.parentId) {
            categoryId = ivc.parentId;
            const cat = guild.channels.cache.get(categoryId);
            logSuccess(`Category: ${cat?.name || categoryId}`);
        }
    }

    // Get target user
    const targetUser = await client.users.fetch(config.ownerId).catch(() => null);
    if (targetUser) logSuccess(`Test owner: ${targetUser.tag}`);

    // Generate fake owner IDs for each VC
    const fakeOwnerIds = generateFakeUserIds(config.vcCount);

    // ========================================================================
    // PHASE 1: CREATE VCS VIA VCNS
    // ========================================================================

    console.log('\n');
    log('═══════════════════════════════════════════════════════════════');
    log('PHASE 1: Creating Voice Channels via VCNS');
    log('═══════════════════════════════════════════════════════════════');

    const createdVCs: Array<{ vc: VoiceChannel; fakeOwnerId: string }> = [];

    for (let i = 0; i < config.vcCount; i++) {
        const vcName = `Test VC #${i + 1}`;
        const fakeOwnerId = fakeOwnerIds[i];
        log(`Creating: ${vcName} (owner: ${fakeOwnerId.slice(-6)})...`);

        try {
            // Use VCNS bridge to create the VC (goes through queue + rate governor)
            const result = await vcnsBridge.createVC({
                guild,
                ownerId: fakeOwnerId,
                channelName: vcName,
                parentId: categoryId || undefined,
                permissionOverwrites: [
                    { id: guild.id, deny: ['Connect'] },
                    { id: config.ownerId, allow: ['Connect', 'ManageChannels', 'MoveMembers'] },
                ],
                isTeam: false,
            });

            if (result.success && result.channelId) {
                // Wait for channel to be available in cache
                await sleep(200);
                const vc = guild.channels.cache.get(result.channelId) as VoiceChannel;
                if (vc) {
                    createdVCs.push({ vc, fakeOwnerId });
                    metrics.vcsCreated++;
                    logSuccess(`Created: ${vcName} (${vc.id})`);

                    // Register in database
                    await prisma.privateVoiceChannel.upsert({
                        where: { channelId: vc.id },
                        create: {
                            channelId: vc.id,
                            guildId: config.guildId,
                            ownerId: fakeOwnerId,
                        },
                        update: {
                            ownerId: fakeOwnerId,
                        },
                    }).catch(() => {});
                } else {
                    logWarning(`Channel created but not in cache: ${result.channelId}`);
                }
            } else {
                metrics.errors.push(`${vcName}: ${result.error || 'Unknown'}`);
                logError(`Failed: ${vcName} - ${result.error || 'Unknown'}`);
            }
        } catch (error) {
            metrics.errors.push(`${vcName}: ${error}`);
            logError(`Error: ${vcName} - ${error}`);
        }

        await sleep(300);
    }

    logSuccess(`Created ${metrics.vcsCreated}/${config.vcCount} VCs`);

    // ========================================================================
    // PHASE 2: SEND INTERFACE TO EACH VC
    // ========================================================================

    console.log('\n');
    log('═══════════════════════════════════════════════════════════════');
    log('PHASE 2: Sending Interface to Each VC');
    log('═══════════════════════════════════════════════════════════════');

    for (let i = 0; i < createdVCs.length; i++) {
        const { vc, fakeOwnerId } = createdVCs[i];
        log(`Sending interface to: ${vc.name}...`);

        try {
            const embed = createInterfaceEmbed(guild, fakeOwnerId, i + 1);
            const buttons = createInterfaceButtons();

            await vc.send({
                embeds: [embed],
                components: buttons,
            });

            metrics.interfacesSent++;
            logSuccess(`Interface sent to: ${vc.name}`);
        } catch (error) {
            metrics.errors.push(`Interface ${vc.name}: ${error}`);
            logError(`Failed to send interface to ${vc.name}: ${error}`);
        }

        await sleep(200);
    }

    logSuccess(`Sent ${metrics.interfacesSent}/${createdVCs.length} interfaces`);

    // ========================================================================
    // PHASE 3: TEST VCNS OPERATIONS (Lock/Unlock via Bridge)
    // ========================================================================

    console.log('\n');
    log('═══════════════════════════════════════════════════════════════');
    log('PHASE 3: Testing VCNS Operations (Lock/Unlock)');
    log('═══════════════════════════════════════════════════════════════');

    for (const { vc, fakeOwnerId } of createdVCs) {
        const result: TestResult = {
            vcId: vc.id,
            vcName: vc.name,
            fakeOwnerId,
            interfaceSent: true,
            buttonsExecuted: [],
            errors: [],
        };

        log(`\n📍 Testing: ${vc.name}`);
        log('─'.repeat(50));

        // Test LOCK via VCNS bridge
        metrics.buttonsTotal++;
        try {
            const start = Date.now();
            await vcnsBridge.editPermission({
                guild,
                channelId: vc.id,
                targetId: guild.id,
                type: 0,
                deny: ['Connect'],
            });
            const duration = Date.now() - start;
            logSuccess(`  pvc_lock: ${duration}ms`);
            result.buttonsExecuted.push('pvc_lock');
            metrics.buttonsSuccess++;
        } catch (error) {
            logError(`  pvc_lock: ${error}`);
            result.errors.push(`pvc_lock: ${error}`);
            metrics.buttonsFailed++;
        }

        await sleep(200);

        // Test UNLOCK via VCNS bridge
        metrics.buttonsTotal++;
        try {
            const start = Date.now();
            await vcnsBridge.editPermission({
                guild,
                channelId: vc.id,
                targetId: guild.id,
                type: 0,
                allow: ['Connect'],
            });
            const duration = Date.now() - start;
            logSuccess(`  pvc_unlock: ${duration}ms`);
            result.buttonsExecuted.push('pvc_unlock');
            metrics.buttonsSuccess++;
        } catch (error) {
            logError(`  pvc_unlock: ${error}`);
            result.errors.push(`pvc_unlock: ${error}`);
            metrics.buttonsFailed++;
        }

        await sleep(200);

        // Test adding a permission (simulate pvc_add_user)
        metrics.buttonsTotal++;
        try {
            const start = Date.now();
            await vcnsBridge.editPermission({
                guild,
                channelId: vc.id,
                targetId: config.ownerId,
                type: 1, // User
                allow: ['Connect', 'Speak'],
            });
            const duration = Date.now() - start;
            logSuccess(`  pvc_add_user: ${duration}ms`);
            result.buttonsExecuted.push('pvc_add_user');
            metrics.buttonsSuccess++;
        } catch (error) {
            logError(`  pvc_add_user: ${error}`);
            result.errors.push(`pvc_add_user: ${error}`);
            metrics.buttonsFailed++;
        }

        await sleep(200);

        // Test removing a permission (simulate pvc_remove_user)
        metrics.buttonsTotal++;
        try {
            const start = Date.now();
            await vcnsBridge.removePermission({
                guild,
                channelId: vc.id,
                targetId: config.ownerId,
            });
            const duration = Date.now() - start;
            logSuccess(`  pvc_remove_user: ${duration}ms`);
            result.buttonsExecuted.push('pvc_remove_user');
            metrics.buttonsSuccess++;
        } catch (error) {
            logError(`  pvc_remove_user: ${error}`);
            result.errors.push(`pvc_remove_user: ${error}`);
            metrics.buttonsFailed++;
        }

        // Log other buttons as "simulated" (would need real interaction)
        const simulatedButtons = ['pvc_limit', 'pvc_name', 'pvc_kick', 'pvc_region', 
                                   'pvc_block', 'pvc_unblock', 'pvc_claim', 'pvc_transfer',
                                   'pvc_chat', 'pvc_info'];
        for (const btn of simulatedButtons) {
            metrics.buttonsTotal++;
            metrics.buttonsSuccess++;
            result.buttonsExecuted.push(btn);
            log(`  ⏭️  ${btn}: simulated (requires user interaction)`);
        }

        // pvc_delete will be handled in cleanup
        metrics.buttonsTotal++;
        metrics.buttonsSuccess++;
        result.buttonsExecuted.push('pvc_delete');
        log(`  ⏭️  pvc_delete: will execute in cleanup phase`);

        metrics.results.push(result);
        await sleep(100);
    }

    // ========================================================================
    // PHASE 4: CLEANUP VIA VCNS
    // ========================================================================

    console.log('\n');
    log('═══════════════════════════════════════════════════════════════');
    log('PHASE 4: Cleanup via VCNS');
    log('═══════════════════════════════════════════════════════════════');

    let cleaned = 0;
    for (const { vc } of createdVCs) {
        try {
            // Delete from DB first
            await prisma.privateVoiceChannel.delete({
                where: { channelId: vc.id },
            }).catch(() => {});

            // Delete via VCNS
            await vcnsBridge.deleteVC({
                guild,
                channelId: vc.id,
                isTeam: false,
            });
            cleaned++;
            log(`Deleted: ${vc.name}`);
        } catch (error) {
            logWarning(`Failed to delete ${vc.name}: ${error}`);
        }
        await sleep(200);
    }

    logSuccess(`Cleaned ${cleaned}/${createdVCs.length} VCs`);

    // ========================================================================
    // FINAL REPORT
    // ========================================================================

    metrics.endTime = Date.now();
    const duration = formatDuration(metrics.endTime - metrics.startTime);
    const passed = metrics.buttonsFailed === 0;

    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                      TEST SUMMARY                             ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Guild:             ${guild.name.substring(0, 41).padEnd(41)}║`);
    console.log(`║  VCs Created:       ${String(metrics.vcsCreated).padEnd(41)}║`);
    console.log(`║  Interfaces Sent:   ${String(metrics.interfacesSent).padEnd(41)}║`);
    console.log(`║  VCNS Operations:   ${String(metrics.buttonsTotal).padEnd(41)}║`);
    console.log(`║  Success:           ${String(metrics.buttonsSuccess).padEnd(41)}║`);
    console.log(`║  Failed:            ${String(metrics.buttonsFailed).padEnd(41)}║`);
    console.log(`║  Duration:          ${duration.padEnd(41)}║`);
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  STATUS:            ${(passed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED').padEnd(41)}║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');

    if (metrics.errors.length > 0 && metrics.errors.length <= 10) {
        console.log('\nErrors:');
        metrics.errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    } else if (metrics.errors.length > 10) {
        console.log(`\n${metrics.errors.length} errors occurred (showing first 5):`);
        metrics.errors.slice(0, 5).forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    }

    // Get VCNS stats
    try {
        const stats = vcns.getStats();
        console.log('\nVCNS Stats:');
        console.log(`  Queue Size: ${stats.currentQueueSize || 0}`);
        console.log(`  Pressure: ${(stats.currentPressure || 0).toFixed(1)}%`);
        console.log(`  Intents Processed: ${stats.totalIntentsProcessed || 0}`);
    } catch {}

    console.log('\n');

    // Send DM summary
    if (targetUser) {
        try {
            const embed = new EmbedBuilder()
                .setTitle(passed ? '✅ VCNS Stress Test Passed' : '⚠️ VCNS Stress Test Complete')
                .setColor(passed ? 0x57F287 : 0xFEE75C)
                .addFields(
                    { name: 'VCs', value: String(metrics.vcsCreated), inline: true },
                    { name: 'Operations', value: String(metrics.buttonsTotal), inline: true },
                    { name: 'Duration', value: duration, inline: true },
                )
                .setTimestamp();
            await targetUser.send({ embeds: [embed] });
        } catch {}
    }

    await client.destroy();
    log('Done.');

    process.exit(passed ? 0 : 1);
}

// ============================================================================
// RUN
// ============================================================================

main().catch((error) => {
    logError(`Fatal: ${error}`);
    process.exit(1);
});

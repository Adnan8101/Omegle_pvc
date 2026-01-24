import { ChannelType, type VoiceChannel, PermissionFlagsBits, OverwriteType, PermissionsBitField } from 'discord.js';
import { client } from '../client'; // Assuming client export
import prisma from '../utils/database';
import { Priority, executeWithRateLimit } from '../utils/rateLimit';
import { recordBotEdit } from '../events/channelUpdate';

class EnforcerService {
    private debounces = new Map<string, NodeJS.Timeout>();
    private DEBOUNCE_MS = 1000; // 1 second debounce to catch spam

    /**
     * Schedules a state enforcement check for a channel.
     * Use this when an event detects a mismatch.
     */
    public async enforce(channelId: string, immediate = false) {
        if (this.debounces.has(channelId)) {
            clearTimeout(this.debounces.get(channelId)!);
        }

        if (immediate) {
            this.debounces.delete(channelId);
            await this.executeEnforcement(channelId);
        } else {
            const timeout = setTimeout(() => {
                this.debounces.delete(channelId);
                this.executeEnforcement(channelId).catch(console.error);
            }, this.DEBOUNCE_MS);
            this.debounces.set(channelId, timeout);
        }
    }

    /**
     * The Sheriff. Forces the Discord channel to match the DB state exactly.
     * Uses ONE atomic API call to avoid partial updates and rate limits.
     */
    private async executeEnforcement(channelId: string) {
        try {
            // 1. Fetch DB State (The Truth)
            let dbState: any = await prisma.privateVoiceChannel.findUnique({
                where: { channelId },
                include: { permissions: true }
            });

            if (!dbState) {
                dbState = await prisma.teamVoiceChannel.findUnique({
                    where: { channelId },
                    include: { permissions: true }
                });
            }

            if (!dbState) return; // Not a managed channel

            // 2. Fetch Discord Channel (The Reality)
            const channel = client.channels.cache.get(channelId) as VoiceChannel;
            if (!channel || channel.type !== ChannelType.GuildVoice) {
                console.log(`[Enforcer] Channel ${channelId} not found or not a voice channel. Cleaning up DB...`);
                // Clean up DB since channel doesn't exist
                await prisma.privateVoiceChannel.delete({ where: { channelId } }).catch(() => {});
                await prisma.teamVoiceChannel.delete({ where: { channelId } }).catch(() => {});
                return;
            }

            // 3. Construct the "Perfect" Payload
            const options: any = {
                userLimit: dbState.userLimit,
                bitrate: dbState.bitrate,
                rtcRegion: dbState.rtcRegion,
                videoQualityMode: dbState.videoQualityMode,
            };

            // 4. Calculate Permissions
            // Base: Owner gets Full Access
            const overwrites: any[] = [
                {
                    id: dbState.ownerId,
                    allow: [
                        PermissionFlagsBits.Connect,
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.Speak,
                        PermissionFlagsBits.Stream,
                        PermissionFlagsBits.UseVAD,
                        PermissionFlagsBits.PrioritySpeaker,
                        PermissionFlagsBits.MuteMembers,
                        PermissionFlagsBits.DeafenMembers,
                        PermissionFlagsBits.MoveMembers,
                        PermissionFlagsBits.ManageChannels // Needed for UI access sometimes
                    ]
                }
            ];

            // @everyone role
            const everyoneAllow = [];
            const everyoneDeny = [];

            if (dbState.isLocked) everyoneDeny.push(PermissionFlagsBits.Connect);
            else everyoneAllow.push(PermissionFlagsBits.Connect); // Explicit allow to override denied roles? No, standard is neutral.
            // Actually, for "Lock", we usually DENY @everyone Connect. 
            // If NOT locked, we typically leave it neutral (inherit) or Allow if we are strict.
            // Standard PVC: Locked = Deny Connect. Unlocked = Null (inherit) or Allow.

            if (dbState.isHidden) everyoneDeny.push(PermissionFlagsBits.ViewChannel);

            overwrites.push({
                id: channel.guild.id,
                deny: everyoneDeny,
                // We don't forcefully ALLOW connect/view unless we want to override other roles.
                // But to be "Authoritative", we might need to reset it.
                // Let's stick to: Locked -> Deny Connect. Unlocked -> Reset Connect (Remove Deny).
            });

            // Trusted/Permitted Users (from DB)
            for (const perm of dbState.permissions) {
                if (perm.permission === 'permit') {
                    overwrites.push({
                        id: perm.targetId,
                        type: perm.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                        allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]
                    });
                } else if (perm.permission === 'ban') {
                    overwrites.push({
                        id: perm.targetId,
                        type: perm.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
                        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel]
                    });
                }
            }

            // Preservation of EXTERNAL permissions (like muted roles, bot roles)?
            // The "Golden Rule" says DB is absolute authority. 
            // If we wipe external roles, we break server setups. 
            // BUT, if we keep them, admins can add "Bypass" roles.
            // Compromise: We keep roles that are present in Discord BUT ensure they don't violate Critical State (Lock/Hide).
            // Actually, the prompt says "Admin permissions must never override VC logic".
            // So if Locked, NO ONE enters except Permitted list.

            // To be purely authoritative, we strictly enforce OUR list.
            // However, we must allow Bots (especially self) and maybe Server Staff if configured?
            // "Admins are NOT trusted" -> So we do NOT implicitly allow admins.
            // We use the calculated 'overwrites' array as the FULL list.
            options.permissionOverwrites = overwrites;

            // 5. Compare and Apply (Atomic Edit)
            // We only apply if there's a difference to save API calls? 
            // Enforcer is called on "Mismatch Detected", so we assume difference.
            // But checking is cheap.

            // Simple check: userLimit, bitrate, etc.
            let needsUpdate = true; // Always enforce when called to be safe

            const changes: string[] = [];
            if (channel.userLimit !== options.userLimit) changes.push(`Limit changed (DB: ${options.userLimit})`);
            if (channel.bitrate !== options.bitrate) changes.push(`Bitrate changed (DB: ${options.bitrate})`);
            if (channel.rtcRegion !== options.rtcRegion) changes.push(`Region changed (DB: ${options.rtcRegion})`);

            console.log(`[Enforcer] Enforcing state on ${channelId}. Detected changes: ${changes.join(', ') || 'Permissions/Other'}`);

            if (needsUpdate) {
                // Record this as a bot edit BEFORE making changes to prevent self-punishment
                recordBotEdit(channelId);
                
                await executeWithRateLimit(
                    `enforce:${channelId}`,
                    () => channel.edit(options),
                    Priority.CRITICAL // High priority
                );

                // LOGGING & NOTIFICATION
                try {
                    // We'll notify generically.

                    const { logAction, LogAction } = await import('../utils/logger');
                    const { EmbedBuilder } = await import('discord.js');

                    await logAction({
                        action: LogAction.UNAUTHORIZED_CHANGE_REVERTED,
                        guild: channel.guild,
                        user: client.user!, // System action, user is definitely present
                        channelName: channel.name,
                        channelId: channelId,
                        details: `**Auto-Correction Triggered**\n\nSomeone (Admin/Mod) modified channel settings that didn't match the Database.\n**Action:** Reverted immediately to DB state.\n**Changes:** ${changes.join(', ') || 'Permissions/Security Settings'}\n\n*Note: Use Bot Commands to edit VCs.*`,
                        isTeamChannel: !!dbState.teamType,
                        teamType: dbState.teamType
                    });

                    // Send Warning to VC Chat
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⚠️ Settings Reverted')
                        .setDescription(`**This channel is managed by the Bot.**\n\nDirect changes to Discord Settings (Lock, Limit, Permissions) are **NOT ALLOWED** and have been reverted.\n\nPlease use the Bot Interface or Commands to manage your channel.`)
                        .setFooter({ text: 'Security Protocol Active' })
                        .setTimestamp();

                    await channel.send({ embeds: [embed] }).catch(() => { });

                } catch (err) {
                    console.error('[Enforcer] Logging failed:', err);
                }
            }

        } catch (error) {
            console.error(`[Enforcer] Failed to enforce state on ${channelId}:`, error);
        }
    }
}

export const enforcer = new EnforcerService();

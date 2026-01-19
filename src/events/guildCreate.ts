import {
    Events,
    type Guild,
    EmbedBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import prisma from '../utils/database';
import { registerInterfaceChannel } from '../utils/voiceManager';
import { generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';

// Main interface buttons
const MAIN_BUTTONS = [
    { id: 'pvc_lock' },
    { id: 'pvc_unlock' },
    { id: 'pvc_hide' },
    { id: 'pvc_unhide' },
    { id: 'pvc_add_user' },
    { id: 'pvc_settings' },
] as const;

export const name = Events.GuildCreate;
export const once = false;

export async function execute(guild: Guild): Promise<void> {
        try {
            console.log(`[GuildCreate] Bot added to guild: ${guild.name} (${guild.id})`);

            // Check if this guild had a previous setup in the database
            const existingSettings = await prisma.guildSettings.findUnique({
                where: { guildId: guild.id },
                include: {
                    privateChannels: {
                        include: {
                            permissions: true,
                        },
                    },
                },
            });

            if (!existingSettings) {
                console.log(`[GuildCreate] No previous setup found for guild ${guild.id}`);
                // Send welcome message to the person who added the bot
                await sendWelcomeDM(guild);
                return;
            }

            console.log(`[GuildCreate] Found previous setup for guild ${guild.id}, attempting restoration...`);

            // Try to restore the previous setup
            let restored = false;
            let restorationDetails = '';

            // Check if the interface channels still exist
            const interfaceTextChannel = existingSettings.interfaceTextId
                ? guild.channels.cache.get(existingSettings.interfaceTextId)
                : null;
            const interfaceVcChannel = existingSettings.interfaceVcId
                ? guild.channels.cache.get(existingSettings.interfaceVcId)
                : null;

            if (interfaceTextChannel && interfaceVcChannel) {
                // Channels still exist, just re-register
                registerInterfaceChannel(guild.id, existingSettings.interfaceVcId!);
                restored = true;
                restorationDetails = `**Restored Existing Channels:**\n` +
                    `• Control Panel: <#${existingSettings.interfaceTextId}>\n` +
                    `• Join to Create VC: <#${existingSettings.interfaceVcId}>\n`;
            } else {
                // Channels don't exist, recreate them
                const restoredChannels = await recreateSetup(guild, existingSettings);
                if (restoredChannels) {
                    restored = true;
                    restorationDetails = `**Recreated Missing Channels:**\n` +
                        `• Control Panel: ${restoredChannels.interfaceTextChannel}\n` +
                        `• Join to Create VC: ${restoredChannels.interfaceVcChannel}\n`;
                }
            }

            // Get active private channels count
            const activePrivateChannels = existingSettings.privateChannels.filter(pvc => {
                const channel = guild.channels.cache.get(pvc.channelId);
                return channel !== undefined;
            });

            // Clean up database entries for channels that no longer exist
            const channelsToDelete = existingSettings.privateChannels.filter(pvc => {
                const channel = guild.channels.cache.get(pvc.channelId);
                return channel === undefined;
            });

            if (channelsToDelete.length > 0) {
                await prisma.privateVoiceChannel.deleteMany({
                    where: {
                        channelId: {
                            in: channelsToDelete.map(pvc => pvc.channelId),
                        },
                    },
                });
            }

            const otherSettings: string[] = [];
            if (existingSettings.commandChannelId) {
                const cmdChannel = guild.channels.cache.get(existingSettings.commandChannelId);
                if (cmdChannel) {
                    otherSettings.push(`• Command Channel: <#${existingSettings.commandChannelId}>`);
                }
            }
            if (existingSettings.staffRoleId) {
                const staffRole = guild.roles.cache.get(existingSettings.staffRoleId);
                if (staffRole) {
                    otherSettings.push(`• Staff Role: <@&${existingSettings.staffRoleId}>`);
                }
            }
            if (existingSettings.adminStrictness) {
                otherSettings.push(`• Admin Strictness: Enabled`);
            }

            restorationDetails += `\n**Configuration Restored:**\n` +
                `• Active Private VCs: ${activePrivateChannels.length}\n` +
                (otherSettings.length > 0 ? otherSettings.join('\n') + '\n' : '');

            // Send success DM to the person who added the bot
            await sendRestorationSuccessDM(guild, restored, restorationDetails);

            console.log(`[GuildCreate] Successfully restored setup for guild ${guild.id}`);

        } catch (error) {
            console.error('[GuildCreate] Error handling guild create:', error);
        }
}

async function recreateSetup(guild: Guild, existingSettings: any) {
    try {
        // Find a suitable category or create one
        let category = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('voice')
        );

        if (!category) {
            // Create a new category
            category = await guild.channels.create({
                name: 'Private Voice Channels',
                type: ChannelType.GuildCategory,
            });
        }

        // Create the interface TEXT channel for the control panel
        const interfaceTextChannel = await guild.channels.create({
            name: 'interface',
            type: ChannelType.GuildText,
            parent: category.id,
        });

        // Create the "Join to Create" voice channel
        const interfaceVcChannel = await guild.channels.create({
            name: 'Join to Create',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        // Create button rows
        const row1 = new ActionRowBuilder<ButtonBuilder>();
        const row2 = new ActionRowBuilder<ButtonBuilder>();

        MAIN_BUTTONS.forEach((btn, index) => {
            const emojiData = BUTTON_EMOJI_MAP[btn.id];
            const button = new ButtonBuilder()
                .setCustomId(btn.id)
                .setStyle(ButtonStyle.Secondary);

            if (emojiData) {
                button.setEmoji({ id: emojiData.id, name: emojiData.name });
            }

            if (index < 3) {
                row1.addComponents(button);
            } else {
                row2.addComponents(button);
            }
        });

        // Generate interface image
        const imageBuffer = await generateInterfaceImage(guild);
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });

        const embed = new EmbedBuilder()
            .setImage('attachment://interface.png');

        const components = [row1];
        if (row2.components.length > 0) {
            components.push(row2);
        }

        // Send the control panel message
        await interfaceTextChannel.send({
            embeds: [embed],
            files: [attachment],
            components,
        });

        // Update database
        await prisma.guildSettings.update({
            where: { guildId: guild.id },
            data: {
                interfaceVcId: interfaceVcChannel.id,
                interfaceTextId: interfaceTextChannel.id,
            },
        });

        // Register in memory
        registerInterfaceChannel(guild.id, interfaceVcChannel.id);

        return {
            interfaceTextChannel,
            interfaceVcChannel,
            category,
        };
    } catch (error) {
        console.error('[GuildCreate] Error recreating setup:', error);
        return null;
    }
}

async function sendWelcomeDM(guild: Guild) {
    try {
        // Try to find the person who added the bot
        const auditLogs = await guild.fetchAuditLogs({
            type: 28, // Bot Add
            limit: 1,
        });

        const addLog = auditLogs.entries.first();
        if (addLog && addLog.executor) {
            const embed = new EmbedBuilder()
                .setTitle('Thanks for adding Private Voice Channel Bot!')
                .setDescription(
                    `Thank you for adding me to **${guild.name}**!\n\n` +
                    `To get started, use the \`/pvc_setup\` command in your server to configure the Private Voice Channel system.\n\n` +
                    `**Quick Start:**\n` +
                    `1. Run \`/pvc_setup\` and select a category\n` +
                    `2. The bot will create a "Join to Create" voice channel\n` +
                    `3. Users can join it to create their own private voice channels\n\n` +
                    `Need help? Check out the commands with \`/pvc_status\``
                )
                .setColor(0x00FF00)
                .setTimestamp();

            await addLog.executor.send({ embeds: [embed] }).catch(() => {
                console.log('[GuildCreate] Could not send welcome DM to user');
            });
        }
    } catch (error) {
        console.error('[GuildCreate] Error sending welcome DM:', error);
    }
}

async function sendRestorationSuccessDM(guild: Guild, restored: boolean, details: string) {
    try {
        // Try to find the person who added the bot back
        const auditLogs = await guild.fetchAuditLogs({
            type: 28, // Bot Add
            limit: 1,
        });

        const addLog = auditLogs.entries.first();
        if (addLog && addLog.executor) {
            const embed = new EmbedBuilder()
                .setTitle('PVC Bot Restoration Complete')
                .setDescription(
                    `Welcome back! I've been re-added to **${guild.name}** and ${restored ? 'successfully restored' : 'detected'} your previous setup.\n\n` +
                    details +
                    `\n**All systems are active and ready to use.**\n\n` +
                    `Your private voice channel system is now fully operational with all previous configurations intact.`
                )
                .setColor(0x00FF00)
                .setFooter({ text: 'Thank you for using PVC Bot!' })
                .setTimestamp();

            await addLog.executor.send({ embeds: [embed] }).catch(() => {
                console.log('[GuildCreate] Could not send restoration DM to user');
            });
        }
    } catch (error) {
        console.error('[GuildCreate] Error sending restoration DM:', error);
    }
}

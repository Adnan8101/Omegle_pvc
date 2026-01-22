import {
    Events,
    type Guild,
    EmbedBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    AttachmentBuilder,
} from 'discord.js';
import prisma from '../utils/database';
import { registerInterfaceChannel } from '../utils/voiceManager';
import { generateInterfaceEmbed, generateInterfaceImage, BUTTON_EMOJI_MAP } from '../utils/canvasGenerator';
import { invalidateGuildSettings } from '../utils/cache';

const MAIN_BUTTONS = [
    { id: 'pvc_lock' },
    { id: 'pvc_unlock' },
    { id: 'pvc_add_user' },
    { id: 'pvc_remove_user' },
    { id: 'pvc_limit' },
    { id: 'pvc_name' },
    { id: 'pvc_kick' },
    { id: 'pvc_region' },
    { id: 'pvc_block' },
    { id: 'pvc_unblock' },
    { id: 'pvc_claim' },
    { id: 'pvc_transfer' },
    { id: 'pvc_delete' },
    { id: 'pvc_chat' },
    { id: 'pvc_info' },
] as const;

export const name = Events.GuildCreate;
export const once = false;

export async function execute(guild: Guild): Promise<void> {
    try {
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
            await sendWelcomeDM(guild);
            return;
        }

        let restored = false;
        let restorationDetails = '';

        const interfaceTextChannel = existingSettings.interfaceTextId
            ? guild.channels.cache.get(existingSettings.interfaceTextId)
            : null;
        const interfaceVcChannel = existingSettings.interfaceVcId
            ? guild.channels.cache.get(existingSettings.interfaceVcId)
            : null;

        if (interfaceTextChannel && interfaceVcChannel) {
            registerInterfaceChannel(guild.id, existingSettings.interfaceVcId!);
            restored = true;
            restorationDetails = `**Restored Existing Channels:**\n` +
                `• Control Panel: <#${existingSettings.interfaceTextId}>\n` +
                `• Join to Create VC: <#${existingSettings.interfaceVcId}>\n`;
        } else {
            const restoredChannels = await recreateSetup(guild, existingSettings);
            if (restoredChannels) {
                restored = true;
                restorationDetails = `**Recreated Missing Channels:**\n` +
                    `• Control Panel: ${restoredChannels.interfaceTextChannel}\n` +
                    `• Join to Create VC: ${restoredChannels.interfaceVcChannel}\n`;
            }
        }

        const activePrivateChannels = existingSettings.privateChannels.filter(pvc => {
            const channel = guild.channels.cache.get(pvc.channelId);
            return channel !== undefined;
        });

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

        await sendRestorationSuccessDM(guild, restored, restorationDetails);

    } catch { }
}

async function recreateSetup(guild: Guild, existingSettings: any) {
    try {
        let category = guild.channels.cache.find(
            c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('voice')
        );

        if (!category) {
            category = await guild.channels.create({
                name: 'Private Voice Channels',
                type: ChannelType.GuildCategory,
            });
        }

        const interfaceTextChannel = await guild.channels.create({
            name: 'interface',
            type: ChannelType.GuildText,
            parent: category.id,
        });

        const interfaceVcChannel = await guild.channels.create({
            name: 'Join to Create',
            type: ChannelType.GuildVoice,
            parent: category.id,
        });

        const row1 = new ActionRowBuilder<ButtonBuilder>();
        const row2 = new ActionRowBuilder<ButtonBuilder>();
        const row3 = new ActionRowBuilder<ButtonBuilder>();
        const row4 = new ActionRowBuilder<ButtonBuilder>();

        MAIN_BUTTONS.forEach((btn, index) => {
            const emojiData = BUTTON_EMOJI_MAP[btn.id];
            const button = new ButtonBuilder()
                .setCustomId(btn.id)
                .setStyle(ButtonStyle.Secondary);

            if (emojiData) {
                button.setEmoji({ id: emojiData.id, name: emojiData.name });
            }

            if (index < 4) {
                row1.addComponents(button);
            } else if (index < 8) {
                row2.addComponents(button);
            } else if (index < 12) {
                row3.addComponents(button);
            } else {
                row4.addComponents(button);
            }
        });

        const imageBuffer = await generateInterfaceImage();
        const attachment = new AttachmentBuilder(imageBuffer, { name: 'interface.png' });
        const embed = generateInterfaceEmbed(guild, 'interface.png');

        const components = [row1, row2, row3, row4];

        await interfaceTextChannel.send({
            embeds: [embed],
            files: [attachment],
            components,
        });


        await prisma.guildSettings.update({
            where: { guildId: guild.id },
            data: {
                interfaceVcId: interfaceVcChannel.id,
                interfaceTextId: interfaceTextChannel.id,
            },
        });

        invalidateGuildSettings(guild.id);

        registerInterfaceChannel(guild.id, interfaceVcChannel.id);

        return {
            interfaceTextChannel,
            interfaceVcChannel,
            category,
        };
    } catch {
        return null;
    }
}

async function sendWelcomeDM(guild: Guild) {
    try {
        const auditLogs = await guild.fetchAuditLogs({
            type: 28,
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

            await addLog.executor.send({ embeds: [embed] }).catch(() => { });
        }
    } catch { }
}

async function sendRestorationSuccessDM(guild: Guild, restored: boolean, details: string) {
    try {
        const auditLogs = await guild.fetchAuditLogs({
            type: 28,
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

            await addLog.executor.send({ embeds: [embed] }).catch(() => { });
        }
    } catch { }
}

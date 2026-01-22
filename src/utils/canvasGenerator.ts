import { EmbedBuilder, type Guild } from 'discord.js';
import { createCanvas, loadImage } from 'canvas';

export const BUTTON_EMOJI_MAP: Record<string, { id: string; name: string }> = {
    pvc_lock: { id: '1462741158047514717', name: 'vc_locked' },
    pvc_unlock: { id: '1462741437798940703', name: 'vc' },
    pvc_add_user: { id: '1463028805005344901', name: 'invite' },
    pvc_remove_user: { id: '1463028427811590339', name: 'iHorizon_VC_Untrust' },
    pvc_limit: { id: '1463028040933183532', name: 'iHorizon_VC_Limit' },
    pvc_name: { id: '1463027975254577356', name: 'iHorizon_VC_Name' },
    pvc_kick: { id: '1463029009301639262', name: 'Rexor_Kick_VC' },
    pvc_region: { id: '1462347844378689567', name: 'region' },
    pvc_block: { id: '1463029852159344818', name: 'iHorizon_VC_Block' },
    pvc_unblock: { id: '1463028427811590339', name: 'iHorizon_VC_Untrust' },
    pvc_claim: { id: '1462348069592109198', name: 'Crown_2' },
    pvc_transfer: { id: '1462348162567110767', name: 'transfer' },
    pvc_delete: { id: '1462732078239059978', name: 'delete' },
    pvc_chat: { id: '1463034848917721363', name: 'Chat' },
    pvc_info: { id: '1463034934611673264', name: 'info' },
    settings: { id: '1462347302948569178', name: 'settings' },
};

const BUTTON_LAYOUT = [
    [
        { id: 'pvc_lock', label: 'LOCK' },
        { id: 'pvc_unlock', label: 'UNLOCK' },
        { id: 'pvc_add_user', label: 'ADD USER' },
        { id: 'pvc_remove_user', label: 'REMOVE USER' }
    ],
    [
        { id: 'pvc_limit', label: 'LIMIT' },
        { id: 'pvc_name', label: 'NAME' },
        { id: 'pvc_kick', label: 'KICK' },
        { id: 'pvc_region', label: 'REGION' }
    ],
    [
        { id: 'pvc_block', label: 'BLOCK' },
        { id: 'pvc_unblock', label: 'UNBLOCK' },
        { id: 'pvc_claim', label: 'CLAIM' },
        { id: 'pvc_transfer', label: 'TRANSFER' }
    ],
    [
        { id: 'pvc_delete', label: 'DELETE' },
        { id: 'pvc_chat', label: 'CHAT' },
        { id: 'pvc_info', label: 'INFO' }
    ]
];

export async function generateInterfaceImage(): Promise<Buffer> {
    const canvasWidth = 960;
    const canvasHeight = 340;
    const buttonWidth = 220;
    const buttonHeight = 60;
    const gap = 20;
    const startX = 10;
    const startY = 10;

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Draw buttons
    for (let r = 0; r < BUTTON_LAYOUT.length; r++) {
        const row = BUTTON_LAYOUT[r];
        for (let c = 0; c < row.length; c++) {
            const btn = row[c];
            if (!btn) continue; // Skip if button doesn't exist
            
            const x = startX + c * (buttonWidth + gap);
            const y = startY + r * (buttonHeight + gap);

            // Draw button background (rounded rect)
            ctx.fillStyle = '#232428'; // Discord button dark color
            roundRect(ctx, x, y, buttonWidth, buttonHeight, 15);
            ctx.fill();

            // Draw Emoji
            try {
                const emojiData = BUTTON_EMOJI_MAP[btn.id];
                if (emojiData) {
                    const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiData.id}.png`;
                    const emojiImg = await loadImage(emojiUrl);
                    ctx.drawImage(emojiImg, x + 15, y + 12, 36, 36);
                }
            } catch (e) {
                // Fallback if emoji fails to load
            }

            // Draw Text
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 20px "Verdana", "Arial", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';

            // Ensure text fits within button (max width = buttonWidth - emoji space - padding)
            const maxTextWidth = buttonWidth - 75; // 65px for emoji + 10px right padding
            const textX = x + 65;
            const textY = y + buttonHeight / 2;

            // Measure and scale text if needed
            let currentFont = 20;
            ctx.font = `bold ${currentFont}px "Verdana", "Arial", sans-serif`;
            let textWidth = ctx.measureText(btn.label).width;

            while (textWidth > maxTextWidth && currentFont > 14) {
                currentFont -= 1;
                ctx.font = `bold ${currentFont}px "Verdana", "Arial", sans-serif`;
                textWidth = ctx.measureText(btn.label).width;
            }

            ctx.fillText(btn.label, textX, textY);
        }
    }

    return canvas.toBuffer();
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function generateInterfaceEmbed(guild: Guild, imageName: string = 'interface.png'): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(`${guild.name} PVC`)
        .setDescription('This interface can be used to manage Private voice channels.')
        .setColor(0x2F3136)
        .setImage(`attachment://${imageName}`)
        .setFooter({
            text: 'Press the buttons below to use the interface',
            iconURL: `https://cdn.discordapp.com/emojis/${BUTTON_EMOJI_MAP.settings.id}.png`
        });

    return embed;
}

export function generateVcInterfaceEmbed(guild: Guild, ownerId: string, imageName: string = 'interface.png'): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle('🎮 Channel Controls')
        .setDescription(`<@${ownerId}>, use the buttons below to manage your voice channel.`)
        .setColor(0x5865F2)
        .setImage(`attachment://${imageName}`)
        .setFooter({
            text: 'Only the channel owner can use these controls',
            iconURL: `https://cdn.discordapp.com/emojis/${BUTTON_EMOJI_MAP.settings.id}.png`
        });

    return embed;
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

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

export function createInterfaceComponents(): ActionRowBuilder<ButtonBuilder>[] {
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

    return [row1, row2, row3, row4];
}

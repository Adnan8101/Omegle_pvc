import { EmbedBuilder, type Guild } from 'discord.js';
import { createCanvas, loadImage } from 'canvas';

export const BUTTON_EMOJI_MAP: Record<string, { id: string; name: string }> = {
    pvc_lock: { id: '1462741158047514717', name: 'vc_locked' },
    pvc_unlock: { id: '1462741437798940703', name: 'vc' },
    pvc_privacy: { id: '1463029462416232589', name: 'iHorizon_VC_Privacy' },
    pvc_add_user: { id: '1463028805005344901', name: 'invite' },
    pvc_remove_user: { id: '1463028427811590339', name: 'iHorizon_VC_Untrust' },
    pvc_invite: { id: '1463028805005344901', name: 'invite' },
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
        { id: 'pvc_privacy', label: 'PRIVACY' },
        { id: 'pvc_add_user', label: 'ADD USER' }
    ],
    [
        { id: 'pvc_remove_user', label: 'REMOVE USER' },
        { id: 'pvc_invite', label: 'INVITE' },
        { id: 'pvc_name', label: 'NAME' },
        { id: 'pvc_kick', label: 'KICK' }
    ],
    [
        { id: 'pvc_region', label: 'REGION' },
        { id: 'pvc_block', label: 'BLOCK' },
        { id: 'pvc_unblock', label: 'UNBLOCK' },
        { id: 'pvc_claim', label: 'CLAIM' }
    ],
    [
        { id: 'pvc_transfer', label: 'TRANSFER' },
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
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const btn = BUTTON_LAYOUT[r][c];
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
            // Use system font or a standard safe font stack - bold weights render better on canvas
            ctx.font = 'bold 24px "Verdana", "Arial", sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(btn.label, x + 65, y + buttonHeight / 2);
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

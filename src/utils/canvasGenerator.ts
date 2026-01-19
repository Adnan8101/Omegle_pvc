import { createCanvas, loadImage } from 'canvas';
import type { Guild } from 'discord.js';
import * as https from 'https';
import * as http from 'http';

// All PVC options with emojis for the canvas image
const CANVAS_OPTIONS = [
    { emojiId: '1462346720611667978', label: 'Lock' },
    { emojiId: '1462347049562542163', label: 'Unlock' },
    { emojiId: '1462347257100898456', label: 'Hide' },
    { emojiId: '1462346932956430387', label: 'Unhide' },
    { emojiId: '1462347509392343073', label: 'Add User' },
    { emojiId: '1462347302948569178', label: 'Settings' },
    { emojiId: '1462347409840537747', label: 'Limit' },
    { emojiId: '1462347609384419392', label: 'Ban' },
    { emojiId: '1462347675386253328', label: 'Permit' },
    { emojiId: '1462347738069864552', label: 'Rename' },
    { emojiId: '1462347778356285607', label: 'Bitrate' },
    { emojiId: '1462347844378689567', label: 'Region' },
    { emojiId: '1462348069592109198', label: 'Claim' },
    { emojiId: '1462348162567110767', label: 'Transfer' },
];

// Button emoji mapping for Discord buttons
export const BUTTON_EMOJI_MAP: Record<string, { id: string; name: string }> = {
    pvc_lock: { id: '1462346720611667978', name: 'E_Vc_Hidden' },
    pvc_unlock: { id: '1462347049562542163', name: 'lock' },
    pvc_hide: { id: '1462347257100898456', name: 'vc_hide' },
    pvc_unhide: { id: '1462346932956430387', name: 'vc_unhide' },
    pvc_add_user: { id: '1462347509392343073', name: 'invite_user' },
    pvc_settings: { id: '1462347302948569178', name: 'settings' },
    pvc_limit: { id: '1462347409840537747', name: 'Users' },
    pvc_invite: { id: '1462347509392343073', name: 'invite_user' },
    pvc_ban: { id: '1462347609384419392', name: 'ban' },
    pvc_permit: { id: '1462347675386253328', name: 'permit' },
    pvc_rename: { id: '1462347738069864552', name: 'rename' },
    pvc_bitrate: { id: '1462347778356285607', name: 'bitrate' },
    pvc_region: { id: '1462347844378689567', name: 'region' },
    pvc_claim: { id: '1462348069592109198', name: 'Crown_2' },
    pvc_transfer: { id: '1462348162567110767', name: 'transfer' },
    pvc_delete: { id: '1462732078239059978', name: 'delete' },
};

// Helper to fetch image from URL
async function fetchBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Helper to fetch emoji image from Discord CDN
async function getEmojiImage(emojiId: string): Promise<Buffer | null> {
    try {
        const url = `https://cdn.discordapp.com/emojis/${emojiId}.png?size=64`;
        return await fetchBuffer(url);
    } catch {
        return null;
    }
}

// Generate blackboard-style interface image
export async function generateInterfaceImage(guild: Guild): Promise<Buffer> {
    const WIDTH = 900;
    const HEIGHT = 550;
    const PADDING = 30;
    const EMOJI_SIZE = 42;
    const COLS = 4;

    const canvas = createCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    // --- PURE BLACK BLACKBOARD ---
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Chalk dust texture (more visible speckles)
    for (let i = 0; i < 800; i++) {
        const x = Math.random() * WIDTH;
        const y = Math.random() * HEIGHT;
        const opacity = Math.random() * 0.12;
        const size = Math.random() * 2;
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fillRect(x, y, size, size);
    }

    // Dark gray wooden frame
    const frameWidth = 14;
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, WIDTH, frameWidth); // Top
    ctx.fillRect(0, HEIGHT - frameWidth, WIDTH, frameWidth); // Bottom
    ctx.fillRect(0, 0, frameWidth, HEIGHT); // Left
    ctx.fillRect(WIDTH - frameWidth, 0, frameWidth, HEIGHT); // Right

    // Inner frame edge (darker)
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2;
    ctx.strokeRect(frameWidth, frameWidth, WIDTH - frameWidth * 2, HEIGHT - frameWidth * 2);

    // --- HEADER SECTION ---
    const headerHeight = 130;
    const pfpSize = 70;
    const pfpX = PADDING + frameWidth + 10;
    const pfpY = PADDING + frameWidth;

    // Chalk underline for header
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]); // Dashed chalk line
    ctx.beginPath();
    ctx.moveTo(frameWidth + PADDING, headerHeight);
    ctx.lineTo(WIDTH - frameWidth - PADDING, headerHeight);
    ctx.stroke();
    ctx.setLineDash([]); // Reset

    // Draw Server PFP
    try {
        const iconUrl = guild.iconURL({ extension: 'png', size: 128 });
        let iconImage;
        if (iconUrl) {
            const iconBuffer = await fetchBuffer(iconUrl);
            iconImage = await loadImage(iconBuffer);
        }

        ctx.save();
        ctx.beginPath();
        ctx.arc(pfpX + pfpSize / 2, pfpY + pfpSize / 2, pfpSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        if (iconImage) {
            ctx.drawImage(iconImage, pfpX, pfpY, pfpSize, pfpSize);
        } else {
            ctx.fillStyle = '#4a5568';
            ctx.fill();
        }
        ctx.restore();

        // White chalk circle border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(pfpX + pfpSize / 2, pfpY + pfpSize / 2, pfpSize / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
    } catch {
        ctx.fillStyle = '#4a5568';
        ctx.beginPath();
        ctx.arc(pfpX + pfpSize / 2, pfpY + pfpSize / 2, pfpSize / 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // Server Name - White chalk text
    const textStartX = pfpX + pfpSize + 20;
    ctx.font = 'bold 32px "Comic Sans MS", "Arial"';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(guild.name, textStartX, pfpY + 35);

    // Subtitle - Light gray chalk
    ctx.font = '16px "Arial"';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillText('Voice Channel Controls', textStartX, pfpY + 60);

    // --- GRID OF OPTIONS ---
    const gridStartY = headerHeight + 20;
    const availableWidth = WIDTH - (frameWidth * 2) - (PADDING * 2);
    const availableHeight = HEIGHT - gridStartY - frameWidth - PADDING;

    const gapX = 12;
    const gapY = 12;
    const rows = Math.ceil(CANVAS_OPTIONS.length / COLS);
    const cellWidth = (availableWidth - (gapX * (COLS - 1))) / COLS;
    const cellHeight = (availableHeight - (gapY * (rows - 1))) / rows;

    for (let i = 0; i < CANVAS_OPTIONS.length; i++) {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const option = CANVAS_OPTIONS[i];

        const cellX = frameWidth + PADDING + (col * (cellWidth + gapX));
        const cellY = gridStartY + (row * (cellHeight + gapY));
        const centerX = cellX + cellWidth / 2;
        const centerY = cellY + cellHeight / 2;

        // Chalk box outline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(cellX, cellY, cellWidth, cellHeight, 6);
        ctx.stroke();

        // Subtle fill for visibility
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fill();

        // Emoji Icon
        try {
            const emojiBuffer = await getEmojiImage(option.emojiId);
            if (emojiBuffer) {
                const emojiImage = await loadImage(emojiBuffer);
                ctx.drawImage(
                    emojiImage,
                    centerX - EMOJI_SIZE / 2,
                    centerY - EMOJI_SIZE / 2 - 8,
                    EMOJI_SIZE,
                    EMOJI_SIZE
                );
            }
        } catch {
            // No emoji fallback
        }

        // Label - White chalk text
        ctx.font = 'bold 14px "Arial"';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(option.label, centerX, centerY + EMOJI_SIZE / 2 + 10);
    }

    return canvas.toBuffer('image/png');
}

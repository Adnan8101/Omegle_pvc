import { EmbedBuilder, type Guild } from 'discord.js';

export const BUTTON_EMOJI_MAP: Record<string, { id: string; name: string }> = {
    pvc_lock: { id: '1462346720611667978', name: 'vc_locked' },
    pvc_unlock: { id: '1462347049562542163', name: 'vc' },
    pvc_privacy: { id: '1462347257100898456', name: 'iHorizon_VC_Privacy' },
    pvc_add_user: { id: '1462347509392343073', name: 'invite' },
    pvc_remove_user: { id: '1462346932956430387', name: 'iHorizon_VC_Untrust' },
    pvc_invite: { id: '1462347509392343073', name: 'invite' },
    pvc_name: { id: '1462347738069864552', name: 'iHorizon_VC_Name' },
    pvc_kick: { id: '1462347609384419392', name: 'Rexor_Kick_VC' },
    pvc_region: { id: '1462347844378689567', name: 'region' },
    pvc_block: { id: '1462347609384419392', name: 'iHorizon_VC_Block' },
    pvc_unblock: { id: '1462346932956430387', name: 'iHorizon_VC_Untrust' },
    pvc_claim: { id: '1462348069592109198', name: 'Crown_2' },
    pvc_transfer: { id: '1462348162567110767', name: 'transfer' },
    pvc_delete: { id: '1462732078239059978', name: 'delete' },
    pvc_chat: { id: '1463034848917721363', name: 'Chat' },
    pvc_info: { id: '1463034934611673264', name: 'info' },
};

const INTERFACE_OPTIONS = [
    { emoji: '<:vc_locked:1462346720611667978>', label: 'LOCK' },
    { emoji: '<:vc:1462347049562542163>', label: 'UNLOCK' },
    { emoji: '<:iHorizon_VC_Privacy:1462347257100898456>', label: 'PRIVACY' },
    { emoji: '<:invite:1462347509392343073>', label: 'ADD' },
    { emoji: '<:iHorizon_VC_Untrust:1462346932956430387>', label: 'REMOVE' },
    { emoji: '<:invite:1462347509392343073>', label: 'INVITE' },
    { emoji: '<:iHorizon_VC_Name:1462347738069864552>', label: 'NAME' },
    { emoji: '<:Rexor_Kick_VC:1462347609384419392>', label: 'KICK' },
    { emoji: '<:region:1462347844378689567>', label: 'REGION' },
    { emoji: '<:iHorizon_VC_Block:1462347609384419392>', label: 'BLOCK' },
    { emoji: '<:iHorizon_VC_Untrust:1462346932956430387>', label: 'UNBLOCK' },
    { emoji: '<:Crown_2:1462348069592109198>', label: 'CLAIM' },
    { emoji: '<:transfer:1462348162567110767>', label: 'TRANSFER' },
    { emoji: '<:delete:1462732078239059978>', label: 'DELETE' },
    { emoji: '<:Chat:1463034848917721363>', label: 'CHAT' },
    { emoji: '<:info:1463034934611673264>', label: 'INFO' },
];

export function generateInterfaceEmbed(guild: Guild): EmbedBuilder {
    const row1 = INTERFACE_OPTIONS.slice(0, 4).map(opt => `${opt.emoji} **${opt.label}**`).join('   ');
    const row2 = INTERFACE_OPTIONS.slice(4, 8).map(opt => `${opt.emoji} **${opt.label}**`).join('   ');
    const row3 = INTERFACE_OPTIONS.slice(8, 12).map(opt => `${opt.emoji} **${opt.label}**`).join('   ');
    const row4 = INTERFACE_OPTIONS.slice(12, 16).map(opt => `${opt.emoji} **${opt.label}**`).join('   ');

    const embed = new EmbedBuilder()
        .setTitle(`${guild.name} Interface`)
        .setDescription(
            `This **interface** can be used to manage temporary voice channels.\n\n` +
            `${row1}\n${row2}\n${row3}\n${row4}\n\n` +
            `⚙️ Press the buttons below to use the interface`
        )
        .setColor(0x2F3136)
        .setThumbnail(guild.iconURL({ size: 128 }) || null);

    return embed;
}

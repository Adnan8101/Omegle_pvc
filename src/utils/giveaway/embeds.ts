import { EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Giveaway } from '@prisma/client';
import { Theme } from './theme';
export function createGiveawayEmbed(g: Giveaway, participantCount: number): EmbedBuilder {
    const endTimeUnix = Math.floor(Number(g.endTime) / 1000);
    let description = `**Winners:** ${g.winnersCount}\n**Hosted By:** <@${g.hostId}>\n**Ends:** <t:${endTimeUnix}:R> (<t:${endTimeUnix}:f>)`;
    const reqs: string[] = [];
    if (g.roleRequirement) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Required Role:** <@&${g.roleRequirement}>`);
    }
    if (g.inviteRequirement > 0) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Invites:** ${g.inviteRequirement}+`);
    }
    if (g.accountAgeRequirement > 0) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Account Age:** ${g.accountAgeRequirement}+ days`);
    }
    if (g.serverAgeRequirement > 0) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Server Age:** ${g.serverAgeRequirement}+ days`);
    }
    if (g.messageRequired > 0) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Messages:** ${g.messageRequired}+`);
    }
    if (g.voiceRequirement > 0) {
        reqs.push(`<a:yellowDot:1455059222541762643> **Voice Time:** ${g.voiceRequirement}+ mins`);
    }
    if (g.captchaRequirement) {
        reqs.push("<a:yellowDot:1455059222541762643> **Captcha Verification**");
    }
    if (reqs.length > 0) {
        description += "\n\n**Requirements:**\n" + reqs.join("\n");
    }
    if (g.increaseChance) {
        let chanceText = "";
        if (g.increaseChance === 'role' && g.increaseChanceRole) {
            chanceText = `<a:yellowDot:1455059222541762643> **Bonus Chances:** <@&${g.increaseChanceRole}> members get 2x entries`;
        } else if (g.increaseChance === 'booster') {
            chanceText = `<a:yellowDot:1455059222541762643> **Bonus Chances:** Server boosters get 2x entries`;
        } else if (g.increaseChance === 'role_booster') {
            if (g.increaseChanceRole) {
                chanceText = `<a:yellowDot:1455059222541762643> **Bonus Chances:** <@&${g.increaseChanceRole}> + Boosters get 4x entries, either alone gets 2x`;
            } else {
                chanceText = `<a:yellowDot:1455059222541762643> **Bonus Chances:** Boosters get 2x entries`;
            }
        }
        if (chanceText) {
            description += "\n\n" + chanceText;
        }
    }
    description += `\n\nReact with ${g.emoji} to enter!`;
    const embed = new EmbedBuilder()
        .setTitle(g.prize)
        .setDescription(description)
        .setColor(Theme.EmbedColor)
        .setFooter({ text: 'All the Best!' });
    if (g.thumbnail) {
        embed.setThumbnail(g.thumbnail);
    }
    return embed;
}
export function createGiveawayButton(giveawayId: number): ButtonBuilder {
    return new ButtonBuilder()
        .setLabel("Enter Giveaway")
        .setStyle(ButtonStyle.Success)
        .setCustomId(`enter_giveaway_${giveawayId}`)
        .setEmoji("🎉");
}
export function giveawayEndedEmbed(g: Giveaway, winners: string[], participantCount: number): EmbedBuilder {
    const giftEmoji = '<:fo_gift:1465936534346924046>';
    const dotEmoji = '<a:yellowDot:1455059222541762643>';
    const winnerText = winners.length > 0 
        ? winners.map(id => `<@${id}>`).join(', ')
        : 'No valid entrants';
    const description = [
        `${giftEmoji} **${g.prize}** ${giftEmoji}`,
        `${dotEmoji} Hosted by: <@${g.hostId}>`,
        `${dotEmoji} Valid participant(s): ${participantCount}`,
        `${dotEmoji} Winner${winners.length > 1 ? 's' : ''}: ${winnerText}`
    ].join('\n');
    return new EmbedBuilder()
        .setDescription(description)
        .setColor(Theme.EmbedColor)
        .setTimestamp();
}
export function giveawayCancelledEmbed(g: Giveaway): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle("Giveaway Cancelled")
        .setDescription(`**Prize:** ${g.prize}\n\nThis giveaway was cancelled by a host.`)
        .setColor(Theme.EmbedColor)
        .setFooter({ text: "Cancelled" });
}

import { prisma } from '../utils/database';
import { Client, TextChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, Role, GuildMember } from 'discord.js';
import { giveawayEndedEmbed, giveawayCancelledEmbed, createGiveawayEmbed } from '../utils/giveaway/embeds';
const preCalculatedWinners: Map<string, { winners: string[], calculatedAt: number }> = new Map();
export class GiveawayService {
    private client: Client;
    constructor(client: Client) {
        this.client = client;
    }
    private async canAssignRole(guild: any, roleId: string): Promise<{ canAssign: boolean; reason?: string }> {
        try {
            const role = await guild.roles.fetch(roleId);
            if (!role) {
                return { canAssign: false, reason: 'Role not found' };
            }
            const botMember = guild.members.me;
            if (!botMember) {
                return { canAssign: false, reason: 'Bot member not found' };
            }
            const botHighestRole = botMember.roles.highest;
            if (role.position >= botHighestRole.position) {
                return { canAssign: false, reason: `The role **${role.name}** is above or equal to my highest role. I cannot assign it.` };
            }
            if (!botMember.permissions.has('ManageRoles')) {
                return { canAssign: false, reason: 'I don\'t have the Manage Roles permission.' };
            }
            return { canAssign: true };
        } catch (e) {
            return { canAssign: false, reason: 'Failed to check role permissions' };
        }
    }
    async startGiveaway(giveawayData: any): Promise<void> {
        const channel = this.client.channels.cache.get(giveawayData.channelId) as TextChannel;
        if (!channel) throw new Error("Channel not found");
        const gForEmbed: any = { ...giveawayData, messageId: "", id: 0 };
        const embed = createGiveawayEmbed(gForEmbed, 0);
        const giveawayEmoji = giveawayData.emoji || "<a:Exe_Gw:1455059165150974095>";
        const message = await channel.send({ content: `${giveawayEmoji} **New Giveaway** ${giveawayEmoji}`, embeds: [embed] });
        await message.react(giveawayData.emoji || "<a:Exe_Gw:1455059165150974095>");
        await prisma.giveaway.create({
            data: {
                ...giveawayData,
                messageId: message.id
            }
        });
    }
    async preCalculateWinners(messageId: string): Promise<void> {
        const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
        if (!giveaway || giveaway.ended) return;
        const participants = await prisma.giveawayParticipant.findMany({
            where: { giveawayId: giveaway.id },
            select: { userId: true }
        });
        const winners = await this.selectWinners(
            participants.map((p: { userId: string }) => p.userId),
            giveaway.winnersCount,
            giveaway
        );
        await prisma.giveaway.update({
            where: { messageId },
            data: {
                preCalculatedWinners: winners.join(','),
                winnersCalculatedAt: BigInt(Date.now())
            }
        });
        preCalculatedWinners.set(messageId, {
            winners,
            calculatedAt: Date.now()
        });
    }
    async endGiveaway(messageId: string): Promise<void> {
        const giveaway = await prisma.$transaction(async (tx) => {
            const g = await tx.giveaway.findUnique({ where: { messageId } });
            if (!g || g.ended) return null;
            return tx.giveaway.update({
                where: { id: g.id },
                data: { ended: true }
            });
        });
        if (!giveaway) return;
        let winners: string[];
        if (giveaway.preCalculatedWinners && giveaway.winnersCalculatedAt) {
            const calculatedAt = Number(giveaway.winnersCalculatedAt);
            if ((Date.now() - calculatedAt) < 120000) {
                winners = giveaway.preCalculatedWinners.split(',').filter((id: string) => id.trim());
            } else {
                const participants = await prisma.giveawayParticipant.findMany({
                    where: { giveawayId: giveaway.id },
                    select: { userId: true }
                });
                winners = await this.selectWinners(
                    participants.map((p: { userId: string }) => p.userId),
                    giveaway.winnersCount,
                    giveaway
                );
            }
        } else {
            const preCalc = preCalculatedWinners.get(messageId);
            if (preCalc && (Date.now() - preCalc.calculatedAt) < 120000) {
                winners = preCalc.winners;
                preCalculatedWinners.delete(messageId);
            } else {
                const participants = await prisma.giveawayParticipant.findMany({
                    where: { giveawayId: giveaway.id },
                    select: { userId: true }
                });
                winners = await this.selectWinners(
                    participants.map((p: { userId: string }) => p.userId),
                    giveaway.winnersCount,
                    giveaway
                );
            }
        }
        if (winners.length > 0) {
            const wonAt = BigInt(Date.now());
            await prisma.giveawayWinner.createMany({
                data: winners.map(winnerId => ({
                    giveawayId: giveaway.id,
                    userId: winnerId,
                    wonAt
                }))
            });
        }
        const channel = this.client.channels.cache.get(giveaway.channelId) as TextChannel;
        const guild = this.client.guilds.cache.get(giveaway.guildId);
        if (channel && guild) {
            try {
                await this.refreshGiveawayEmbed(giveaway, winners, channel);
                if (winners.length > 0) {
                    const mentions = winners.map(id => `<@${id}>`).join(", ");
                    if (giveaway.winnerRole) {
                        const roleCheck = await this.canAssignRole(guild, giveaway.winnerRole);
                        if (!roleCheck.canAssign) {
                            await channel.send(`⚠️ Could not assign winner role: ${roleCheck.reason}`);
                        } else {
                            for (const winnerId of winners) {
                                try {
                                    const member = await guild.members.fetch(winnerId);
                                    await member.roles.add(giveaway.winnerRole);
                                } catch (e: any) {
                                }
                            }
                        }
                    }
                    const row = new ActionRowBuilder<ButtonBuilder>()
                        .addComponents(
                            new ButtonBuilder()
                                .setLabel('Giveaway Link')
                                .setStyle(ButtonStyle.Link)
                                .setURL(`https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`)
                        );
                    await channel.send({
                        content: `**GIVEAWAY WINNER${winners.length > 1 ? 'S' : ''}**\n\n${mentions}\n\nCongratulations! You won **${giveaway.prize}**!\nHosted by <@${giveaway.hostId}>`,
                        components: [row]
                    });
                } else {
                    await channel.send(`No valid participants for the giveaway: **${giveaway.prize}**`);
                }
            } catch (error) {
            }
        }
    }
    async rerollGiveaway(messageId: string): Promise<string[]> {
        const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
        if (!giveaway || !giveaway.ended) throw new Error("Giveaway not found or not ended");
        const participants = await prisma.giveawayParticipant.findMany({
            where: { giveawayId: giveaway.id },
            select: { userId: true }
        });
        const winner = await this.selectWinners(participants.map((p: { userId: string }) => p.userId), 1, giveaway);
        if (winner.length > 0) {
            const channel = this.client.channels.cache.get(giveaway.channelId) as TextChannel;
            if (channel) {
                const row = new ActionRowBuilder<ButtonBuilder>()
                    .addComponents(
                        new ButtonBuilder()
                            .setLabel('Giveaway Link')
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`)
                    );
                await channel.send({
                    content: `**NEW WINNER**\n\n<@${winner[0]}>\n\nCongratulations! You won **${giveaway.prize}**!\nHosted by <@${giveaway.hostId}>`,
                    components: [row]
                });
            }
        }
        return winner;
    }
    async cancelGiveaway(messageId: string): Promise<void> {
        const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
        if (!giveaway || giveaway.ended) return;
        await prisma.giveaway.update({
            where: { id: giveaway.id },
            data: { ended: true }
        });
        const channel = this.client.channels.cache.get(giveaway.channelId) as TextChannel;
        if (channel) {
            try {
                const embed = giveawayCancelledEmbed(giveaway);
                const message = await channel.messages.fetch(giveaway.messageId);
                await message.edit({ embeds: [embed] });
            } catch (error) {
            }
        }
    }
    private async selectWinners(participants: string[], count: number, giveaway?: any): Promise<string[]> {
        const forcedWinners: string[] = [];
        if (giveaway?.forcedWinners) {
            const forcedIds = giveaway.forcedWinners.split(',').filter((id: string) => id.trim());
            forcedWinners.push(...forcedIds.slice(0, count));
        }
        if (forcedWinners.length >= count) {
            return forcedWinners.slice(0, count);
        }
        if (participants.length === 0) {
            return forcedWinners;
        }
        const remainingCount = count - forcedWinners.length;
        const regularParticipants = participants.filter(p => !forcedWinners.includes(p));
        if (regularParticipants.length === 0) {
            return forcedWinners;
        }
        let regularWinners: string[] = [];
        if (!giveaway || !giveaway.increaseChance) {
            const shuffled = regularParticipants.sort(() => 0.5 - Math.random());
            regularWinners = shuffled.slice(0, remainingCount);
        } else {
            const guild = this.client.guilds.cache.get(giveaway.guildId);
            if (!guild) {
                const shuffled = regularParticipants.sort(() => 0.5 - Math.random());
                regularWinners = shuffled.slice(0, remainingCount);
            } else {
                const weightedPool: string[] = [];
                const increaseChance = giveaway.increaseChance;
                const roleReq = giveaway.increaseChanceRole || giveaway.roleRequirement;
                for (const userId of regularParticipants) {
                    const member = await guild.members.fetch(userId).catch(() => null);
                    if (!member) {
                        weightedPool.push(userId);
                        continue;
                    }
                    let entries = 1;
                    const hasRole = roleReq ? member.roles.cache.has(roleReq) : false;
                    const isBooster = member.premiumSince !== null;
                    if (increaseChance === 'role' && hasRole) {
                        entries = 2;
                    } else if (increaseChance === 'booster' && isBooster) {
                        entries = 2;
                    } else if (increaseChance === 'role_booster') {
                        if (hasRole && isBooster) {
                            entries = 4;
                        } else if (hasRole || isBooster) {
                            entries = 2;
                        }
                    }
                    for (let i = 0; i < entries; i++) {
                        weightedPool.push(userId);
                    }
                }
                const availablePool = [...weightedPool];
                for (let i = 0; i < remainingCount && availablePool.length > 0; i++) {
                    const randomIndex = Math.floor(Math.random() * availablePool.length);
                    const winner = availablePool[randomIndex];
                    if (!regularWinners.includes(winner)) {
                        regularWinners.push(winner);
                    }
                    for (let j = availablePool.length - 1; j >= 0; j--) {
                        if (availablePool[j] === winner) {
                            availablePool.splice(j, 1);
                        }
                    }
                }
            }
        }
        return [...forcedWinners, ...regularWinners];
    }
    async deleteGiveaway(messageId: string): Promise<void> {
        const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
        if (!giveaway) throw new Error("Giveaway not found");
        await prisma.giveawayParticipant.deleteMany({ where: { giveawayId: giveaway.id } });
        await prisma.giveawayWinner.deleteMany({ where: { giveawayId: giveaway.id } });
        await prisma.giveaway.delete({ where: { id: giveaway.id } });
        const channel = this.client.channels.cache.get(giveaway.channelId) as TextChannel;
        if (channel) {
            try {
                const message = await channel.messages.fetch(giveaway.messageId);
                await message.delete();
            } catch (error) {
            }
        }
    }
    async deleteScheduledGiveaway(id: number): Promise<void> {
        const scheduled = await prisma.scheduledGiveaway.findUnique({ where: { id } });
        if (!scheduled) throw new Error("Scheduled giveaway not found");
        await prisma.scheduledGiveaway.delete({ where: { id } });
    }
    async updateEndedGiveaway(messageId: string): Promise<void> {
        const giveaway = await prisma.giveaway.findUnique({ where: { messageId } });
        if (!giveaway || !giveaway.ended) return;
        let existingWinners = await prisma.giveawayWinner.findMany({
            where: { giveawayId: giveaway.id },
            select: { userId: true }
        });
        let winners: string[];
        if (existingWinners.length > 0) {
            winners = existingWinners.map(w => w.userId);
        } else {
            const participants = await prisma.giveawayParticipant.findMany({
                where: { giveawayId: giveaway.id },
                select: { userId: true }
            });
            winners = await this.selectWinners(
                participants.map((p: { userId: string }) => p.userId),
                giveaway.winnersCount,
                giveaway
            );
            if (winners.length > 0) {
                const wonAt = BigInt(Date.now());
                await prisma.giveawayWinner.createMany({
                    data: winners.map(winnerId => ({
                        giveawayId: giveaway.id,
                        userId: winnerId,
                        wonAt
                    }))
                });
            }
        }
        const channel = this.client.channels.cache.get(giveaway.channelId) as TextChannel;
        if (channel) {
            await this.refreshGiveawayEmbed(giveaway, winners, channel);
        }
    }
    private async refreshGiveawayEmbed(giveaway: any, winners: string[], channel: TextChannel): Promise<void> {
        try {
            let participantCount = await prisma.giveawayParticipant.count({
                where: { giveawayId: giveaway.id }
            });
            if (giveaway.forcedWinners) {
                const forcedWinnersCount = giveaway.forcedWinners.split(',').filter((id: string) => id.trim()).length;
                participantCount += forcedWinnersCount;
            }
            const embed = giveawayEndedEmbed(giveaway, winners, participantCount);
            if (!channel.messages.cache.has(giveaway.messageId)) {
                try {
                    await channel.messages.fetch(giveaway.messageId);
                } catch { }
            }
            const giveawayMessage = channel.messages.cache.get(giveaway.messageId);
            if (giveawayMessage) {
                const gwEmoji = giveaway.emoji || '<a:Exe_Gw:1455059165150974095>';
                await giveawayMessage.edit({
                    content: `${gwEmoji} **Giveaway Ended** ${gwEmoji}`,
                    embeds: [embed]
                });
                console.log(`✅ Successfully updated giveaway message ${giveaway.messageId} (Embed Refreshed)`);
            }
        } catch (e: any) {
            console.error(`❌ Failed to update giveaway message ${giveaway.messageId}:`, e.message || e);
        }
    }
}

import { prisma } from '../utils/database';

import { Client, MessageReaction, User, TextChannel, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { checkAllRequirements } from '../utils/giveaway/requirements';
import { Theme } from '../utils/giveaway/theme';
import { Emojis } from '../utils/giveaway/emojis';
import { giveawayUpdateManager } from '../utils/giveaway/GiveawayUpdateManager';
import { 
    getCachedGiveaway, 
    isParticipantCached, 
    addParticipantCached, 
    removeParticipantCached,
    invalidateGiveawayCache 
} from '../utils/giveaway/giveawayCache';

async function canAssignRole(guild: any, roleId: string): Promise<{ canAssign: boolean; reason?: string }> {
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
            return { canAssign: false, reason: `The role **${role.name}** is above or equal to my highest role` };
        }

        if (!botMember.permissions.has('ManageRoles')) {
            return { canAssign: false, reason: 'I don\'t have the Manage Roles permission' };
        }

        return { canAssign: true };
    } catch (e) {
        return { canAssign: false, reason: 'Failed to check role permissions' };
    }
}

export async function handleGiveawayReactionAdd(reaction: MessageReaction, user: User, client: Client) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (user.partial) {
        try { await user.fetch(); } catch { return; }
    }

    const messageId = reaction.message.id;
    const giveaway = await getCachedGiveaway(messageId);

    if (!giveaway || giveaway.ended) return;
    if (reaction.emoji.name !== giveaway.emoji && reaction.emoji.toString() !== giveaway.emoji) return;

    const exists = await isParticipantCached(giveaway.id, user.id);
    if (exists) return;


    const result = await checkAllRequirements(client, reaction.message.guildId!, user.id, giveaway);
    if (!result.passed) {
        await reaction.users.remove(user.id);
        try {
            const errorEmbed = new EmbedBuilder()
                .setTitle(`${Emojis.CROSS} Entry Denied`)
                .setDescription(`You cannot enter the giveaway for **${giveaway.prize}**\n\n**Reason:** ${result.reason}`)
                .setColor(Theme.ErrorColor)
                .setTimestamp();
            await user.send({ embeds: [errorEmbed] });
        } catch (e) { }
        return;
    }


    if (giveaway.captchaRequirement) {
        try {
            const { generateCaptcha } = await import('../utils/giveaway/captcha');
            const { buffer, text } = await generateCaptcha();

            const dmChannel = await user.createDM();
            const attachment = new AttachmentBuilder(buffer, { name: 'captcha.png' });

            const captchaEmbed = new EmbedBuilder()
                .setTitle('🔐 Security Verification')
                .setDescription([
                    `To enter the giveaway for **${giveaway.prize}**, please solve this captcha.`,
                    '',
                    '**Instructions:**',
                    '• Type the code shown in the image below',
                    '• The code is case-insensitive',
                    '• You have **1 minute** to respond',
                    '',
                    '⏰ *If you don\'t respond in time, your reaction will be removed.*'
                ].join('\n'))
                .setImage('attachment://captcha.png')
                .setColor(Theme.EmbedColor)
                .setFooter({ text: 'Giveaway Security Check' })
                .setTimestamp();

            await dmChannel.send({ embeds: [captchaEmbed], files: [attachment] });

            try {

                const filter = (m: any) => m.author.id === user.id && m.channel.id === dmChannel.id;
                const collected = await dmChannel.awaitMessages({
                    filter,
                    max: 1,
                    time: 60000,
                    errors: ['time']
                });

                const response = collected.first()?.content.toUpperCase().trim();

                if (response !== text) {
                    const failEmbed = new EmbedBuilder()
                        .setTitle(`${Emojis.CROSS} Incorrect Captcha`)
                        .setDescription([
                            '**Your answer was incorrect.**',
                            '',
                            'Your reaction has been removed from the giveaway.',
                            'You can try again by reacting to the giveaway message.'
                        ].join('\n'))
                        .setColor(Theme.ErrorColor)
                        .setTimestamp();
                    await dmChannel.send({ embeds: [failEmbed] });
                    await reaction.users.remove(user.id);
                    return;
                }

                const successEmbed = new EmbedBuilder()
                    .setTitle(`${Emojis.TICK} Captcha Verified!`)
                    .setDescription([
                        '**You have been successfully entered into the giveaway!**',
                        '',
                        `**Prize:** ${giveaway.prize}`,
                        '',
                        '🎉 Good luck!'
                    ].join('\n'))
                    .setColor(Theme.SuccessColor)
                    .setTimestamp();
                await dmChannel.send({ embeds: [successEmbed] });

            } catch (timeout) {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle(`${Emojis.CROSS} Captcha Timed Out`)
                    .setDescription([
                        '**You did not respond in time.**',
                        '',
                        'Your reaction has been removed from the giveaway.',
                        'You can try again by reacting to the giveaway message.'
                    ].join('\n'))
                    .setColor(Theme.ErrorColor)
                    .setTimestamp();
                await dmChannel.send({ embeds: [timeoutEmbed] });
                await reaction.users.remove(user.id);
                return;
            }

        } catch (e: any) {
            await reaction.users.remove(user.id);


            try {
                const channel = reaction.message.channel as TextChannel;
                const msg = await channel.send(`<@${user.id}> Your DMs are closed. Please enable DMs to enter this giveaway (captcha required).`);
                setTimeout(() => msg.delete().catch(() => { }), 10000);
            } catch (channelError) { }
            return;
        }
    }

    // Check bonus chance multiplier before creating participant
    let entryMultiplier = 1;
    let bonusReason = '';

    if (giveaway.increaseChance) {
        const guild = client.guilds.cache.get(giveaway.guildId);
        if (guild) {
            try {
                const member = await guild.members.fetch(user.id);
                const hasRole = giveaway.increaseChanceRole && member.roles.cache.has(giveaway.increaseChanceRole);
                const isBooster = member.premiumSince !== null;

                if (giveaway.increaseChance === 'role' && hasRole) {
                    entryMultiplier = 2;
                    bonusReason = 'You have the required role';
                } else if (giveaway.increaseChance === 'booster' && isBooster) {
                    entryMultiplier = 2;
                    bonusReason = 'You are a server booster';
                } else if (giveaway.increaseChance === 'role_booster') {
                    if (hasRole && isBooster) {
                        entryMultiplier = 4;
                        bonusReason = 'You have the role + you are a server booster';
                    } else if (hasRole) {
                        entryMultiplier = 2;
                        bonusReason = 'You have the required role';
                    } else if (isBooster) {
                        entryMultiplier = 2;
                        bonusReason = 'You are a server booster';
                    }
                }
            } catch (e) {
            }
        }
    }

    // Create participant entry using cache
    try {
        await addParticipantCached(giveaway.id, user.id);

        // Send entry confirmation DM with bonus chance info (only if increase_chance is enabled)
        if (giveaway.increaseChance) {
            try {
                const guild = client.guilds.cache.get(giveaway.guildId);
                const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
                const hasRole = giveaway.increaseChanceRole && member?.roles.cache.has(giveaway.increaseChanceRole);
                const isBooster = member?.premiumSince !== null;

                let description = '';
                let extraInfo: string[] = [];

                // Build description based on entries
                if (entryMultiplier === 1) {
                    description = `You have successfully entered the giveaway!\n\n**Prize:** ${giveaway.prize}\n**Your Entries:** ${entryMultiplier}x`;

                    extraInfo.push('\n**💡 Increase Your Chances:**');

                    if (giveaway.increaseChance === 'role' && giveaway.increaseChanceRole) {
                        extraInfo.push(`🔸 Get <@&${giveaway.increaseChanceRole}> for **2x entries**`);
                    } else if (giveaway.increaseChance === 'booster') {
                        extraInfo.push(`🔸 Boost the server for **2x entries**`);
                    } else if (giveaway.increaseChance === 'role_booster') {
                        if (giveaway.increaseChanceRole) {
                            extraInfo.push(`🔸 Get <@&${giveaway.increaseChanceRole}> for **2x entries**`);
                        }
                        extraInfo.push(`🔸 Boost the server for **2x entries**`);
                        extraInfo.push(`🔸 Have both for **4x entries**`);
                    }
                } else if (entryMultiplier === 2) {
                    description = `${Emojis.TICK} You have successfully entered the giveaway!\n\n**Prize:** ${giveaway.prize}\n**Your Entries:** ${entryMultiplier}x\n**Bonus:** ${bonusReason}`;

                    if (giveaway.increaseChance === 'role_booster') {
                        extraInfo.push('\n**💡 Get Even More Entries:**');
                        if (hasRole && !isBooster) {
                            extraInfo.push(`🔸 Boost the server to get **4x entries** total!`);
                        } else if (!hasRole && isBooster && giveaway.increaseChanceRole) {
                            extraInfo.push(`🔸 Get <@&${giveaway.increaseChanceRole}> to get **4x entries** total!`);
                        }
                    }
                } else if (entryMultiplier === 4) {
                    description = `${Emojis.TICK} You have successfully entered the giveaway!\n\n**Prize:** ${giveaway.prize}\n**Your Entries:** ${entryMultiplier}x ⚡\n**Bonus:** ${bonusReason}\n\n🎉 You have maximum entry chances!`;
                }

                description += extraInfo.join('\n');
                description += '\n\n🍀 Good luck!';

                const entryEmbed = new EmbedBuilder()
                    .setTitle('Giveaway Entry Confirmed')
                    .setDescription(description)
                    .setColor(entryMultiplier === 4 ? '#FFD700' : entryMultiplier === 2 ? Theme.SuccessColor : Theme.EmbedColor)
                    .setTimestamp();

                await user.send({ embeds: [entryEmbed] });
            } catch (dmError) {
                // User has DMs disabled, ignore
            }
        }

        if (giveaway.assignRole) {
            const guild = client.guilds.cache.get(giveaway.guildId);
            if (guild) {
                const roleCheck = await canAssignRole(guild, giveaway.assignRole);
                if (roleCheck.canAssign) {
                    try {
                        const member = await guild.members.fetch(user.id);
                        await member.roles.add(giveaway.assignRole);
                    } catch (e: any) {
                    }
                }
            }
        }
    } catch (e) {
        return;
    }

    giveawayUpdateManager.scheduleUpdate(
        giveaway.id.toString(),
        giveaway.messageId,
        giveaway.channelId,
        giveaway.guildId
    );
}

export async function handleGiveawayReactionRemove(reaction: MessageReaction, user: User, client: Client) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (user.partial) {
        try { await user.fetch(); } catch { return; }
    }

    const messageId = reaction.message.id;
    const giveaway = await getCachedGiveaway(messageId);

    if (!giveaway || giveaway.ended) return;

    const exists = await isParticipantCached(giveaway.id, user.id);
    if (!exists) return;

    await removeParticipantCached(giveaway.id, user.id);

    if (giveaway.assignRole) {
        const guild = client.guilds.cache.get(giveaway.guildId);
        if (guild) {
            const roleCheck = await canAssignRole(guild, giveaway.assignRole);
            if (roleCheck.canAssign) {
                try {
                    const member = await guild.members.fetch(user.id);
                    await member.roles.remove(giveaway.assignRole);
                } catch (e: any) {
                }
            }
        }
    }

    giveawayUpdateManager.scheduleUpdate(
        giveaway.id.toString(),
        giveaway.messageId,
        giveaway.channelId,
        giveaway.guildId
    );
}

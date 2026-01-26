import {
    Client,
    Guild,
    ChannelType,
    PermissionFlagsBits,
    CategoryChannel,
    TextChannel,
    EmbedBuilder,
    User,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Message,
    Attachment,
    ButtonInteraction,
    ChatInputCommandInteraction,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction
} from 'discord.js';
import prisma from '../utils/database';
import { client } from '../client';

export class ModMailService {
    private readonly CATEGORY_NAME_OPEN = '📩 ModMail Tickets';
    private readonly CATEGORY_NAME_CLOSED = '📁 Closed Tickets';
    private readonly CHANNEL_NAME_LOGS = '📜-ticket-logs';


    /**
     * Ensures that the necessary categories and channels exist for a guild.
     * Updates the database with the IDs.
     */
    public async ensureCategories(guild: Guild): Promise<void> {
        let settings = await prisma.modMailSettings.findUnique({
            where: { guildId: guild.id }
        });

        if (!settings) {
            settings = await prisma.modMailSettings.create({
                data: { guildId: guild.id }
            });
        }

        let openCategory = guild.channels.cache.get(settings.categoryId || '') as CategoryChannel;
        let closedCategory = guild.channels.cache.get(settings.closedCategoryId || '') as CategoryChannel;
        let logsChannel = guild.channels.cache.get(settings.logsChannelId || '') as TextChannel;

        // 1. Ensure "ModMail Tickets" Category
        if (!openCategory) {
            // Check if it exists by name first to avoid duplicates
            const existing = guild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === this.CATEGORY_NAME_OPEN
            ) as CategoryChannel;

            if (existing) {
                openCategory = existing;
            } else {
                openCategory = await guild.channels.create({
                    name: this.CATEGORY_NAME_OPEN,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        {
                            id: guild.id, // @everyone
                            deny: [PermissionFlagsBits.ViewChannel]
                        },
                        {
                            id: client.user!.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
                        }
                    ]
                });
            }
            // Update DB
            if (settings.categoryId !== openCategory.id) {
                await prisma.modMailSettings.update({
                    where: { guildId: guild.id },
                    data: { categoryId: openCategory.id }
                });
            }
        }

        // 2. Ensure "Closed Tickets" Category
        if (!closedCategory) {
            const existing = guild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === this.CATEGORY_NAME_CLOSED
            ) as CategoryChannel;

            if (existing) {
                closedCategory = existing;
            } else {
                closedCategory = await guild.channels.create({
                    name: this.CATEGORY_NAME_CLOSED,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: [PermissionFlagsBits.ViewChannel]
                        },
                        {
                            id: client.user!.id,
                            allow: [PermissionFlagsBits.ViewChannel]
                        }
                    ]
                });
            }
            if (settings.closedCategoryId !== closedCategory.id) {
                await prisma.modMailSettings.update({
                    where: { guildId: guild.id },
                    data: { closedCategoryId: closedCategory.id }
                });
            }
        }

        // 3. Ensure "Ticket Logs" Channel
        if (!logsChannel) {
            const existing = guild.channels.cache.find(
                c => c.type === ChannelType.GuildText && c.name === this.CHANNEL_NAME_LOGS
            ) as TextChannel;

            if (existing) {
                logsChannel = existing;
            } else {
                logsChannel = await guild.channels.create({
                    name: this.CHANNEL_NAME_LOGS,
                    type: ChannelType.GuildText,
                    parent: closedCategory.id, // Put in closed category or its own? Spec says "Required Categories". Let's put logs in the "Closed Tickets" category or separate? 
                    // "Category Rules: ModMail Tickets, Closed Tickets, Ticket Logs". 
                    // Usually logs is a channel inside a category. I'll put it in Closed Tickets for organization, or creating a separate category if implied? 
                    // The spec says "Required Categories: Ticket Logs". That implies a *Category* named Ticket Logs? 
                    // "Logs stored in: 📜 Ticket Logs". Usually that's a channel.
                    // Let's assume Ticket Logs is a CHANNEL inside the Closed Tickets category or a separate admin category.
                    // For now, I'll put it in the Closed Tickets category to keep it clean, but if spec implies 3 categories, I should be careful.
                    // "Required Categories: ... 📜 Ticket Logs". It lists it under "Categories".
                    // So I will make a 3rd Category: "Ticket Logs"? No, that seems excessive.
                    // Let's look at "Category Rules". "Bot validates category existence on startup".
                    // I will stick to 2 categories and 1 channel for logs, maybe inside a private staff area or the closed category.
                    // Actually, "Ticket Logs" is listed under "Required Categories". I will create a Category named "Ticket Logs" just in case, or maybe it meant "Channels"?
                    // Re-reading: "Required Categories... 📜 Ticket Logs". 
                    // I'll create a channel named 'ticket-logs' and maybe put it in a separate category if strictly needed.
                    // Let's create a channel strictly for now.
                    permissionOverwrites: [
                        {
                            id: guild.id,
                            deny: [PermissionFlagsBits.ViewChannel]
                        },
                        {
                            id: client.user!.id,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
                        }
                    ]
                });
            }
            // Update DB
            if (settings.logsChannelId !== logsChannel.id) {
                await prisma.modMailSettings.update({
                    where: { guildId: guild.id },
                    data: { logsChannelId: logsChannel.id }
                });
            }
        }
    }

    /**
     * Sanitize username for channel name
     */
    private sanitizeUsername(username: string): string {
        const sanitized = username.toLowerCase()
            .replace(/[^a-z0-9-]/g, '') // Keep alphanumeric and hyphens
            .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
            .substring(0, 20); // Truncate
        
        return sanitized || 'user'; // Fallback if username becomes empty
    }


    /**
     * Create a new ticket channel for a user
     */
    public async createTicket(guild: Guild, user: User): Promise<TextChannel | null> {
        let settings = await prisma.modMailSettings.findUnique({
            where: { guildId: guild.id }
        });

        if (!settings || !settings.categoryId) return null;

        const category = guild.channels.cache.get(settings.categoryId) as CategoryChannel;
        if (!category) return null;

        // Check active ticket
        const existingTicket = await prisma.modMailTicket.findFirst({
            where: {
                userId: user.id,
                guildId: guild.id,
                status: { in: ['OPEN', 'CLAIMED'] }
            }
        });

        if (existingTicket) {
            // User already has a ticket
            return null;
        }

        // Find and clean up any pending tickets
        const pendingTicket = await prisma.modMailTicket.findFirst({
            where: {
                userId: user.id,
                guildId: guild.id,
                status: 'PENDING'
            }
        });

        const channelName = `${this.sanitizeUsername(user.username)}-ticket`;

        const ticketChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `ModMail Ticket | User: ${user.tag} | ID: ${user.id}`,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: client.user!.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels]
                },
                // Add Mod Role if exists
                ...(settings.staffRoleId ? [{
                    id: settings.staffRoleId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] as bigint[]
                }] : [])
            ]
        });

        if (pendingTicket) {
            await prisma.modMailTicket.update({
                where: { id: pendingTicket.id },
                data: {
                    channelId: ticketChannel.id,
                    status: 'OPEN'
                }
            });
        } else {
            // Create DB Entry
            await prisma.modMailTicket.create({
                data: {
                    guildId: guild.id,
                    userId: user.id,
                    channelId: ticketChannel.id,
                    status: 'OPEN'
                }
            });
        }

        // Professional Initial Embed
        const embed = new EmbedBuilder()
            .setTitle('New Ticket Created')
            .setDescription(`**User Details**\nUsername: ${user.tag}\nUser ID: \`${user.id}\`\nAccount Age: <t:${Math.floor(user.createdTimestamp / 1000)}:R>`)
            .setThumbnail(user.displayAvatarURL())
            .setColor(0x2B2D31) // Discord Dark/Clean
            .addFields(
                { name: 'Status', value: 'Open', inline: true },
                { name: 'Assigned Staff', value: 'Unassigned', inline: true }
            )
            .setTimestamp();

        // Buttons: Close, Claim, UserInfo
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('modmail_close')
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('modmail_claim')
                    .setLabel('Claim Ticket')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('modmail_userinfo')
                    .setLabel('User Info')
                    .setStyle(ButtonStyle.Secondary)
            );

        // Mention staff role if configured
        const content = settings.staffRoleId ? `<@&${settings.staffRoleId}>` : undefined;


        await ticketChannel.send({ content, embeds: [embed], components: [row] });

        // Log Action
        await this.logModMail(
            guild,
            'Ticket Opened',
            `Ticket created for ${user.tag} (\`${user.id}\`)`,
            [{ name: 'Channel', value: ticketChannel.toString() }]
        );

        return ticketChannel;
    }

    /**
     * Handle DM from user
     */
    public async handleDM(message: Message): Promise<void> {
        if (message.author.bot) return;

        // Check for active ticket
        const ticket = await prisma.modMailTicket.findFirst({
            where: {
                userId: message.author.id,
                status: { in: ['OPEN', 'CLAIMED'] }
            }
        });

        // If ticket exists, relay message
        if (ticket && ticket.channelId) {
            await this.relayToTicket(message, ticket);
            return;
        }

        // If PENDING, ignore (waiting for reaction)
        const pendingTicket = await prisma.modMailTicket.findFirst({
            where: {
                userId: message.author.id,
                status: 'PENDING'
            }
        });

        if (pendingTicket) {
            await message.reply('⏳ You already have a pending ticket. Please react to the confirmation message.');
            return;
        }

        // Check if server list is available (find all mutual guilds with ModMail settings)
        const mutualGuilds: Guild[] = [];

        for (const [id, guild] of client.guilds.cache) {
            const member = await guild.members.fetch(message.author.id).catch(() => null);
            if (member) {
                const settings = await prisma.modMailSettings.findUnique({ where: { guildId: guild.id } });
                if (settings) {
                    mutualGuilds.push(guild);
                }
            }
        }

        if (mutualGuilds.length === 0) {
            await message.reply('❌ You are not a member of any servers with modmail configured.');
            return;
        }

        if (mutualGuilds.length === 1) {
            await this.promptTicketConfirmation(message, mutualGuilds[0], message.author);
            return;
        }

        // Multiple guilds found -> Ask user to select
        const options = mutualGuilds.map(g => ({
            label: g.name,
            value: g.id,
            description: `Open ticket in ${g.name}`
        }));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('modmail_server_select')
                    .setPlaceholder('Select a server')
                    .addOptions(options)
            );

        const embed = new EmbedBuilder()
            .setTitle('Select Server')
            .setDescription('You share multiple servers with me. Where would you like to open a ticket?')
            .setColor(0x2B2D31);

        await message.reply({ embeds: [embed], components: [row] });
    }

    /**
     * Handle Server Selection Interaction
     */
    public async handleServerSelection(interaction: StringSelectMenuInteraction): Promise<void> {
        const guildId = interaction.values[0];
        const guild = client.guilds.cache.get(guildId);

        if (!guild) {
            await interaction.reply({ content: 'Server not found.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        await interaction.update({ components: [] });

        // We are in DM, interaction.message is the bot's message.
        // interaction.user is the User.
        await this.promptTicketConfirmation(interaction.message as Message, guild, interaction.user);
    }

    private async promptTicketConfirmation(message: Message, guild: Guild, user: User): Promise<void> {
        // Check if user already has a pending or active ticket in this guild
        const existingTicket = await prisma.modMailTicket.findFirst({
            where: {
                userId: user.id,
                guildId: guild.id,
                status: { in: ['PENDING', 'OPEN', 'CLAIMED'] }
            }
        });

        if (existingTicket) {
            if (existingTicket.status === 'PENDING') {
                await message.reply('⏳ You already have a pending ticket. Please react to the confirmation message.');
            } else {
                await message.reply('❌ You already have an active ticket in this server.');
            }
            return;
        }

        // Professional Confirmation Embed
        const embed = new EmbedBuilder()
            .setTitle('Open Support Ticket')
            .setDescription(`You are initiating a support ticket with **${guild.name}**.\n\nPlease confirm to proceed. Staff will receive your messages after confirmation.`)
            .setColor(0x2B2D31);

        const confirmMsg = await message.reply({ embeds: [embed] });
        await confirmMsg.react('✅');
        await confirmMsg.react('❌');

        // Create PENDING ticket
        await prisma.modMailTicket.create({
            data: {
                guildId: guild.id,
                userId: user.id, // Ensure we use the passed User ID
                messageId: confirmMsg.id,
                status: 'PENDING'
            }
        });
    }

    private async relayToTicket(message: Message, ticket: any): Promise<void> {
        const guild = client.guilds.cache.get(ticket.guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(ticket.channelId) as TextChannel;
        if (!channel) return;

        const files = Array.from(message.attachments.values());

        // Clean Relay Embed (User -> Staff)
        // Format: "User: <content>"

        // Webhook Impersonation (User -> Staff)
        // Ensure bot has Manage Webhooks permission in the category creation or channel creation, assume yes.

        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(w => w.owner?.id === client.user?.id);

        if (!webhook) {
            webhook = await channel.createWebhook({
                name: 'ModMail Relay',
                avatar: client.user?.displayAvatarURL()
            });
        }

        await webhook.send({
            content: message.content || (files.length > 0 ? null : 'Empty message'), // Webhooks require content or files
            username: message.author.username,
            avatarURL: message.author.displayAvatarURL(),
            files: files
        });

        await message.react('✅').catch(() => { });
    }

    /**
     * Handle Staff message in ticket channel
     */
    public async handleStaffMessage(message: Message): Promise<void> {
        if (message.author.bot) return;

        if (message.content.startsWith('!')) return;

        const ticket = await prisma.modMailTicket.findFirst({
            where: {
                channelId: message.channel.id,
                status: { in: ['OPEN', 'CLAIMED'] }
            }
        });

        if (!ticket) return;

        const user = await client.users.fetch(ticket.userId).catch(() => null);
        if (!user) return;

        const files = Array.from(message.attachments.values());

        // Plain text relay (Staff -> User)
        // const staffName = message.member?.displayName || message.author.username;
        // Spec says simple response, keeping it anonymous or generic "Staff" might be desired,
        // but user usually knows who they are talking to if they see the name.
        // Let's use generic "Staff" prefix or just the content if preferred.
        // User request: "remove embeds from all repiles of staff and user"

        let content = message.content;

        try {
            await user.send({
                content: content,
                files: files
            });
            await message.react('✅').catch(() => { });
        } catch (err) {
            await message.react('❌').catch(() => { });
            await message.reply('Failed to send DM. User might have DMs disabled.');
        }
    }

    /**
     * Log ModMail Action
     */
    public async logModMail(guild: Guild, action: string, description: string, fields: { name: string; value: string; inline?: boolean }[] = []): Promise<void> {
        const settings = await prisma.modMailSettings.findUnique({ where: { guildId: guild.id } });
        if (!settings || !settings.logsChannelId) return;

        const logsChannel = guild.channels.cache.get(settings.logsChannelId) as TextChannel;
        if (!logsChannel) return;

        // Clean Log Embed
        const embed = new EmbedBuilder()
            .setTitle(action)
            .setDescription(description)
            .addFields(fields)
            .setColor(0x2B2D31)
            .setTimestamp();

        await logsChannel.send({ embeds: [embed] }).catch(() => { });
    }

    /**
     * Handle User Info Interaction
     */
    public async handleUserInfo(interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
        if (!interaction.guild) return;

        const ticket = await prisma.modMailTicket.findFirst({
            where: {
                channelId: interaction.channelId,
            }
        });

        if (!ticket) {
            await interaction.reply({ content: 'Ticket not found.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        const user = await client.users.fetch(ticket.userId).catch(() => null);
        if (!user) {
            await interaction.reply({ content: 'User not found.', flags: [MessageFlags.Ephemeral] });
            return;
        }

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle('User Information')
            .setThumbnail(user.displayAvatarURL())
            .setColor(0x2B2D31)
            .addFields(
                { name: 'Username', value: user.tag, inline: true },
                { name: 'ID', value: `\`${user.id}\``, inline: true },
                { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: false },
                { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp! / 1000)}:R>` : 'Not in server', inline: false }
            );

        // Add roles if member
        if (member) {
            const roles = member.roles.cache
                .filter(r => r.id !== interaction.guild!.id)
                .sort((a, b) => b.position - a.position)
                .map(r => r.toString())
                .slice(0, 10);

            embed.addFields({ name: 'Roles', value: roles.join(' ') || 'None', inline: false });
        }

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

}

export const modMailService = new ModMailService();

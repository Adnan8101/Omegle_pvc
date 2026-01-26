import {
    TextChannel,
    Message,
    AttachmentBuilder,
    Collection,
    MessageType
} from 'discord.js';

export class TranscriptService {

    public async generateTranscript(channel: TextChannel): Promise<AttachmentBuilder> {
        let messages: Collection<string, Message> = new Collection();
        let lastId: string | undefined;

        while (true) {
            const fetched: Collection<string, Message> = await channel.messages.fetch({
                limit: 100,
                before: lastId
            });
            if (fetched.size === 0) break;

            messages = messages.concat(fetched);
            lastId = fetched.last()?.id;

            if (fetched.size < 100) break;
        }

        // Sort chronologically
        const sortedMessages = messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        const html = this.buildHtml(channel, sortedMessages);

        return new AttachmentBuilder(Buffer.from(html), { name: `transcript-${channel.name}.html` });
    }

    private buildHtml(channel: TextChannel, messages: Collection<string, Message>): string {
        // Premium Transcript with full fidelity: colors, emojis, media, roles, etc.
        
        const style = `
            body { background-color: #36393f; color: #dcddde; font-family: 'Whitney', 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 20px; }
            .message { display: flex; margin-bottom: 20px; position: relative; }
            .avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 20px; flex-shrink: 0; }
            .content { flex: 1; min-width: 0; }
            .header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
            .username { font-weight: 600; cursor: pointer; }
            .role-badge { font-size: 0.625rem; font-weight: 500; padding: 2px 4px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
            .timestamp { color: #72767d; font-size: 0.75rem; margin-left: 4px; }
            .text { white-space: pre-wrap; word-wrap: break-word; margin-top: 5px; line-height: 1.375rem; }
            .embed { border-left: 4px solid; padding: 8px 16px; background: #2f3136; margin-top: 8px; border-radius: 4px; max-width: 520px; }
            .embed-author { display: flex; align-items: center; margin-bottom: 8px; }
            .embed-author-icon { width: 24px; height: 24px; border-radius: 50%; margin-right: 8px; }
            .embed-author-name { font-size: 0.875rem; font-weight: 600; }
            .embed-title { font-size: 1rem; font-weight: 600; margin-bottom: 8px; }
            .embed-description { font-size: 0.875rem; }
            .embed-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 8px; }
            .embed-field { font-size: 0.875rem; }
            .embed-field-name { font-weight: 600; margin-bottom: 4px; }
            .embed-footer { display: flex; align-items: center; margin-top: 8px; font-size: 0.75rem; color: #dcddde; }
            .embed-footer-icon { width: 20px; height: 20px; border-radius: 50%; margin-right: 8px; }
            .embed-thumbnail { float: right; max-width: 80px; max-height: 80px; border-radius: 4px; margin-left: 16px; }
            .embed-image { max-width: 400px; max-height: 300px; border-radius: 4px; margin-top: 16px; }
            .attachment { margin-top: 10px; }
            .attachment img, .attachment video { max-width: 400px; max-height: 400px; border-radius: 4px; }
            .attachment audio { max-width: 400px; }
            .sticker { max-width: 160px; max-height: 160px; margin-top: 8px; }
            .mention { background: #5865f233; color: #dee0fc; padding: 0 2px; border-radius: 3px; font-weight: 500; cursor: pointer; }
            .mention:hover { background: #5865f255; color: #fff; text-decoration: underline; }
            .emoji { width: 22px; height: 22px; vertical-align: middle; }
            .emoji-large { width: 48px; height: 48px; }
            .code-inline { background: #2f3136; padding: 2px 4px; border-radius: 3px; font-family: 'Consolas', 'Monaco', monospace; font-size: 0.875rem; }
            .code-block { background: #2f3136; padding: 8px; border-radius: 4px; font-family: 'Consolas', 'Monaco', monospace; font-size: 0.875rem; overflow-x: auto; margin: 8px 0; }
            .spoiler { background: #202225; color: transparent; border-radius: 3px; padding: 0 2px; cursor: pointer; }
            .spoiler:hover { background: #202225; color: #dcddde; }
        `;

        let rows = '';

        messages.forEach((msg: Message) => {
            const date = msg.createdAt.toLocaleString();
            const avatar = msg.author.displayAvatarURL({ extension: 'png', size: 128 });
            const username = msg.author.tag;
            
            // Get member to access role colors
            const member = msg.member;
            const roleColor = member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : '#ffffff';
            
            // Get highest role badge
            let roleBadge = '';
            if (member && member.roles.highest.name !== '@everyone') {
                const highestRole = member.roles.highest;
                const roleDisplayColor = highestRole.hexColor !== '#000000' ? highestRole.hexColor : '#99aab5';
                roleBadge = `<span class="role-badge" style="background-color: ${roleDisplayColor}22; color: ${roleDisplayColor};">${highestRole.name}</span>`;
            }

            let contentHtml = this.formatContentPremium(msg.content, msg);

            // Handle Stickers
            if (msg.stickers.size > 0) {
                msg.stickers.forEach((sticker: any) => {
                    const stickerUrl = `https://media.discordapp.net/stickers/${sticker.id}.${sticker.format === 3 ? 'gif' : 'png'}`;
                    contentHtml += `<img src="${stickerUrl}" class="sticker" alt="${sticker.name}">`;
                });
            }

            // Handle Embeds with full color and structure
            msg.embeds.forEach((embed: any) => {
                const embedColor = embed.hexColor || '#4f545c';
                contentHtml += `<div class="embed" style="border-color: ${embedColor};">`;
                
                // Embed Author
                if (embed.author) {
                    contentHtml += `<div class="embed-author">`;
                    if (embed.author.iconURL) {
                        contentHtml += `<img src="${embed.author.iconURL}" class="embed-author-icon">`;
                    }
                    contentHtml += `<span class="embed-author-name">${this.escapeHtml(embed.author.name)}</span>`;
                    contentHtml += `</div>`;
                }
                
                // Embed Thumbnail
                if (embed.thumbnail) {
                    contentHtml += `<img src="${embed.thumbnail.url}" class="embed-thumbnail">`;
                }
                
                // Embed Title
                if (embed.title) {
                    const titleText = this.escapeHtml(embed.title);
                    if (embed.url) {
                        contentHtml += `<div class="embed-title"><a href="${embed.url}" target="_blank" style="color: #00b0f4;">${titleText}</a></div>`;
                    } else {
                        contentHtml += `<div class="embed-title">${titleText}</div>`;
                    }
                }
                
                // Embed Description
                if (embed.description) {
                    contentHtml += `<div class="embed-description">${this.formatContentPremium(embed.description, msg)}</div>`;
                }
                
                // Embed Fields
                if (embed.fields && embed.fields.length > 0) {
                    contentHtml += `<div class="embed-fields">`;
                    embed.fields.forEach((f: any) => {
                        contentHtml += `<div class="embed-field">`;
                        contentHtml += `<div class="embed-field-name">${this.escapeHtml(f.name)}</div>`;
                        contentHtml += `<div class="embed-field-value">${this.formatContentPremium(f.value, msg)}</div>`;
                        contentHtml += `</div>`;
                    });
                    contentHtml += `</div>`;
                }
                
                // Embed Image
                if (embed.image) {
                    contentHtml += `<img src="${embed.image.url}" class="embed-image">`;
                }
                
                // Embed Footer
                if (embed.footer) {
                    contentHtml += `<div class="embed-footer">`;
                    if (embed.footer.iconURL) {
                        contentHtml += `<img src="${embed.footer.iconURL}" class="embed-footer-icon">`;
                    }
                    contentHtml += `<span>${this.escapeHtml(embed.footer.text)}</span>`;
                    if (embed.timestamp) {
                        contentHtml += ` • ${new Date(embed.timestamp).toLocaleString()}`;
                    }
                    contentHtml += `</div>`;
                }
                
                contentHtml += `</div>`;
            });

            // Handle Attachments (images, videos, audio, files)
            msg.attachments.forEach((att: any) => {
                contentHtml += `<div class="attachment">`;
                if (att.contentType?.startsWith('image/')) {
                    contentHtml += `<a href="${att.url}" target="_blank"><img src="${att.url}" alt="${att.name}"></a>`;
                } else if (att.contentType?.startsWith('video/')) {
                    contentHtml += `<video src="${att.url}" controls></video>`;
                } else if (att.contentType?.startsWith('audio/')) {
                    contentHtml += `<audio src="${att.url}" controls></audio>`;
                } else {
                    contentHtml += `<a href="${att.url}" target="_blank">📄 ${att.name} (${this.formatBytes(att.size)})</a>`;
                }
                contentHtml += `</div>`;
            });

            rows += `
                <div class="message">
                    <img src="${avatar}" class="avatar">
                    <div class="content">
                        <div class="header">
                            <span class="username" style="color: ${roleColor};">${this.escapeHtml(username)}</span>
                            ${roleBadge}
                            <span class="timestamp">${date}</span>
                        </div>
                        <div class="text">${contentHtml}</div>
                    </div>
                </div>
            `;
        });

        return `
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Transcript - ${channel.name}</title>
                    <style>${style}</style>
                </head>
                <body>
                    <h1 style="color: #fff;">Transcript for #${this.escapeHtml(channel.name)}</h1>
                    <p style="color: #72767d;">Generated at: ${new Date().toLocaleString()}</p>
                    <hr style="border-color: #4f545c;">
                    ${rows}
                </body>
            </html>
        `;
    }

    private escapeHtml(text: string): string {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    private formatContentPremium(content: string, message: Message): string {
        if (!content) return '';
        
        let safe = this.escapeHtml(content);

        // Code blocks (must be done before inline code)
        safe = safe.replace(/```([a-z]*)\n([\s\S]*?)```/g, (_, lang, code) => {
            return `<div class="code-block">${this.escapeHtml(code)}</div>`;
        });

        // Inline code
        safe = safe.replace(/`([^`]+)`/g, '<span class="code-inline">$1</span>');

        // Spoilers
        safe = safe.replace(/\|\|(.*?)\|\|/g, '<span class="spoiler">$1</span>');

        // Bold
        safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // Underline
        safe = safe.replace(/__(.*?)__/g, '<u>$1</u>');

        // Italics
        safe = safe.replace(/\*(.*?)\*/g, '<em>$1</em>');
        safe = safe.replace(/_(.*?)_/g, '<em>$1</em>');

        // Strikethrough
        safe = safe.replace(/~~(.*?)~~/g, '<s>$1</s>');

        // Custom emojis: <:name:id> or <a:name:id>
        safe = safe.replace(/&lt;a?:([^:]+):(\d+)&gt;/g, (_, name, id) => {
            return `<img src="https://cdn.discordapp.com/emojis/${id}.png" class="emoji" alt=":${name}:" title=":${name}:">`;
        });

        // User mentions
        safe = safe.replace(/&lt;@!?(\d+)&gt;/g, (_, userId) => {
            const mentionedUser = message.mentions.users.get(userId);
            const displayName = mentionedUser ? `@${mentionedUser.username}` : `@User`;
            return `<span class="mention">${displayName}</span>`;
        });

        // Role mentions
        safe = safe.replace(/&lt;@&amp;(\d+)&gt;/g, (_, roleId) => {
            const mentionedRole = message.guild?.roles.cache.get(roleId);
            const roleName = mentionedRole ? `@${mentionedRole.name}` : `@Role`;
            const roleColor = mentionedRole?.hexColor || '#5865f2';
            return `<span class="mention" style="background-color: ${roleColor}33; color: ${roleColor};">${roleName}</span>`;
        });

        // Channel mentions
        safe = safe.replace(/&lt;#(\d+)&gt;/g, (_, channelId) => {
            const mentionedChannel = message.guild?.channels.cache.get(channelId);
            const channelName = mentionedChannel ? `#${mentionedChannel.name}` : `#channel`;
            return `<span class="mention">${channelName}</span>`;
        });

        // URLs
        safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color: #00b0f4;">$1</a>');

        // Newlines
        safe = safe.replace(/\n/g, '<br>');

        return safe;
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

export const transcriptService = new TranscriptService();

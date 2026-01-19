import {
    Client,
    Collection,
    GatewayIntentBits,
    Partials,
    type ChatInputCommandInteraction,
    type SlashCommandBuilder,
} from 'discord.js';

export interface Command {
    data: SlashCommandBuilder;
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export class PVCClient extends Client {
    commands: Collection<string, Command> = new Collection();

    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [Partials.Channel, Partials.Reaction],
        });
    }
}

export const client = new PVCClient();

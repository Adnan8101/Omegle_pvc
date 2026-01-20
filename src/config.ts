import { config } from 'dotenv';
config();

export const Config = {
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    guildId: process.env.DISCORD_GUILD_ID,
    databaseUrl: process.env.DATABASE_URL!,
} as const;

const requiredKeys = ['token', 'clientId', 'databaseUrl'] as const;
for (const key of requiredKeys) {
    if (!Config[key]) {
        throw new Error(`Missing required environment variable: ${key.toUpperCase()}`);
    }
}

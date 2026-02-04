// Bug #14 Fix: Extract magic numbers to named constants

// Cache TTL
export const CACHE_TTL = {
    GUILD_SETTINGS: 5 * 60 * 1000, // 5 minutes
    PERMISSIONS: 2 * 60 * 1000, // 2 minutes
    CHANNEL_PERMISSIONS: 2 * 60 * 1000, // 2 minutes
    OWNER_PERMISSIONS: 2 * 60 * 1000, // 2 minutes
    WHITELIST: 5 * 60 * 1000, // 5 minutes
};

// Rate Limiting
export const RATE_LIMITS = {
    BATCH_PERMISSION_DELAY: 100, // ms between permissions for large batches
    WEBHOOK_RETRY_DELAY: 1000, // ms base delay for webhook retries
    GUILD_REFRESH_RETRY_DELAY: 2000, // ms base delay for guild refresh retries
};

// Retry Configuration
export const RETRY_CONFIG = {
    MAX_WEBHOOK_ATTEMPTS: 3,
    MAX_GUILD_REFRESH_ATTEMPTS: 3,
};

// Permission Batch Thresholds
export const PERMISSION_THRESHOLDS = {
    LARGE_BATCH_SIZE: 10, // Consider it "large" if more than 10 users
};

// Discord ID Validation
export const DISCORD_ID_REGEX = /^\d{17,19}$/;

// Cooldowns (milliseconds)
export const COOLDOWNS = {
    COMMAND_TRACKING: 24 * 60 * 60 * 1000, // 24 hours
    FREQUENCY_CHECK: 60 * 60 * 1000, // 1 hour
};

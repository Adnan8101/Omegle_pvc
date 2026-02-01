-- Kill all idle connections from the bot
-- Run this if you get "too many connections" errors
-- Usage: psql $DATABASE_URL -f scripts/cleanup-db-connections.sql

\echo '📊 Current Database Connections:'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

-- Show current connections summary
SELECT 
    COUNT(*) as total_connections,
    COUNT(*) FILTER (WHERE state = 'active') as active,
    COUNT(*) FILTER (WHERE state = 'idle') as idle,
    COUNT(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction
FROM pg_stat_activity
WHERE datname = current_database();

\echo ''
\echo '🧹 Killing idle connections...'

-- Kill idle connections older than 5 minutes
WITH killed_idle AS (
    SELECT pg_terminate_backend(pid) as terminated, pid
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'idle'
      AND state_change < NOW() - INTERVAL '5 minutes'
      AND pid <> pg_backend_pid()
)
SELECT COUNT(*) as idle_killed FROM killed_idle WHERE terminated = true;

-- Kill idle in transaction connections older than 30 seconds
WITH killed_tx AS (
    SELECT pg_terminate_backend(pid) as terminated, pid
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'idle in transaction'
      AND state_change < NOW() - INTERVAL '30 seconds'
      AND pid <> pg_backend_pid()
)
SELECT COUNT(*) as idle_tx_killed FROM killed_tx WHERE terminated = true;

\echo ''
\echo '✅ Cleanup complete. Remaining connections:'

-- Show remaining connections after cleanup
SELECT 
    COUNT(*) as total_connections,
    COUNT(*) FILTER (WHERE state = 'active') as active,
    COUNT(*) FILTER (WHERE state = 'idle') as idle,
    COUNT(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction
FROM pg_stat_activity
WHERE datname = current_database();

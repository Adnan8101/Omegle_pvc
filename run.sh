#!/bin/bash

# PVC Bot Startup Script with PM2
# This script checks for PM2, builds, and runs/restarts the bot

set -e  # Exit on any error

BOT_NAME="pvc-bot"

echo "�️  Cleaning old build..."
rm -rf dist

echo "�🔍 Checking PM2 status..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ PM2 is not installed. Installing PM2..."
    npm install -g pm2
fi

# Check if bot is already running in PM2
if pm2 list | grep -q "$BOT_NAME"; then
    echo "✅ Bot found in PM2, rebuilding and restarting..."
    
    echo "🔨 Building TypeScript..."
    npx prisma generate
    npm run build
    
    echo "📝 Registering slash commands..."
    npm run register
    
    echo "🔄 Restarting bot with PM2..."
    pm2 restart "$BOT_NAME"
    pm2 save
    
    echo "✅ Bot restarted successfully!"
else
    echo "🆕 Bot not found in PM2, setting up new instance..."
    
    echo "🔨 Building TypeScript..."
    npx prisma generate
    npm run build
    
    echo "📝 Registering slash commands..."
    npm run register
    
    echo "🚀 Starting bot with PM2..."
    pm2 start npm --name "$BOT_NAME" -- start
    pm2 save
    pm2 startup
    
    echo "✅ Bot started successfully!"
fi

echo ""
echo "📊 PM2 Status:"
pm2 list
echo ""
echo "💡 Useful PM2 commands:"
echo "  pm2 logs $BOT_NAME     - View logs"
echo "  pm2 stop $BOT_NAME     - Stop bot"
echo "  pm2 restart $BOT_NAME  - Restart bot"
echo "  pm2 delete $BOT_NAME   - Remove bot from PM2"

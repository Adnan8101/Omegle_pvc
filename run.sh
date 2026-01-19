#!/bin/bash

# PVC Bot Startup Script
# This script builds, registers commands, and starts the bot

set -e  # Exit on any error

echo "🔨 Building TypeScript..."
npx prisma generate
npm run build

echo "📝 Registering slash commands..."
npm run register

echo "🚀 Starting PVC Bot..."
npm start

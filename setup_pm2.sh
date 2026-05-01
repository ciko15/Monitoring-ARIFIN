#!/bin/bash

# PM2 Setup Script for Monitoring ARIFIN
# This script sets up PM2 with automatic startup on macOS

echo "=========================================="
echo "   PM2 Setup for Monitoring ARIFIN       "
echo "=========================================="

PROJECT_DIR="/Volumes/MUSIC CAR/Monitoring-ARIFIN-main"
PLIST_FILE="$PROJECT_DIR/com.monitoring.arifin.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

# 1. Stop existing processes
echo "[1/4] Stopping existing processes..."
pm2 stop monitoring-arifin 2>/dev/null || true
pm2 delete monitoring-arifin 2>/dev/null || true

# Kill any existing bun processes
echo "  🛑 Killing existing bun processes..."
pkill -f "bun.*src/server.ts" || true
sleep 2

# 2. Start with PM2
echo "[2/4] Starting application with PM2..."
cd "$PROJECT_DIR"
pm2 start ecosystem.config.js --env production

if [ $? -eq 0 ]; then
    echo "  ✅ Application started with PM2"
else
    echo "  ❌ Failed to start with PM2"
    exit 1
fi

# 3. Save PM2 configuration
echo "[3/4] Saving PM2 configuration..."
pm2 save

# 4. Setup launchd for automatic startup
echo "[4/4] Setting up automatic startup..."

# Copy plist to LaunchAgents
cp "$PLIST_FILE" "$LAUNCH_AGENTS_DIR/"

# Load the service
launchctl unload "$LAUNCH_AGENTS_DIR/com.monitoring.arifin.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS_DIR/com.monitoring.arifin.plist"

if [ $? -eq 0 ]; then
    echo "  ✅ Automatic startup configured"
    echo "  📝 Service: com.monitoring.arifin"
    echo "  📍 Plist location: $LAUNCH_AGENTS_DIR/com.monitoring.arifin.plist"
else
    echo "  ❌ Failed to setup automatic startup"
fi

echo "=========================================="
echo "   Setup Complete!                        "
echo "=========================================="
echo ""
echo "Management commands:"
echo "  pm2 status                    # Check status"
echo "  pm2 logs monitoring-arifin    # View logs"
echo "  pm2 restart monitoring-arifin # Restart app"
echo "  pm2 stop monitoring-arifin    # Stop app"
echo ""
echo "The application will now start automatically"
echo "when the server boots up."
echo "=========================================="
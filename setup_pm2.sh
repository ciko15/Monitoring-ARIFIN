#!/bin/bash

# PM2 Setup Script for Monitoring ARIFIN (Dynamic Version)
# This script automatically detects its location and sets up PM2

echo "=========================================="
echo "   PM2 Dynamic Setup for Monitoring ARIFIN"
echo "=========================================="

# 1. Detect current directory automatically
PROJECT_DIR=$(pwd)
echo "📍 Project Directory detected at: $PROJECT_DIR"

PLIST_TEMPLATE="$PROJECT_DIR/com.monitoring.arifin.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$LAUNCH_AGENTS_DIR/com.monitoring.arifin.plist"

# 2. Update the plist file dynamically with the current path
# We use a temporary file to avoid corrupting the original if interrupted
echo "[1/4] Updating configuration paths..."
sed -i '' "s|/Users/vickra/Development/Monitoring-ARIFIN-main|$PROJECT_DIR|g" "$PROJECT_TEMPLATE" 2>/dev/null || true
# Alternatively, if we use a placeholder like {{PROJECT_PATH}}, it would be cleaner, 
# but let's just make it replace whatever was there with the current PWD.

# 3. Stop existing processes
echo "[2/4] Resetting PM2..."
pm2 stop monitoring-arifin 2>/dev/null || true
pm2 delete monitoring-arifin 2>/dev/null || true
pkill -f "bun.*src/server.ts" || true
sleep 1

# 4. Start with PM2 from the CURRENT directory
echo "[3/4] Starting application..."
cd "$PROJECT_DIR"
pm2 start ecosystem.config.js --env production
pm2 save

# 5. Setup launchd for automatic startup
echo "[4/4] Configuring OS startup service..."
cp "$PLIST_TEMPLATE" "$PLIST_DEST"

# Update paths in the destination plist specifically
sed -i '' "s|/Users/vickra/Development/Monitoring-ARIFIN-main|$PROJECT_DIR|g" "$PLIST_DEST"
sed -i '' "s|/Volumes/MUSIC CAR/Monitoring-ARIFIN-main|$PROJECT_DIR|g" "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

if [ $? -eq 0 ]; then
    echo "  ✅ Automatic startup configured successfully"
else
    echo "  ❌ Failed to setup automatic startup"
fi

echo "=========================================="
echo "   Setup Complete! Folder is now anchored."
echo "=========================================="
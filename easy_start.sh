#!/bin/bash

# Easy Start Script for CIKO Sniffer
# This script automates the permission fix and restarts the development server.

PASSWORD="29okt2017"
PORT=3100

echo "=========================================="
echo "   CIKO Automatic Activation Tool        "
echo "=========================================="

# 1. Fix BPF Permissions (required for macOS network capture)
echo "[1/3] Activating Network Capture Tools..."
echo "$PASSWORD" | sudo -S bash fix_bpf_permissions.sh > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "  ✅ Network Capture Activated (BPF Permissions Fixed)"
else
    echo "  ❌ Failed to activate capture tools. Please check your password."
    exit 1
fi

# 2. Stop existing CIKO processes
echo "[2/3] Cleaning up old processes..."
# Find any bun processes running src/server.ts
PID=$(ps aux | grep "src/server.ts" | grep -v grep | awk '{print $2}')
if [ ! -z "$PID" ]; then
    echo "  🛑 Stopping existing server (PID: $PID)..."
    kill -9 $PID
    sleep 1
fi

# Also check for anything on the port
PORT_PID=$(lsof -t -i :$PORT)
if [ ! -z "$PORT_PID" ]; then
    echo "  🛑 Clearing port $PORT (PID: $PORT_PID)..."
    kill -9 $PORT_PID
    sleep 1
fi

# 3. Start Bun Server
echo "[3/3] Starting CIKO Server..."
echo "  🚀 Server is starting at http://localhost:$PORT"
echo "=========================================="

# Start the server (using Bun)
/Users/vickra/.bun/bin/bun src/server.ts

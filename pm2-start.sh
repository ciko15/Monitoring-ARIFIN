#!/bin/bash
# PM2 Entry Script for Monitoring ARIFIN
# This ensures Bun is used correctly with PM2

export NODE_ENV=production
export PORT=3100

# Start the Bun server
exec /Users/vickra/.bun/bin/bun src/server.ts
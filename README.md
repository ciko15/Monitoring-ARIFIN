# CIKO - Direct Equipment Monitoring (No Gateway)

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start server
npm start

# Or development mode
npm run dev
```

## 🔄 PM2 Production Setup (Auto-start on Boot)

```bash
# Setup PM2 dengan automatic startup
npm run pm2:setup

# Atau manual setup:
npm run pm2:start
npm run pm2:save
sudo env PATH=$PATH:/usr/local/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup launchd -u vickra --hp /Users/vickra
```

### ✅ Status: PM2 Configured & Running
- ✅ PM2 process: `monitoring-arifin` (PID dinamis)
- ✅ Auto-restart on crash: Enabled
- ✅ Memory monitoring: 1GB limit
- ✅ Logs: `./logs/pm2-*.log`
- ✅ API accessible: http://localhost:3100

### PM2 Management Commands

```bash
# Check status
npm run pm2:logs

# Monitor resources
npm run pm2:monit

# Restart application
npm run pm2:restart

# Stop application
npm run pm2:stop

# Remove from PM2
npm run pm2:delete
```

**Benefits:**
- ✅ Auto-restart on crash
- ✅ Auto-start on server boot (setelah setup manual)
- ✅ Memory monitoring
- ✅ Log management
- ✅ Process clustering ready

**Files Created:**
- `ecosystem.config.js` - PM2 configuration
- `pm2-start.sh` - Startup script
- `com.monitoring.arifin.plist` - macOS launchd service
- `logs/` - Log directory

## 📱 Features

✅ **Direct Equipment Connection** - No gateway ping dependency  
✅ **Public Dashboard** - View stats without login  
✅ **Role-based Access**  
   - `admin/admin` → Equipment management  
   - `superadmin/superadmin` → Full templates access  

✅ **Live Auto-refresh** (20s intervals)  
✅ **Network Tools** - Ping, SNMP test, packet capture  
✅ **File Logging** - Hourly logs per equipment  

## 📍 Login (Optional - Sidebar)

```
Click User Panel → Login
admin/admin
superadmin/superadmin
```

## 🎯 Branch Deployment

App starts **directly** - monitors equipment IP only. Perfect for cabang install!

## 🛠️ API Endpoints

```
GET /api/equipment/stats     → Public dashboard
GET /api/airports           → Map data  
POST /api/ping/start        → Ping tool
```

## ✅ Status: Production Ready

**Gateway removal complete** - Direct connect works!

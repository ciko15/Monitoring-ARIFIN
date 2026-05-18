const os = require('os');
const path = require('path');

// Deteksi OS dan tentukan interpreter path
let interpreterPath = 'bun'; // default, gunakan bun dari PATH

if (os.platform() === 'win32') {
  // Windows: gunakan full path ke bun.exe
  const userHome = process.env.USERPROFILE || process.env.HOME;
  interpreterPath = path.join(userHome, '.bun', 'bin', 'bun.exe');
} else if (os.platform() === 'darwin') {
  // macOS: gunakan full path ke bun
  const userHome = process.env.HOME;
  interpreterPath = path.join(userHome, '.bun', 'bin', 'bun');
}

module.exports = {
  apps: [{
    name: 'monitoring-arifin',
    script: 'src/server.ts',
    interpreter: interpreterPath,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3100
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3100
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    // Restart aplikasi jika crash
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
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
      PORT: process.env.PORT || 3100,
      SITE_ID: process.env.SITE_ID || 'WAJJ',
      AIRPORT_SITE_ID: process.env.AIRPORT_SITE_ID || process.env.SITE_ID || 'WAJJ',
      MESSAGE_SERVICE_NAME: process.env.MESSAGE_SERVICE_NAME || 'MONITORING_ARIFIN_BRANCH',
      CENTRAL_SERVICE_NAME: process.env.CENTRAL_SERVICE_NAME || 'EMS',
      TARGET_SERVICE_NAME: process.env.TARGET_SERVICE_NAME || 'EMS',
      RABBITMQ_PROTOCOL: process.env.RABBITMQ_PROTOCOL || 'amqp',
      RABBITMQ_HOST: process.env.RABBITMQ_HOST || '172.20.17.104',
      RABBITMQ_PORT: process.env.RABBITMQ_PORT || 5672,
      RABBITMQ_USERNAME: process.env.RABBITMQ_USERNAME || 'smart-toc-hq',
      RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD || 'smarthq123!',
      RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || 'dev-smart'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3100,
      SITE_ID: process.env.SITE_ID || 'WAJJ',
      AIRPORT_SITE_ID: process.env.AIRPORT_SITE_ID || process.env.SITE_ID || 'WAJJ',
      MESSAGE_SERVICE_NAME: process.env.MESSAGE_SERVICE_NAME || 'MONITORING_ARIFIN_BRANCH',
      CENTRAL_SERVICE_NAME: process.env.CENTRAL_SERVICE_NAME || 'EMS',
      TARGET_SERVICE_NAME: process.env.TARGET_SERVICE_NAME || 'EMS',
      RABBITMQ_PROTOCOL: process.env.RABBITMQ_PROTOCOL || 'amqp',
      RABBITMQ_HOST: process.env.RABBITMQ_HOST || '172.20.17.104',
      RABBITMQ_PORT: process.env.RABBITMQ_PORT || 5672,
      RABBITMQ_USERNAME: process.env.RABBITMQ_USERNAME || 'smart-toc-hq',
      RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD || 'smarthq123!',
      RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || 'dev-smart'
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

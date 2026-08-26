const os = require('os');
const path = require('path');

let defaultSiteId = 'WAJJ';
try {
  const airportConfig = require('./db/airport_config.json');
  if (Array.isArray(airportConfig) && airportConfig.length > 0 && airportConfig[0].siteId) {
    defaultSiteId = airportConfig[0].siteId;
  } else if (airportConfig && !Array.isArray(airportConfig) && airportConfig.siteId) {
    defaultSiteId = airportConfig.siteId;
  }
} catch (e) {
  console.warn('Gagal membaca db/airport_config.json, menggunakan default SITE_ID =', defaultSiteId);
}

let bunPath = 'bun';
if (os.platform() === 'win32') {
  const userHome = process.env.USERPROFILE || process.env.HOME;
  bunPath = path.join(userHome, '.bun', 'bin', 'bun.exe');
} else if (os.platform() === 'darwin') {
  const userHome = process.env.HOME;
  bunPath = path.join(userHome, '.bun', 'bin', 'bun');
}

const stabilityEnv = {
  EMS_ENABLED: process.env.EMS_ENABLED || 'true',
  EMS_PUBLISH_TIMEOUT_MS: process.env.EMS_PUBLISH_TIMEOUT_MS || 2000,
  EMS_RETRY_BACKOFF_MS: process.env.EMS_RETRY_BACKOFF_MS || 30000,
  EMS_MAX_BACKOFF_MS: process.env.EMS_MAX_BACKOFF_MS || 300000,
  FAIL_COUNT_TO_DISCONNECT: process.env.FAIL_COUNT_TO_DISCONNECT || 3,
  RECOVERY_COUNT_TO_NORMAL: process.env.RECOVERY_COUNT_TO_NORMAL || 1,
  DISCONNECT_REPEAT_INTERVAL_MS: process.env.DISCONNECT_REPEAT_INTERVAL_MS || 15 * 60 * 1000,
  QUEUE_TTL_MS: process.env.QUEUE_TTL_MS || 30 * 60 * 1000,
  QUEUE_MAX_PENDING: process.env.QUEUE_MAX_PENDING || 5000,
  STARTUP_WATCHDOG_GRACE_MS: process.env.STARTUP_WATCHDOG_GRACE_MS || 3 * 60 * 1000,
  COLLECTOR_START_BATCH_SIZE: process.env.COLLECTOR_START_BATCH_SIZE || 10,
  COLLECTOR_START_BATCH_DELAY_MS: process.env.COLLECTOR_START_BATCH_DELAY_MS || 3000,
  LOG_THROTTLE_MS: process.env.LOG_THROTTLE_MS || 60000,
  RAW_DEBUG: process.env.RAW_DEBUG || 'false'
};

const commonEnv = {
  NODE_ENV: 'production',
  SITE_ID: process.env.SITE_ID || defaultSiteId,
  AIRPORT_SITE_ID: process.env.AIRPORT_SITE_ID || process.env.SITE_ID || defaultSiteId,
  MESSAGE_SERVICE_NAME: process.env.MESSAGE_SERVICE_NAME || 'MONITORING_ARIFIN_BRANCH',
  CENTRAL_SERVICE_NAME: process.env.CENTRAL_SERVICE_NAME || 'EMS',
  TARGET_SERVICE_NAME: process.env.TARGET_SERVICE_NAME || 'EMS',
  /* === RABBITMQ (LAMA) ===
  RABBITMQ_PROTOCOL: process.env.RABBITMQ_PROTOCOL || 'amqp',
  RABBITMQ_HOST: process.env.RABBITMQ_HOST || '172.20.17.104',
  RABBITMQ_PORT: process.env.RABBITMQ_PORT || 5672,
  RABBITMQ_USERNAME: process.env.RABBITMQ_USERNAME || 'smart-toc-hq',
  RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD || 'smarthq123!',
  RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || 'dev-smart',
  */
  // === SOLACE (BARU) ===
  RABBITMQ_PROTOCOL: process.env.RABBITMQ_PROTOCOL || 'amqp',
  RABBITMQ_HOST: process.env.RABBITMQ_HOST || '172.20.16.123',
  RABBITMQ_PORT: process.env.RABBITMQ_PORT || 5672,
  RABBITMQ_USERNAME: process.env.RABBITMQ_USERNAME || 'smart-toc-hq',
  RABBITMQ_PASSWORD: process.env.RABBITMQ_PASSWORD || 'smarthq123!',
  RABBITMQ_VHOST: process.env.RABBITMQ_VHOST || '/',
  ...stabilityEnv
};

module.exports = {
  apps: [
    {
      name: 'monitoring-web',
      script: 'src/web.ts',
      cwd: './',
      interpreter: bunPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...commonEnv,
        PORT: 3100,
        SERVICE_ROLE: 'web'
      },
      error_file: 'NUL',
      out_file: 'NUL',
      log_file: 'NUL',
      merge_logs: false,
      time: true
    },
    {
      name: 'monitoring-collector',
      script: 'src/collector.ts',
      cwd: './',
      interpreter: bunPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...commonEnv,
        SERVICE_ROLE: 'collector'
      },
      error_file: 'NUL',
      out_file: 'NUL',
      log_file: 'NUL',
      merge_logs: false,
      time: true
    },
    {
      name: 'monitoring-processor',
      script: 'src/processor.ts',
      cwd: './',
      interpreter: bunPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        ...commonEnv,
        SERVICE_ROLE: 'processor'
      },
      error_file: 'NUL',
      out_file: 'NUL',
      log_file: 'NUL',
      merge_logs: false,
      time: true
    }
  ]
};

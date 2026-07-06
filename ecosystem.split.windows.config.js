const os = require('os');
const path = require('path');

let bunPath = 'bun';
if (os.platform() === 'win32') {
  const userHome = process.env.USERPROFILE || process.env.HOME;
  bunPath = path.join(userHome, '.bun', 'bin', 'bun.exe');
} else if (os.platform() === 'darwin') {
  const userHome = process.env.HOME;
  bunPath = path.join(userHome, '.bun', 'bin', 'bun');
}

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
        NODE_ENV: 'production',
        PORT: 3100
      },
      error_file: './logs/pm2-web-error.log',
      out_file: './logs/pm2-web-out.log',
      log_file: './logs/pm2-web-combined.log',
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
        NODE_ENV: 'production'
      },
      error_file: './logs/pm2-collector-error.log',
      out_file: './logs/pm2-collector-out.log',
      log_file: './logs/pm2-collector-combined.log',
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
        NODE_ENV: 'production',
        EMS_ENABLED: 'false'
      },
      error_file: './logs/pm2-processor-error.log',
      out_file: './logs/pm2-processor-out.log',
      log_file: './logs/pm2-processor-combined.log',
      time: true
    }
  ]
};

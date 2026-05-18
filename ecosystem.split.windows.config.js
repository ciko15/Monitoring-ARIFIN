module.exports = {
  apps: [
    {
      name: 'monitoring-web',
      script: 'bun',
      args: ['src/web.ts'],
      cwd: './',
      interpreter: 'none',
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
      script: 'bun',
      args: ['src/collector.ts'],
      cwd: './',
      interpreter: 'none',
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
      script: 'bun',
      args: ['src/processor.ts'],
      cwd: './',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/pm2-processor-error.log',
      out_file: './logs/pm2-processor-out.log',
      log_file: './logs/pm2-processor-combined.log',
      time: true
    }
  ]
};

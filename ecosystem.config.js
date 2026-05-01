module.exports = {
  apps: [{
    name: 'monitoring-arifin',
    script: '/Users/vickra/.bun/bin/bun',
    args: ['src/server.ts'],
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
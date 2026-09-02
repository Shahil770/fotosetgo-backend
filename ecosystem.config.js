// PM2 Ecosystem Config — Optimized for KVM 1 (4GB RAM, 1 vCPU)
// Run: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'fotosetgo-backend',
      script: 'dist/main.js',

      // ── Single worker on 1 vCPU to eliminate duplicate timers and race conditions ──
      instances: 1,
      exec_mode: 'fork',

      // ── Memory limit per worker: 1.2GB (2 workers = 2.4GB, leaving 1.6GB for PG + Redis + OS) ──
      max_memory_restart: '1200M',

      // ── Node.js heap tuning ──
      node_args: '--max-old-space-size=1024',

      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },

      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

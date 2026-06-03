module.exports = {
  apps: [{
    name: 'prenotami-stalker',
    script: 'monitor.js',
    interpreter: 'xvfb-run',
    interpreter_args: '-a',
    autorestart: true,
    max_restarts: 50,
    min_uptime: '10s',
    restart_delay: 30000, // 30s between restarts
    watch: false,
    env: {
      NODE_ENV: 'production',
      // Override CHECK_INTERVAL_MS here if needed:
      // CHECK_INTERVAL_MS: 90000,
    },
  }],
};

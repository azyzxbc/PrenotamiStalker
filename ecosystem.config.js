module.exports = {
  apps: [{
    name: 'prenotami-stalker',
    script: 'monitor.js',
    // No need for xvfb-run since we use headless: 'new'
    autorestart: true,
    max_restarts: 50,
    min_uptime: '10s',
    restart_delay: 30000, // 30s between restarts
    watch: false,
    env: {
      NODE_ENV: 'production',
      // Override CHECK_INTERVAL_MS here if needed:
      // CHECK_INTERVAL_MS: 90000,
      // Set HEADLESS=false to use headful mode (requires xvfb)
      // HEADLESS: 'false',
    },
  }],
};

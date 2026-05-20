/**
 * Prenotami Appointment Monitor v2
 * 
 * Uses your existing Chrome session cookies to avoid bot detection.
 * Monitors https://prenotami.esteri.it/Services/Booking/2359 for slots
 * and sends Telegram notifications + sound alarm.
 * 
 * IMPORTANT: You must be logged into prenotami.esteri.it in Chrome first!
 * Close Chrome completely before running this script.
 * 
 * Usage:
 *   node monitor.js                  - Start monitoring
 *   node monitor.js --test-telegram  - Send a test Telegram message
 *   node monitor.js --test-sound     - Test the alarm sound
 */

require('dotenv').config();
const puppeteer = require('puppeteer-core');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ============================================================================
// Find Chrome/Edge on Windows
// ============================================================================

function findBrowserPath() {
  const candidates = [
    // Windows
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findChromeUserDataDir() {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  email: process.env.PRENOTAMI_EMAIL,
  password: process.env.PRENOTAMI_PASSWORD,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  checkInterval: parseInt(process.env.CHECK_INTERVAL_MS) || 120000,
  bookingUrl: process.env.BOOKING_URL || 'https://prenotami.esteri.it/Services/Booking/2359',
  loginUrl: 'https://prenotami.esteri.it/Home',
  noSlotsMessage: 'Sorry, all appointments for this service are currently booked',
};

// ============================================================================
// Logging
// ============================================================================

function log(level, message) {
  const timestamp = new Date().toLocaleString('fr-FR', { 
    timeZone: 'Africa/Algiers',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const icons = { INFO: 'ℹ️', SUCCESS: '✅', WARNING: '⚠️', ERROR: '❌', CHECK: '🔍' };
  console.log(`[${timestamp}] ${icons[level] || ''} ${level}: ${message}`);
}

// ============================================================================
// Sound Alarm (Windows)
// ============================================================================

function playAlarm() {
  log('INFO', '🔔 Playing alarm sound...');
  const beeps = [];
  for (let i = 0; i < 5; i++) {
    beeps.push(`[console]::beep(1000, 500); Start-Sleep -Milliseconds 200`);
    beeps.push(`[console]::beep(1500, 500); Start-Sleep -Milliseconds 200`);
    beeps.push(`[console]::beep(2000, 500); Start-Sleep -Milliseconds 300`);
  }
  exec(`powershell -Command "${beeps.join('; ')}"`, (err) => {
    if (err) log('WARNING', `Sound alarm failed: ${err.message}`);
  });
}

// ============================================================================
// Telegram Notification
// ============================================================================

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
      log('WARNING', 'Telegram not configured, skipping notification.');
      resolve(null);
      return;
    }

    const encodedMessage = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage?chat_id=${CONFIG.telegramChatId}&text=${encodedMessage}&parse_mode=Markdown`;

    log('INFO', 'Sending Telegram notification...');

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('SUCCESS', 'Telegram notification sent!');
          resolve(data);
        } else {
          log('ERROR', `Telegram API returned status ${res.statusCode}: ${data}`);
          reject(new Error(`Telegram API error: ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      log('ERROR', `Telegram notification failed: ${err.message}`);
      reject(err);
    });
  });
}

// ============================================================================
// Notify (Telegram + Sound)
// ============================================================================

async function notify(message) {
  // Play alarm on PC
  playAlarm();

  // Send Telegram notification 5 times to make the phone ring repeatedly
  for (let i = 0; i < 5; i++) {
    try {
      const urgency = i === 0 ? message : `🔔 RAPPEL ${i + 1}/5 — Créneau LEGALIZZAZIONI dispo!\n${CONFIG.bookingUrl}`;
      await sendTelegram(urgency);
    } catch (e) {
      log('ERROR', `Telegram #${i + 1} failed: ${e.message}`);
    }
    if (i < 4) await new Promise(r => setTimeout(r, 3000)); // 3s between messages
  }
}

// ============================================================================
// Prenotami Monitor
// ============================================================================

class PrenotamiMonitor {
  constructor() {
    this.browser = null;
    this.page = null;
    this.checkCount = 0;
    this.lastNotificationTime = 0;
    this.notificationCooldown = 5 * 60 * 1000;
    this.consecutiveErrors = 0;
  }

  async init(offscreen = true) {
    const browserPath = findBrowserPath();
    if (!browserPath) {
      log('ERROR', 'Chrome/Edge not found!');
      process.exit(1);
    }

    // Use a dedicated profile inside the project folder
    const profileDir = path.join(__dirname, 'chrome-profile');
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    log('INFO', `Browser: ${browserPath}`);
    log('INFO', `Profile: ${profileDir}`);
    log('INFO', 'Launching browser...');

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
    ];
    if (offscreen) args.push('--window-position=-2000,-2000');

    this.browser = await puppeteer.launch({
      headless: false,
      executablePath: browserPath,
      userDataDir: profileDir,
      args,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.setViewport({ width: 1366, height: 768 });

    log('SUCCESS', 'Browser launched!');
  }

  async login() {
    log('INFO', 'Auto-login: navigating to prenotami...');
    try {
      await this.page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const url = this.page.url();

      // Check if actually logged in by looking for user session indicators
      const isLoggedIn = await this.page.evaluate(() => {
        const text = document.body.innerText;
        // If we see "Disconnetti" or user menu, we're logged in
        return text.includes('Disconnetti') || text.includes('I miei appuntamenti');
      });

      if (isLoggedIn) {
        log('SUCCESS', 'Already logged in (session valid)!');
        return true;
      }

      // If on prenotami but NOT logged in, click the login link
      const currentLoginUrl = this.page.url();
      if (currentLoginUrl.includes('prenotami.esteri.it')) {
        log('INFO', 'On prenotami but not logged in, clicking login...');
        const loginClicked = await this.page.evaluate(() => {
          const link = document.querySelector('a[href*="iam.esteri.it"]');
          if (link) { link.click(); return true; }
          return false;
        });
        if (loginClicked) {
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
        }
      }

      // Should be on iam.esteri.it now — wait for SPA login form
      log('INFO', `Waiting for SSO login form on ${this.page.url().substring(0, 50)}...`);
      try {
        await this.page.waitForSelector('input[name="callback_1"]', { timeout: 15000 });
      } catch (e) {
        // SPA may be slow — wait more and retry
        log('INFO', 'Form not found yet, waiting 10s more...');
        await new Promise(r => setTimeout(r, 10000));
        // Check if we got redirected back (maybe already logged in via cookies)
        const urlNow = this.page.url();
        const loggedInNow = await this.page.evaluate(() => {
          return document.body.innerText.includes('Disconnetti') || document.body.innerText.includes('I miei appuntamenti');
        });
        if (loggedInNow) {
          log('SUCCESS', 'Already logged in (redirected back)!');
          return true;
        }
        await this.page.waitForSelector('input[name="callback_1"]', { timeout: 15000 });
      }
      await new Promise(r => setTimeout(r, 2000));

      // Fill email
      log('INFO', 'Entering credentials...');
      await this.page.click('input[name="callback_1"]', { clickCount: 3 });
      await this.page.type('input[name="callback_1"]', CONFIG.email, { delay: 30 });

      // Fill password
      await this.page.click('input[name="callback_2"]', { clickCount: 3 });
      await this.page.type('input[name="callback_2"]', CONFIG.password, { delay: 30 });

      // Click submit
      await this.page.click('button[type="submit"]');
      log('INFO', 'Submitted login, waiting for redirect...');

      // Wait for redirect back to prenotami — use polling fallback for slow SSO
      const loginStart = Date.now();
      const loginTimeout = 60000; // 60 seconds
      let loggedIn = false;

      // Try waitForNavigation first (may catch fast redirects)
      try {
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
      } catch (e) {
        log('INFO', 'First navigation wait timed out, polling URL...');
        // DEBUG: capture what the SSO page shows after submit
        try {
          const debugText = await this.page.evaluate(() => document.body.innerText);
          const debugHtml = await this.page.evaluate(() => document.body.innerHTML.substring(0, 2000));
          log('INFO', `[DEBUG] Page text after submit: ${debugText.substring(0, 500)}`);
          // Check for common SSO errors
          if (debugText.includes('Invalid') || debugText.includes('incorrect') || debugText.includes('Errore')) {
            log('ERROR', '[DEBUG] SSO shows an error message! Credentials may be wrong.');
          }
          if (debugHtml.includes('captcha') || debugHtml.includes('challenge') || debugHtml.includes('recaptcha')) {
            log('ERROR', '[DEBUG] CAPTCHA detected on SSO page!');
          }
        } catch (debugErr) {
          log('WARNING', `[DEBUG] Could not capture page content: ${debugErr.message}`);
        }
      }

      // Poll URL until we land on prenotami or timeout
      // IMPORTANT: use startsWith, NOT includes — the SSO URL contains
      // 'prenotami.esteri.it' in its goto= query parameter!
      while (Date.now() - loginStart < loginTimeout) {
        await new Promise(r => setTimeout(r, 3000));
        const currentUrl = this.page.url();
        if (currentUrl.startsWith('https://prenotami.esteri.it')) {
          loggedIn = true;
          break;
        }
        log('INFO', `Still waiting... URL: ${currentUrl.substring(0, 80)}...`);
        // Try to catch another navigation
        try {
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
        } catch (e) { /* keep polling */ }
      }

      if (loggedIn) {
        const finalUrl = this.page.url();
        log('SUCCESS', `Logged in! URL: ${finalUrl}`);
        return true;
      } else {
        log('ERROR', `Login timed out after 60s. Final URL: ${this.page.url()}`);
        return false;
      }
    } catch (error) {
      log('ERROR', `Login error: ${error.message}`);
      return false;
    }
  }

  async checkAvailability() {
    this.checkCount++;
    log('CHECK', `Check #${this.checkCount} — Loading booking page...`);

    try {
      await this.page.goto(CONFIG.bookingUrl, { 
        waitUntil: 'networkidle2', 
        timeout: 30000 
      });

      // Wait for page content
      await new Promise(r => setTimeout(r, 3000));

      const currentUrl = this.page.url();
      const pageText = await this.page.evaluate(() => document.body.innerText);
      const isLoggedIn = pageText.includes('Disconnetti') || pageText.includes('I miei appuntamenti');

      // If redirected to external login or bot detection page → session expired
      if (currentUrl.includes('iam.esteri.it') || currentUrl.includes('perfdrive.com')) {
        log('WARNING', 'Session expired — auto re-login...');
        const loggedIn = await this.login();
        if (loggedIn) {
          log('SUCCESS', 'Re-login successful! Retrying check...');
          return 'SESSION_REFRESHED';
        } else {
          log('ERROR', 'Auto re-login failed. Retrying in 2 minutes...');
          return 'ERROR';
        }
      }

      // If redirected to /Home but NOT logged in → need to re-login
      if (currentUrl.includes('/Home') && !isLoggedIn) {
        log('WARNING', 'Not logged in — auto re-login...');
        const loggedIn = await this.login();
        if (loggedIn) {
          log('SUCCESS', 'Re-login successful! Retrying check...');
          return 'SESSION_REFRESHED';
        } else {
          log('ERROR', 'Auto re-login failed.');
          return 'ERROR';
        }
      }

      // KEY DETECTION: The site REDIRECTS to /Services or /Home when no slots
      const redirectedToServicesList = currentUrl.endsWith('/Services') || currentUrl.endsWith('/Services/');
      const redirectedToHome = currentUrl.includes('/Home') && isLoggedIn;
      const hasNoSlotsMessage = pageText.includes(CONFIG.noSlotsMessage);

      if (redirectedToServicesList || redirectedToHome || hasNoSlotsMessage) {
        const reason = redirectedToServicesList ? 'Redirected to /Services' 
          : redirectedToHome ? 'Redirected to /Home (logged in)' 
          : 'No-slots message found';
        log('INFO', `No slots available (${reason}). Next check in ${CONFIG.checkInterval / 1000}s...`);
        this.consecutiveErrors = 0;
        return 'NO_SLOTS';
      }

      // If we're still on the Booking page → SLOTS MIGHT BE AVAILABLE!
      log('SUCCESS', '🚨🚨🚨 SLOTS POSSIBLY AVAILABLE! 🚨🚨🚨');
      log('INFO', `URL: ${currentUrl}`);
      log('INFO', `Page text: ${pageText.substring(0, 500)}`);

      const now = Date.now();
      if (now - this.lastNotificationTime > this.notificationCooldown) {
        const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
        const message = 
          `🚨 *PRENOTAMI ALERT* 🚨\n\n` +
          `Des créneaux LEGALIZZAZIONI sont disponibles!\n` +
          `Connectez-vous MAINTENANT:\n${CONFIG.bookingUrl}\n\n` +
          `⏰ ${timeStr}`;

        await notify(message);
        this.lastNotificationTime = now;
      } else {
        playAlarm();
      }

      this.consecutiveErrors = 0;
      return 'SLOTS_AVAILABLE';

    } catch (error) {
      this.consecutiveErrors++;
      log('ERROR', `Check failed (#${this.consecutiveErrors}): ${error.message}`);

      if (this.consecutiveErrors >= 5) {
        log('ERROR', 'Too many errors. Waiting 5 minutes...');
        await new Promise(r => setTimeout(r, 300000));
        this.consecutiveErrors = 0;
      }

      return 'ERROR';
    }
  }

  async run() {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
      log('WARNING', 'Telegram not configured. Only sound alarm will be used.');
    }

    log('INFO', '='.repeat(60));
    log('INFO', 'PRENOTAMI APPOINTMENT MONITOR v2');
    log('INFO', `Booking URL: ${CONFIG.bookingUrl}`);
    log('INFO', `Check interval: ${CONFIG.checkInterval / 1000} seconds`);
    log('INFO', `Notifications: ${CONFIG.telegramBotToken ? 'Telegram ✅' : 'Telegram ❌'} | Sound ✅`);
    log('INFO', `Auto-login: ${CONFIG.email ? '✅' : '❌'}`);
    log('INFO', '='.repeat(60));

    if (!CONFIG.email || !CONFIG.password) {
      log('ERROR', 'Missing PRENOTAMI_EMAIL or PRENOTAMI_PASSWORD in .env!');
      process.exit(1);
    }

    await this.init();

    // Auto-login on start (retry up to 3 times)
    let loggedIn = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      log('INFO', `Login attempt ${attempt}/3...`);
      loggedIn = await this.login();
      if (loggedIn) break;
      if (attempt < 3) {
        log('WARNING', `Login attempt ${attempt} failed, retrying in 30s...`);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
    if (!loggedIn) {
      log('ERROR', 'All 3 login attempts failed! Check your credentials.');
      log('ERROR', 'Waiting 5 minutes before retrying...');
      await new Promise(r => setTimeout(r, 300000));
      process.exit(1); // pm2 will restart the process
    }

    // Main monitoring loop
    while (true) {
      try {
        const result = await this.checkAvailability();

        // If session was refreshed, retry immediately
        if (result === 'SESSION_REFRESHED') {
          continue;
        }

        log('INFO', `Sleeping ${CONFIG.checkInterval / 1000}s...`);
        await new Promise(r => setTimeout(r, CONFIG.checkInterval));

      } catch (error) {
        log('ERROR', `Unexpected error: ${error.message}`);
        log('INFO', 'Waiting 60s before retry...');
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      log('INFO', 'Browser closed.');
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test-telegram')) {
    log('INFO', 'Sending test Telegram message...');
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
      log('ERROR', 'Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first!');
      process.exit(1);
    }
    try {
      await sendTelegram('✅ *Test from Prenotami Monitor*\nÇa marche! Les notifications Telegram sont configurées.');
      log('SUCCESS', 'Test message sent! Check your Telegram.');
    } catch (e) {
      log('ERROR', `Test failed: ${e.message}`);
    }
    process.exit(0);
  }

  if (args.includes('--test-sound')) {
    log('INFO', 'Testing sound alarm...');
    playAlarm();
    await new Promise(r => setTimeout(r, 12000));
    process.exit(0);
  }

  // Setup: open Chrome with separate profile for manual login
  if (args.includes('--setup')) {
    log('INFO', '='.repeat(60));
    log('INFO', 'SETUP MODE — Log in to prenotami.esteri.it');
    log('INFO', '='.repeat(60));
    const monitor = new PrenotamiMonitor();
    await monitor.init(false); // visible, on-screen
    log('INFO', 'Chrome opened! Now:');
    log('INFO', '  1. Go to https://prenotami.esteri.it');
    log('INFO', '  2. Log in with your account');
    log('INFO', '  3. Navigate to your booking page to verify');
    log('INFO', '  4. Close the Chrome window when done');
    log('INFO', 'Waiting for you to close Chrome...');
    await new Promise(resolve => monitor.browser.on('disconnected', resolve));
    log('SUCCESS', 'Setup complete! Now run: npm start');
    process.exit(0);
  }

  const monitor = new PrenotamiMonitor();

  process.on('SIGINT', async () => {
    log('INFO', '\nShutting down...');
    await monitor.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('INFO', '\nShutting down...');
    await monitor.cleanup();
    process.exit(0);
  });

  await monitor.run();
}

main().catch((err) => {
  log('ERROR', `Fatal error: ${err.message}`);
  process.exit(1);
});

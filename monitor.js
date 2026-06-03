/**
 * Prenotami Appointment Monitor v3 — Auto-Booking Edition
 * 
 * Monitors https://prenotami.esteri.it/Services/Booking/2359 for slots
 * and AUTOMATICALLY books the first available appointment.
 * 
 * Flow: detect slots → fill form → click AVANTI → handle calendar → 
 *       submit booking → notify user for OTP email verification
 * 
 * Usage:
 *   node monitor.js                  - Start monitoring + auto-booking
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
  checkInterval: parseInt(process.env.CHECK_INTERVAL_MS) || 90000,
  bookingUrl: process.env.BOOKING_URL || 'https://prenotami.esteri.it/Services/Booking/2359',
  serviceId: process.env.SERVICE_ID || '2359',
  loginUrl: 'https://prenotami.esteri.it/Home',
  noSlotsMessage: 'Sorry, all appointments for this service are currently booked',
  autoBook: (process.env.AUTO_BOOK || 'true').toLowerCase() === 'true',
  bookingNote: process.env.BOOKING_NOTE || '',
  // Waiting list: try these services to find an accessible form
  waitingListDonorServices: [1167, 2356, 2357, 2358, 5111],
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
// Telegram Photo (send screenshots)
// ============================================================================

function sendTelegramPhoto(imagePath, caption) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) {
      resolve(null);
      return;
    }
    try {
      const http = require('https');
      // Use multipart manually since form-data might not be installed
      const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
      const fileData = fs.readFileSync(imagePath);
      const fileName = path.basename(imagePath);
      
      let body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CONFIG.telegramChatId}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${(caption || '').substring(0, 1024)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`),
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${CONFIG.telegramBotToken}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            log('SUCCESS', 'Screenshot sent to Telegram!');
            resolve(data);
          } else {
            log('ERROR', `Telegram photo API returned ${res.statusCode}: ${data}`);
            reject(new Error(`Telegram photo error: ${res.statusCode}`));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    } catch (err) {
      log('ERROR', `sendTelegramPhoto failed: ${err.message}`);
      reject(err);
    }
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
      '--disable-infobars',
      '--lang=it-IT,it',
    ];
    if (offscreen) args.push('--window-position=-2000,-2000');

    this.browser = await puppeteer.launch({
      headless: false, // headful mode — use xvfb on VPS
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

  // Wait for PerfDrive challenge to auto-resolve (up to 60s)
  async waitForPerfDrive() {
    const url = this.page.url();
    if (!url.includes('perfdrive.com') && !url.includes('validate.')) return true;

    log('WARNING', '🛡️ PerfDrive challenge detected. Waiting for auto-resolve...');
    const deadline = Date.now() + 60000; // 60s max
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const currentUrl = this.page.url();
      if (!currentUrl.includes('perfdrive.com') && !currentUrl.includes('validate.')) {
        log('SUCCESS', '🛡️ PerfDrive challenge resolved!');
        await new Promise(r => setTimeout(r, 2000));
        return true;
      }
      log('INFO', `🛡️ Still on PerfDrive... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
    log('ERROR', '🛡️ PerfDrive challenge did NOT resolve in 60s.');
    return false;
  }

  async login() {
    log('INFO', 'Auto-login: navigating to prenotami...');
    try {
      await this.page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      const url = this.page.url();

      // Handle PerfDrive if detected
      if (this.page.url().includes('perfdrive.com') || this.page.url().includes('validate.')) {
        const resolved = await this.waitForPerfDrive();
        if (resolved) {
          // Check if we landed on prenotami after PerfDrive
          const urlAfter = this.page.url();
          const loggedInAfter = await this.page.evaluate(() =>
            document.body.innerText.includes('Disconnetti') || document.body.innerText.includes('I miei appuntamenti')
          );
          if (loggedInAfter) {
            log('SUCCESS', 'Logged in after PerfDrive resolve!');
            return true;
          }
          // Navigate again after PerfDrive resolves
          await this.page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2000));
        } else {
          log('ERROR', 'PerfDrive did not resolve. Will retry later.');
          return false;
        }
      }

      // Check if actually logged in
      const isLoggedIn = await this.page.evaluate(() => {
        const text = document.body.innerText;
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
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          // PerfDrive might trigger again after clicking login
          if (this.page.url().includes('perfdrive.com') || this.page.url().includes('validate.')) {
            const resolved2 = await this.waitForPerfDrive();
            if (!resolved2) return false;
          }
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

  // ========================================================================
  // AUTO-BOOKING: Attempt to book the first available slot
  // ========================================================================

  async takeScreenshot(label) {
    try {
      const screenshotDir = path.join(__dirname, 'screenshots');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const filename = `${label}-${Date.now()}.png`;
      const filepath = path.join(screenshotDir, filename);
      await this.page.screenshot({ path: filepath, fullPage: true });
      log('INFO', `📸 Screenshot saved: ${filename}`);
      // Send to Telegram
      try {
        await sendTelegramPhoto(filepath, `📸 ${label}`);
      } catch (e) {
        log('WARNING', `Failed to send screenshot to Telegram: ${e.message}`);
      }
      return filepath;
    } catch (e) {
      log('ERROR', `Screenshot failed: ${e.message}`);
      return null;
    }
  }

  async autoBook() {
    log('SUCCESS', '🤖 AUTO-BOOKING: Starting automatic booking process...');
    
    try {
      // Step 0: Screenshot the booking page as we found it
      await this.takeScreenshot('01-slots-detected');
      const pageText = await this.page.evaluate(() => document.body.innerText);
      const pageHtml = await this.page.evaluate(() => document.body.innerHTML);
      log('INFO', `[AUTOBOOK] Page text (500 chars): ${pageText.substring(0, 500)}`);

      // Step 1: Check if there's a booking form (#bookingForm)
      const hasBookingForm = await this.page.evaluate(() => !!document.getElementById('bookingForm'));
      if (!hasBookingForm) {
        log('WARNING', '[AUTOBOOK] No #bookingForm found on page. Taking screenshot and notifying...');
        await this.takeScreenshot('02-no-form');
        return false;
      }
      log('INFO', '[AUTOBOOK] Found #bookingForm!');

      // Step 2: Handle "Tipo Prenotazione" dropdown if present
      const hasTypeDropdown = await this.page.evaluate(() => {
        const ddl = document.getElementById('typeofbookingddl');
        if (!ddl) return false;
        // Select the first non-zero option
        for (let i = 0; i < ddl.options.length; i++) {
          if (ddl.options[i].value !== '0' && ddl.options[i].value !== '') {
            ddl.selectedIndex = i;
            ddl.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      if (hasTypeDropdown) {
        log('INFO', '[AUTOBOOK] Selected booking type from dropdown.');
        await new Promise(r => setTimeout(r, 1000));
      }

      // Step 3: Fill any required text fields (DatiAddizionali)
      const filledFields = await this.page.evaluate((bookingNote) => {
        const filled = [];
        // Fill text inputs that are required and empty
        document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="text"]').forEach(input => {
          if (!input.value && input.offsetParent !== null) {
            // Use booking note or a placeholder
            input.value = bookingNote || 'N/A';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(input.name);
          }
        });
        // Fill date inputs that are empty with a future date
        document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="date"]').forEach(input => {
          if (!input.value && input.offsetParent !== null) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            input.value = future.toISOString().split('T')[0];
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(input.name);
          }
        });
        // Handle select dropdowns (pick first non-zero option)
        document.querySelectorAll('select[id*="ddls_"]').forEach(sel => {
          if (sel.selectedIndex === 0 && sel.offsetParent !== null) {
            for (let i = 1; i < sel.options.length; i++) {
              if (sel.options[i].value !== '0') {
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                filled.push(sel.id);
                break;
              }
            }
          }
        });
        return filled;
      }, CONFIG.bookingNote);
      if (filledFields.length > 0) {
        log('INFO', `[AUTOBOOK] Filled ${filledFields.length} form fields: ${filledFields.join(', ')}`);
      }

      await this.takeScreenshot('02-form-filled');
      await new Promise(r => setTimeout(r, 1000));

      // Step 4: Override window.confirm to auto-accept
      await this.page.evaluate(() => {
        window.confirm = () => true;
      });
      log('INFO', '[AUTOBOOK] Overrode window.confirm() to auto-accept.');

      // Step 5: Click AVANTI button
      const hasAvanti = await this.page.evaluate(() => !!document.getElementById('btnAvanti'));
      if (hasAvanti) {
        log('INFO', '[AUTOBOOK] Clicking AVANTI...');
        
        // Listen for form submission or navigation
        const navigationPromise = this.page.waitForNavigation({ 
          waitUntil: 'networkidle2', 
          timeout: 30000 
        }).catch(() => null);

        await this.page.click('#btnAvanti');
        await new Promise(r => setTimeout(r, 3000));
        
        // Wait for potential navigation from form submit
        await navigationPromise;
        await new Promise(r => setTimeout(r, 3000));
        
        await this.takeScreenshot('03-after-avanti');
        log('INFO', `[AUTOBOOK] After AVANTI, URL: ${this.page.url()}`);
      } else {
        log('WARNING', '[AUTOBOOK] No #btnAvanti found, looking for other submit buttons...');
        // Try clicking any visible submit/book button
        const clicked = await this.page.evaluate(() => {
          const btns = document.querySelectorAll('button[type="submit"], input[type="submit"], .btn-primary');
          for (const btn of btns) {
            if (btn.offsetParent !== null && btn.innerText && !btn.innerText.includes('Disconnetti')) {
              btn.click();
              return btn.innerText.trim();
            }
          }
          return null;
        });
        if (clicked) {
          log('INFO', `[AUTOBOOK] Clicked button: "${clicked}"`);
          await new Promise(r => setTimeout(r, 5000));
          await this.takeScreenshot('03-after-submit');
        }
      }

      // Step 6: Handle calendar if present (select first available green date)
      await new Promise(r => setTimeout(r, 2000));
      const calendarResult = await this.page.evaluate(() => {
        // Look for calendar day cells
        const days = document.querySelectorAll('td.day:not(.disabled):not(.old):not(.new), .ui-datepicker td a, .calendar-day.available, td[data-date]');
        for (const day of days) {
          const style = window.getComputedStyle(day);
          // Click first non-disabled, visible day
          if (day.offsetParent !== null && !day.classList.contains('disabled')) {
            day.click();
            return { clicked: true, text: day.innerText.trim(), class: day.className };
          }
        }
        // Also try any green-colored elements
        const greenEls = document.querySelectorAll('[style*="green"], .bg-success, .available');
        for (const el of greenEls) {
          if (el.offsetParent !== null) {
            el.click();
            return { clicked: true, text: el.innerText.trim(), class: el.className, type: 'green' };
          }
        }
        return { clicked: false };
      });
      
      if (calendarResult.clicked) {
        log('SUCCESS', `[AUTOBOOK] Selected date: ${calendarResult.text} (${calendarResult.class})`);
        await new Promise(r => setTimeout(r, 2000));
        await this.takeScreenshot('04-date-selected');
        
        // Try to select a time slot if time picker appears
        await new Promise(r => setTimeout(r, 2000));
        const timeResult = await this.page.evaluate(() => {
          const timeSlots = document.querySelectorAll('.time-slot, select[id*="time"] option, input[type="radio"][name*="time"], .slot-available');
          for (const slot of timeSlots) {
            if (slot.offsetParent !== null && !slot.disabled) {
              slot.click();
              return { selected: true, text: slot.innerText || slot.value };
            }
          }
          // Try select dropdown for time
          const timeSelect = document.querySelector('select[id*="ora"], select[id*="time"], select[id*="Time"]');
          if (timeSelect && timeSelect.options.length > 1) {
            timeSelect.selectedIndex = 1;
            timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: true, text: timeSelect.options[1].text };
          }
          return { selected: false };
        });
        if (timeResult.selected) {
          log('SUCCESS', `[AUTOBOOK] Selected time: ${timeResult.text}`);
        }
        
        // Click confirm/prenota after date+time selection
        await new Promise(r => setTimeout(r, 1000));
        const confirmResult = await this.page.evaluate(() => {
          window.confirm = () => true;
          const btns = document.querySelectorAll('#btnAvanti, #btnPrenota, button[type="submit"], .btn-primary');
          for (const btn of btns) {
            if (btn.offsetParent !== null && !btn.innerText.includes('Disconnetti') && !btn.innerText.includes('TORNA')) {
              btn.click();
              return btn.innerText.trim();
            }
          }
          return null;
        });
        if (confirmResult) {
          log('INFO', `[AUTOBOOK] Clicked confirm: "${confirmResult}"`);
          try {
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
          } catch(e) {}
          await new Promise(r => setTimeout(r, 3000));
          await this.takeScreenshot('05-after-confirm');
        }
      }

      // Step 7: Check for OTP popup/form
      const currentText = await this.page.evaluate(() => document.body.innerText);
      const currentHtml = await this.page.evaluate(() => document.body.innerHTML);
      const hasOtp = currentHtml.includes('OTP') || currentHtml.includes('otp') || currentHtml.includes('GenerateOTP');
      const hasOtpInput = await this.page.evaluate(() => {
        return !!document.querySelector('input[id*="otp"], input[id*="OTP"], input[name*="otp"], input[name*="OTP"]');
      });

      if (hasOtp || hasOtpInput) {
        log('SUCCESS', '🔐 [AUTOBOOK] OTP step detected! Sending OTP request...');
        
        // Try to click the "Send OTP" button
        const otpSent = await this.page.evaluate(() => {
          const btn = document.getElementById('otp-send');
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (otpSent) {
          log('SUCCESS', '[AUTOBOOK] OTP send button clicked!');
        }
        
        await new Promise(r => setTimeout(r, 3000));
        await this.takeScreenshot('06-otp-step');
        
        // Notify user to check email for OTP
        const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
        await sendTelegram(
          `🔐 *OTP REQUIS!* 🔐\n\n` +
          `Le bot a réservé un créneau!\n` +
          `Un code OTP a été envoyé à votre email.\n\n` +
          `⚠️ Vérifiez votre email MAINTENANT et entrez le code OTP sur le site.\n\n` +
          `⏰ ${timeStr}`
        );
        
        // Wait for user to enter OTP (poll for 5 minutes)
        log('INFO', '[AUTOBOOK] Waiting for OTP to be entered (5 min timeout)...');
        const otpDeadline = Date.now() + 300000; // 5 minutes
        while (Date.now() < otpDeadline) {
          await new Promise(r => setTimeout(r, 10000)); // Check every 10s
          const url = this.page.url();
          const text = await this.page.evaluate(() => document.body.innerText);
          if (text.includes('I miei appuntamenti') || url.includes('/Reservation')) {
            log('SUCCESS', '🎉🎉🎉 BOOKING CONFIRMED! 🎉🎉🎉');
            await this.takeScreenshot('07-booking-confirmed');
            await sendTelegram('🎉 *RENDEZ-VOUS CONFIRMÉ!* 🎉\n\nLe créneau a été réservé avec succès!');
            return true;
          }
        }
        log('WARNING', '[AUTOBOOK] OTP timeout after 5 minutes.');
        return false;
      }

      // Step 8: Check if booking was successful (no OTP step)
      const finalUrl = this.page.url();
      const finalText = await this.page.evaluate(() => document.body.innerText);
      await this.takeScreenshot('07-final-state');
      
      if (finalText.includes('I miei appuntamenti') || finalUrl.includes('/Reservation') || finalText.includes('Conferma')) {
        log('SUCCESS', '🎉🎉🎉 BOOKING APPEARS SUCCESSFUL! 🎉🎉🎉');
        const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
        await sendTelegram(
          `🎉 *RENDEZ-VOUS RÉSERVÉ!* 🎉\n\n` +
          `Le bot a automatiquement réservé un créneau!\n` +
          `Vérifiez sur: https://prenotami.esteri.it/Reservation\n\n` +
          `⏰ ${timeStr}`
        );
        return true;
      }

      log('INFO', `[AUTOBOOK] Final URL: ${finalUrl}`);
      log('INFO', `[AUTOBOOK] Final page text: ${finalText.substring(0, 500)}`);
      return false;

    } catch (error) {
      log('ERROR', `[AUTOBOOK] Error: ${error.message}`);
      await this.takeScreenshot('error-autobook');
      return false;
    }
  }

  // ========================================================================
  // WAITING LIST: Join the waiting list by fetching the real form for 2359
  // ========================================================================

  async joinWaitingList() {
    log('INFO', '📋 WAITING LIST: Attempting to join the waiting list for service ' + CONFIG.serviceId + '...');

    try {
      // Step 1: Ensure we're on prenotami (for cookies)
      await this.page.goto('https://prenotami.esteri.it/Services', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await new Promise(r => setTimeout(r, 2000));

      // Step 2: Fetch the booking page HTML directly via XHR (shares cookies, doesn't redirect the browser)
      log('INFO', '[WL] Fetching booking form HTML for service ' + CONFIG.serviceId + '...');
      const formHtml = await this.page.evaluate(async (serviceId) => {
        return new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', `/Services/Booking/${serviceId}`, true);
          xhr.onload = function () {
            resolve({ status: xhr.status, html: xhr.responseText, url: xhr.responseURL });
          };
          xhr.onerror = function () {
            resolve({ status: 0, html: null, url: null, error: 'XHR error' });
          };
          xhr.send();
        });
      }, CONFIG.serviceId);

      log('INFO', `[WL] XHR response: status=${formHtml.status}, url=${(formHtml.url || '').substring(0, 80)}, htmlLength=${(formHtml.html || '').length}`);

      // Check if we got the actual booking form or a redirect/error page
      const hasBookingForm = formHtml.html && formHtml.html.includes('bookingForm');
      const hasWaitingList = formHtml.html && formHtml.html.includes('isWaitingListEnabled');
      const isErrorPage = formHtml.html && (formHtml.html.includes('Si è verificato un errore') || formHtml.url?.includes('/Error'));

      if (isErrorPage) {
        log('ERROR', '[WL] Server returned an error page.');
        return false;
      }

      if (!formHtml.html || formHtml.html.length < 500) {
        log('ERROR', '[WL] Got empty or very short response. Service may not be accessible.');
        return false;
      }

      if (!hasBookingForm) {
        // The XHR followed the redirect — we got the redirected page, not the form
        log('WARNING', `[WL] No booking form found in response. Page may have redirected.`);
        log('INFO', `[WL] Response URL: ${formHtml.url}`);
        
        // Try direct POST with minimal data
        log('INFO', '[WL] Attempting direct POST to booking endpoint...');
        const postResult = await this.page.evaluate(async (serviceId, note) => {
          return new Promise((resolve) => {
            const formData = new FormData();
            formData.append('IDServizioErogato', serviceId);
            formData.append('isWaitingListEnabled', 'True');
            formData.append('MessaggioRassicuranteWaitingList', 'True');
            formData.append('PrivacyCheck', 'true');
            formData.append('BookingNotes', note || '');
            formData.append('IdTipoPrenotazione', '1');
            formData.append('NumAccompagnatoriSelected', '0');
            formData.append('NumMaxAccompagnatori', '0');

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/Services/Booking/${serviceId}`, true);
            xhr.onload = function () {
              resolve({ status: xhr.status, text: xhr.responseText.substring(0, 2000), url: xhr.responseURL });
            };
            xhr.onerror = function () {
              resolve({ status: 0, text: 'XHR POST error', url: null });
            };
            xhr.send(formData);
          });
        }, CONFIG.serviceId, CONFIG.bookingNote);

        log('INFO', `[WL] POST response: status=${postResult.status}, url=${(postResult.url || '').substring(0, 80)}`);
        log('INFO', `[WL] POST response text (500 chars): ${(postResult.text || '').substring(0, 500)}`);

        if (postResult.text?.includes('OTP') || postResult.text?.includes('otp')) {
          log('SUCCESS', '🔐 [WL] POST triggered OTP step!');
          // Navigate to the current state
          await this.page.goto(postResult.url || `https://prenotami.esteri.it/Services/Booking/${CONFIG.serviceId}`, {
            waitUntil: 'networkidle2', timeout: 15000
          }).catch(() => {});
          // OTP handling logic is lower down, this is just to get to the page
        } else if (postResult.text?.includes('lista di attesa') || postResult.text?.includes('waiting')) {
          log('SUCCESS', '🎉 [WL] Direct POST worked! On waiting list!');
          await sendTelegram('🎉 *LISTE D\'ATTENTE CONFIRMÉE!* 🎉\n\nInscrit sur la liste d\'attente pour Legalizzazioni!');
          return true;
        } else if (postResult.status === 200 && !postResult.text?.includes('Errore') && !postResult.text?.includes('error')) {
          log('INFO', '[WL] POST returned 200. Checking result...');
          await this.takeScreenshot('wl-post-result');
        } else {
          log('WARNING', `[WL] POST didn't succeed clearly. Status: ${postResult.status}`);
          await this.takeScreenshot('wl-post-unclear');
        }
        return false;
      }

      // Step 3: We got the booking form! Inject it into the current page
      log('SUCCESS', '[WL] Got the booking form for service ' + CONFIG.serviceId + '!');
      log('INFO', `[WL] Waiting list enabled: ${hasWaitingList}`);

      // Replace current page content with the form
      await this.page.evaluate((html) => {
        document.open();
        document.write(html);
        document.close();
      }, formHtml.html);
      await new Promise(r => setTimeout(r, 3000));

      await this.takeScreenshot('wl-01-real-form');

      // Step 4: Select booking type (first non-zero option)
      await this.page.evaluate(() => {
        const ddl = document.getElementById('typeofbookingddl');
        if (ddl) {
          for (let i = 0; i < ddl.options.length; i++) {
            if (ddl.options[i].value !== '0' && ddl.options[i].value !== '') {
              ddl.selectedIndex = i;
              ddl.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
      });
      await new Promise(r => setTimeout(r, 1000));

      // Step 5: Fill required additional data fields
      const filledFields = await this.page.evaluate((note) => {
        const filled = [];
        document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="text"]').forEach(input => {
          if (!input.value && input.offsetParent !== null) {
            input.value = note || 'N/A';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(input.name || input.id);
          }
        });
        document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="date"]').forEach(input => {
          if (!input.value && input.offsetParent !== null) {
            const future = new Date();
            future.setFullYear(future.getFullYear() + 2);
            input.value = future.toISOString().split('T')[0];
            input.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(input.name || input.id);
          }
        });
        document.querySelectorAll('select[id*="ddls_"]').forEach(sel => {
          if (sel.selectedIndex === 0 && sel.offsetParent !== null) {
            for (let i = 1; i < sel.options.length; i++) {
              if (sel.options[i].value !== '0') {
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                filled.push(sel.id);
                break;
              }
            }
          }
        });
        return filled;
      }, CONFIG.bookingNote);
      log('INFO', `[WL] Filled ${filledFields.length} fields: ${filledFields.join(', ')}`);

      // Step 6: Fill notes
      await this.page.evaluate((note) => {
        const textarea = document.getElementById('BookingNotes');
        if (textarea) textarea.value = note || '';
      }, CONFIG.bookingNote);

      // Step 7: Check privacy
      await this.page.evaluate(() => {
        const cb = document.getElementById('PrivacyCheck');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      await this.takeScreenshot('wl-02-form-filled');
      log('SUCCESS', '[WL] Form filled and privacy accepted.');

      // Step 8: Override confirm and click AVANTI
      await this.page.evaluate(() => { window.confirm = () => true; });

      const hasAvanti = await this.page.evaluate(() => !!document.getElementById('btnAvanti'));
      if (!hasAvanti) {
        log('ERROR', '[WL] No #btnAvanti found!');
        return false;
      }

      log('INFO', '[WL] Clicking AVANTI...');
      const navPromise = this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
      await this.page.click('#btnAvanti');
      await new Promise(r => setTimeout(r, 3000));
      await navPromise;
      await new Promise(r => setTimeout(r, 3000));

      await this.takeScreenshot('wl-03-after-submit');
      const afterUrl = this.page.url();
      const afterText = await this.page.evaluate(() => document.body.innerText);
      log('INFO', `[WL] After submit URL: ${afterUrl}`);
      log('INFO', `[WL] After submit text (500 chars): ${afterText.substring(0, 500)}`);

      // Check for error
      if (afterUrl.includes('/Error') || afterText.includes('Si è verificato un errore')) {
        log('ERROR', '[WL] Server returned an error page after form submit.');
        log('ERROR', `[WL] Error text: ${afterText.substring(0, 300)}`);
        return false;
      }

      // Step 9: Handle OTP
      const hasOtpSection = afterText.includes('OTP') || 
        await this.page.evaluate(() => document.body.innerHTML.includes('otp-send') || document.body.innerHTML.includes('GenerateOTP'));

      if (hasOtpSection) {
        log('SUCCESS', '🔐 [WL] OTP step detected!');
        const otpClicked = await this.page.evaluate(() => {
          const btn = document.getElementById('otp-send');
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (otpClicked) log('SUCCESS', '[WL] OTP send button clicked!');

        await new Promise(r => setTimeout(r, 3000));
        await this.takeScreenshot('wl-04-otp');

        const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
        await sendTelegram(
          `📋🔐 *LISTE D'ATTENTE - OTP REQUIS!* 🔐\n\n` +
          `Le bot s'inscrit à la liste d'attente!\n` +
          `Un code OTP a été envoyé à votre email.\n\n` +
          `⚠️ Vérifiez votre email MAINTENANT!\n\n⏰ ${timeStr}`
        );
        await notify('📋 OTP requis! Vérifiez votre email!');

        const otpDeadline = Date.now() + 300000;
        while (Date.now() < otpDeadline) {
          await new Promise(r => setTimeout(r, 10000));
          const text = await this.page.evaluate(() => document.body.innerText);
          const url = this.page.url();
          if (url.includes('/Reservation') || text.includes('lista di attesa') || 
              text.includes('Conferma') || text.includes('confermato') || text.includes('I miei appuntamenti')) {
            log('SUCCESS', '🎉 [WL] Waiting list registration confirmed!');
            await this.takeScreenshot('wl-05-success');
            await sendTelegram('🎉 *LISTE D\'ATTENTE CONFIRMÉE!* 🎉');
            return true;
          }
        }
        log('WARNING', '[WL] OTP timeout after 5 minutes.');
        return false;
      }

      // Step 10: Check final result
      if (afterUrl.includes('/Reservation') || afterText.includes('lista di attesa') ||
          afterText.includes('confermato') || afterText.includes('I miei appuntamenti')) {
        log('SUCCESS', '🎉 [WL] Registration successful!');
        await sendTelegram('🎉 *LISTE D\'ATTENTE CONFIRMÉE!* 🎉');
        return true;
      }

      log('WARNING', '[WL] Unclear result. Check screenshots.');
      log('INFO', `[WL] Final text: ${afterText.substring(0, 500)}`);
      return false;

    } catch (error) {
      log('ERROR', `[WL] Error: ${error.message}`);
      await this.takeScreenshot('wl-error');
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

      // PerfDrive bot detection — wait and retry
      if (currentUrl.includes('perfdrive.com') || currentUrl.includes('validate.')) {
        log('WARNING', '🛡️ PerfDrive bot detection triggered! Waiting 5 minutes...');
        await sendTelegram('⚠️ PerfDrive anti-bot déclenché. Pause de 5 min...');
        // Delete cookies to reset detection
        const cookies = await this.page.cookies();
        if (cookies.length > 0) await this.page.deleteCookie(...cookies);
        await new Promise(r => setTimeout(r, 300000)); // 5 min cooldown
        // Re-login after cooldown
        await this.login();
        return 'SESSION_REFRESHED';
      }

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

      // Always notify
      const now = Date.now();
      const timeStr = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Algiers' });
      if (now - this.lastNotificationTime > this.notificationCooldown) {
        const message = 
          `🚨 *PRENOTAMI ALERT* 🚨\n\n` +
          `Des créneaux LEGALIZZAZIONI sont disponibles!\n` +
          `${CONFIG.autoBook ? '🤖 Auto-booking en cours...' : 'Connectez-vous MAINTENANT:'}\n${CONFIG.bookingUrl}\n\n` +
          `⏰ ${timeStr}`;
        await notify(message);
        this.lastNotificationTime = now;
      }

      // AUTO-BOOK if enabled
      if (CONFIG.autoBook) {
        const booked = await this.autoBook();
        if (booked) {
          log('SUCCESS', '🎉 Auto-booking successful! Pausing monitoring for 1 hour...');
          await new Promise(r => setTimeout(r, 3600000)); // pause 1h after successful booking
          this.consecutiveErrors = 0;
          return 'BOOKED';
        } else {
          log('WARNING', 'Auto-booking failed. Will notify and continue monitoring...');
          await sendTelegram(`⚠️ Auto-booking a échoué!\nVérifiez manuellement: ${CONFIG.bookingUrl}`);
        }
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
    log('INFO', 'PRENOTAMI APPOINTMENT MONITOR v3 — AUTO-BOOKING');
    log('INFO', `Booking URL: ${CONFIG.bookingUrl}`);
    log('INFO', `Auto-booking: ${CONFIG.autoBook ? '✅ ENABLED' : '❌ DISABLED'}`);
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

  // Waiting List: try to join the waiting list directly
  if (args.includes('--waiting-list')) {
    log('INFO', '='.repeat(60));
    log('INFO', '📋 WAITING LIST MODE');
    log('INFO', `Target service: ${CONFIG.serviceId}`);
    log('INFO', '='.repeat(60));

    if (!CONFIG.email || !CONFIG.password) {
      log('ERROR', 'Missing PRENOTAMI_EMAIL or PRENOTAMI_PASSWORD in .env!');
      process.exit(1);
    }

    const monitor = new PrenotamiMonitor();
    await monitor.init();

    // Login first
    let loggedIn = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      log('INFO', `Login attempt ${attempt}/3...`);
      loggedIn = await monitor.login();
      if (loggedIn) break;
      if (attempt < 3) await new Promise(r => setTimeout(r, 15000));
    }
    if (!loggedIn) {
      log('ERROR', 'Login failed!');
      process.exit(1);
    }

    // Try to join waiting list
    const success = await monitor.joinWaitingList();
    if (success) {
      log('SUCCESS', '🎉 Successfully joined the waiting list!');
    } else {
      log('ERROR', 'Failed to join waiting list. Check screenshots for details.');
    }

    await monitor.cleanup();
    process.exit(success ? 0 : 1);
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

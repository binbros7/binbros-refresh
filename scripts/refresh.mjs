/*
 * Bin Bros dashboard refresh — driver script.
 *
 * Runs inside GitHub Actions. Drives a headless Chromium via Playwright:
 *   1.  Logs into the Bin Bros admin
 *   2.  Scrapes the clients / invoices / payments tables
 *   3.  Walks each client profile + contacts page (estate, bins, address,
 *       street, phones)
 *   4.  (Optional) Logs into AddPay and scrapes the transactions list for
 *       reconciliation
 *   5.  Calls refresh.js's binbrosDeploy() inside the browser to build,
 *       encrypt, and redeploy both Netlify sites
 *
 * The actual scrape + build + encrypt + deploy logic lives in refresh.js
 * (already hosted at https://binbrosdashboard.netlify.app/refresh.js — the
 * existing browser-based pipeline). We fetch it at runtime so any future
 * tweaks to refresh.js take effect on the next cron without redeploying
 * this repo.
 *
 * Environment (set via GitHub repo secrets):
 *   BINBROS_EMAIL, BINBROS_PASSWORD      — required
 *   DASHBOARD_PASSWORD                   — required (decrypts/encrypts dashboards, currently "Bin#Bro#123")
 *   NETLIFY_TOKEN                        — required (Netlify PAT, "nfp_…")
 *   ADDPAY_EMAIL, ADDPAY_PASSWORD        — optional (skip AddPay if absent)
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BB = 'https://binbros.jnzsoftware.co.za';
const REFRESH_JS_URL = 'https://binbrosdashboard.netlify.app/refresh.js';

const env = {
  BINBROS_EMAIL: process.env.BINBROS_EMAIL,
  BINBROS_PASSWORD: process.env.BINBROS_PASSWORD,
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
  NETLIFY_TOKEN: process.env.NETLIFY_TOKEN,
  ADDPAY_EMAIL: process.env.ADDPAY_EMAIL || '',
  ADDPAY_PASSWORD: process.env.ADDPAY_PASSWORD || '',
};

for (const k of ['BINBROS_EMAIL', 'BINBROS_PASSWORD', 'DASHBOARD_PASSWORD', 'NETLIFY_TOKEN']) {
  if (!env[k]) { console.error(`Missing required secret: ${k}`); process.exit(2); }
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function fetchRefreshJs() {
  const res = await fetch(REFRESH_JS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`refresh.js fetch HTTP ${res.status}`);
  const txt = await res.text();
  if (txt.length < 5000) throw new Error(`refresh.js too small (${txt.length} bytes) — fetch likely failed`);
  log(`Fetched refresh.js (${txt.length} bytes)`);
  return txt;
}

async function loginBinBros(page) {
  log('Navigating to Bin Bros login');
  await page.goto(BB + '/admin/authentication', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[name="email"]', env.BINBROS_EMAIL);
  await page.fill('input[name="password"]', env.BINBROS_PASSWORD);
  // The "remember me" checkbox keeps the session sticky for longer
  const rem = page.locator('input[name="remember"]');
  if (await rem.count() > 0) await rem.check().catch(() => {});
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);
  // After login we should be on /admin/clients (or similar). If still on /authentication, creds are wrong.
  const url = page.url();
  if (url.includes('/authentication')) {
    throw new Error('Bin Bros login rejected (still on /authentication — check secrets)');
  }
  log(`Bin Bros login OK (landed on ${url})`);
}

async function navAndWaitForTable(page, path) {
  await page.goto(BB + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait until at least one row appears in any DataTable on the page
  await page.waitForFunction(() => {
    if (typeof window.jQuery === 'undefined') return false;
    const t = window.jQuery('.dataTable');
    return t.length > 0 && t.find('tbody tr').length > 0;
  }, null, { timeout: 30000 });
}

async function injectRefreshJs(page, refreshJsContent) {
  // After every navigation, the previously-injected script is gone; re-inject.
  await page.addScriptTag({ content: refreshJsContent });
  // Verify the entry points are now on window
  const ok = await page.evaluate(() => typeof window.binbrosRefresh === 'function');
  if (!ok) throw new Error('refresh.js did not register window.binbrosRefresh');
}

async function runStage(page, refreshJs) {
  // Invokes window.binbrosRefresh() which inspects location.pathname/host and runs the right stage
  return await page.evaluate(async () => await window.binbrosRefresh());
}

async function scrapeAddPay(ctx, refreshJs) {
  log('Opening AddPay tab');
  const page = await ctx.newPage();
  try {
    await page.goto('https://admin.addpay.cloud/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // AddPay's login form is SPA-rendered with no `name` attributes; find the visible
    // password input first, then locate its sibling email/text field within the same form.
    await page.waitForSelector('input[type="password"]', { timeout: 25000 });
    const filled = await page.evaluate(async ({ email, password }) => {
      function isVisible(el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      }
      function fire(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }
      const pwInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
      if (!pwInputs.length) return { ok: false, reason: 'no visible password input' };
      const pwEl = pwInputs[0];
      const form = pwEl.closest('form') || document;
      const emailCandidates = Array.from(form.querySelectorAll('input')).filter(i =>
        i !== pwEl && isVisible(i) &&
        (i.type === 'email' || i.type === 'text' || (i.type || '') === '')
      );
      if (!emailCandidates.length) return { ok: false, reason: 'no email-like input in same form' };
      const emailEl = emailCandidates[0];
      emailEl.focus(); emailEl.value = email; fire(emailEl);
      pwEl.focus(); pwEl.value = password; fire(pwEl);
      const submit = form.querySelector('button[type="submit"], input[type="submit"]')
        || Array.from(form.querySelectorAll('button')).find(b => /sign\s*in|log\s*in|login/i.test(b.textContent || ''));
      if (submit) submit.click();
      else if (form.requestSubmit) form.requestSubmit();
      else form.submit && form.submit();
      return { ok: true };
    }, { email: env.ADDPAY_EMAIL, password: env.ADDPAY_PASSWORD });
    if (!filled.ok) throw new Error('AddPay login fill failed: ' + filled.reason);
    await page.waitForURL(/\/manage/, { timeout: 30000 });
    log(`AddPay login OK (landed on ${page.url()})`);
    await page.goto('https://admin.addpay.cloud/manage/transactions', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 30000 });
    await page.waitForTimeout(2000); // let the SPA render fully
    await injectRefreshJs(page, refreshJs);
    const result = await page.evaluate(async () => await window.binbrosRefresh());
    log(`AddPay scrape: ${JSON.stringify(result)}`);
    const txns = JSON.parse(await page.evaluate(() => sessionStorage.getItem('bb_addpay') || '[]'));
    log(`AddPay txns count: ${txns.length}`);
    return txns;
  } catch (e) {
    log(`AddPay scrape FAILED (continuing without reconciliation): ${e.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const summary = { startedAt: new Date().toISOString() };
  let browser;
  try {
    const refreshJs = await fetchRefreshJs();
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({
      userAgent: 'BinBros-Refresh/1.0 (+github actions)',
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();

    // 1. Bin Bros login
    await loginBinBros(page);

    // 2. Scrape clients
    log('Scraping clients table');
    await navAndWaitForTable(page, '/admin/clients');
    await injectRefreshJs(page, refreshJs);
    summary.clients = await runStage(page, refreshJs);
    log(`Clients: ${JSON.stringify(summary.clients)}`);

    // 3. Scrape profiles + contacts (run from a contacts page so the CSRF token + AJAX wiring is available)
    log('Scraping profiles + contacts');
    const firstId = await page.evaluate(() => {
      const arr = JSON.parse(sessionStorage.getItem('bb_clients') || '[]');
      return arr[0]?.id;
    });
    if (!firstId) throw new Error('no client IDs in sessionStorage after scrapeClients');
    await page.goto(`${BB}/admin/clients/client/${firstId}?group=contacts`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof window.jQuery !== 'undefined' && window.jQuery('table.dataTable').length > 0, null, { timeout: 30000 });
    await injectRefreshJs(page, refreshJs);
    summary.profiles = await runStage(page, refreshJs);
    log(`Profiles: ${JSON.stringify(summary.profiles)}`);

    // 4. Scrape invoices
    log('Scraping invoices');
    await navAndWaitForTable(page, '/admin/invoices');
    await injectRefreshJs(page, refreshJs);
    summary.invoices = await runStage(page, refreshJs);
    log(`Invoices: ${JSON.stringify(summary.invoices)}`);

    // 5. Scrape payments
    log('Scraping payments');
    await navAndWaitForTable(page, '/admin/payments');
    await injectRefreshJs(page, refreshJs);
    summary.payments = await runStage(page, refreshJs);
    log(`Payments: ${JSON.stringify(summary.payments)}`);

    // 6. (Optional) AddPay
    let addpay = [];
    if (env.ADDPAY_EMAIL && env.ADDPAY_PASSWORD) {
      addpay = await scrapeAddPay(ctx, refreshJs);
    } else {
      log('ADDPAY_EMAIL / ADDPAY_PASSWORD not set — skipping AddPay reconciliation');
    }
    summary.addpayTxns = addpay.length;

    // 7. Build + encrypt + deploy (back on the Bin Bros tab so sessionStorage has all scraped data)
    log('Deploying to Netlify');
    await navAndWaitForTable(page, '/admin/clients');
    await injectRefreshJs(page, refreshJs);
    summary.deploy = await page.evaluate(async ({ token, pw, addpay }) => {
      return await window.binbrosDeploy({ netlifyToken: token, password: pw, addpay });
    }, { token: env.NETLIFY_TOKEN, pw: env.DASHBOARD_PASSWORD, addpay });
    log(`Deploy: ${JSON.stringify({ mdb: summary.deploy.mdb?.state, odb: summary.deploy.odb?.state, totals: summary.deploy.totals })}`);

    summary.endedAt = new Date().toISOString();
    summary.ok = true;
  } catch (e) {
    summary.ok = false;
    summary.error = e.message;
    summary.stack = e.stack;
    console.error(`[refresh] FAILED: ${e.message}`);
    console.error(e.stack);
    await fs.writeFile('run-error.log', String(e.stack || e.message)).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  await fs.writeFile('run-summary.json', JSON.stringify(summary, null, 2)).catch(() => {});
  if (!summary.ok) process.exit(1);
  console.log('\n=== Refresh complete ===');
  console.log(JSON.stringify({
    clients: summary.clients?.count,
    invoices: summary.invoices?.count,
    payments: summary.payments?.count,
    profiles: summary.profiles?.profiles,
    withPhone: summary.profiles?.withPhone,
    addpayTxns: summary.addpayTxns,
    mdb: summary.deploy?.mdb,
    odb: summary.deploy?.odb,
    toatls: summary.deploy?.totals,
  }, null, 2));
}

main();

#!/usr/bin/env node
/**
 * Narrow, targeted retry over ONLY the rows still ending in "Lihat
 * selengkapnya" after the earlier fulltext-fix pass. Deliberately does not
 * fetch comments or re-derive engagement counts (both already handled/frozen
 * per the user's "stop expanding data" instruction) — this touches just the
 * tweet text column, and the link column when a /photo/ redirects to a
 * canonical /posts/ permalink. Resumable via its own checkpoint file.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { expandTruncatedText, extractFullPostText, findCanonicalPostLink } = require('./lib/facebook_extract');
const { log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'facebook.json');
const CSV_PATH = path.join(__dirname, 'out', 'facebook_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'facebook_retry_truncated.json');
const MAX_LOGIN_WALLS = 3;

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function writeCsv(csvPath, header, rows) {
  const escq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(escq).join(','));
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');
}

async function isLoginWall(page) {
  const url = page.url();
  return url.includes('/login') || url.includes('checkpoint');
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const table = parseCsv(raw);
  const header = table[0];
  const rows = table.slice(1);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};

  const targets = [];
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i][col.tweet] || '';
    const link = rows[i][col.link] || '';
    if (/lihat selengkapnya\s*$/i.test(text) && link) targets.push(i);
  }
  log(`Found ${targets.length} still-truncated rows with a link to retry.`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let resolved = 0, processed = 0;

  for (const i of targets) {
    const link = rows[i][col.link];
    if (checkpoint[link]) continue;

    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      log(`  [row ${i}] goto error: ${e.message}`);
      continue;
    }
    if (await isLoginWall(page)) {
      loginWalls++;
      log(`  LOGIN WALL at row ${i}. (${loginWalls}/${MAX_LOGIN_WALLS})`);
      if (loginWalls >= MAX_LOGIN_WALLS) { log('Too many login walls — stopping (not retrying).'); break; }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1200));

    let effectiveLink = link;
    if (link.includes('/photo/')) {
      const canonical = await findCanonicalPostLink(page);
      if (canonical && canonical !== link) {
        try {
          await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 20000 });
          if (await isLoginWall(page)) { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
          else { effectiveLink = canonical; await new Promise((r) => setTimeout(r, 1000)); }
        } catch (e) { /* fall back to original page, already loaded */ }
      }
    }
    await expandTruncatedText(page);

    const originalText = rows[i][col.tweet];
    const fullText = await extractFullPostText(page, originalText);
    if (fullText && fullText !== originalText && !/lihat selengkapnya\s*$/i.test(fullText)) {
      rows[i][col.tweet] = fullText;
      if (effectiveLink !== link) rows[i][col.link] = effectiveLink;
      resolved++;
    }

    checkpoint[link] = true;
    processed++;
    if (processed % 10 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(CSV_PATH, header, rows);
      log(`  progress: ${processed}/${targets.length} checked | resolved=${resolved}`);
    }
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(CSV_PATH, header, rows);
  await browser.close();
  log(`DONE: processed=${processed} resolved=${resolved}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

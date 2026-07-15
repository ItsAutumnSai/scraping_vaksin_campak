#!/usr/bin/env node
/**
 * One-off backfill: visits each already-collected Facebook row's permalink and
 * fills in its postdate (see lib/facebook_date.js for why this needs a second
 * page visit rather than being extractable from the search-results page).
 * Rewrites out/facebook_vaccine_2024_2026.csv in place. Resumable via a
 * checkpoint file, and writes progress incrementally so a partial run isn't lost.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { extractEarliestPostdate } = require('./lib/facebook_date');
const { log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'facebook.json');
const CSV_PATH = path.join(__dirname, 'out', 'facebook_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'facebook_date_backfill.json');
const MAX_LOGIN_WALLS = 3;

// Minimal CSV parse/write that round-trips this file's own escaping convention
// (fields quoted with "" escaping), avoiding a new dependency for one script.
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

function writeCsv(header, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
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
  const linkIdx = header.indexOf('link');
  const postdateIdx = header.indexOf('postdate');

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let resolved = 0, skippedNoLink = 0, unresolved = 0, alreadyDone = 0;

  for (let i = 0; i < rows.length; i++) {
    const link = rows[i][linkIdx];
    if (!link) { skippedNoLink++; continue; }
    if (rows[i][postdateIdx]) { alreadyDone++; continue; }
    if (checkpoint[link]) {
      rows[i][postdateIdx] = checkpoint[link] === 'UNRESOLVED' ? '' : checkpoint[link];
      if (checkpoint[link] === 'UNRESOLVED') unresolved++; else resolved++;
      continue;
    }

    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      log(`  [${i}] goto error: ${e.message}`);
      continue;
    }
    if (await isLoginWall(page)) {
      loginWalls++;
      log(`  LOGIN WALL at row ${i}. (${loginWalls}/${MAX_LOGIN_WALLS})`);
      if (loginWalls >= MAX_LOGIN_WALLS) {
        log('Too many login walls — stopping (not retrying).');
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1500));

    const postdate = await extractEarliestPostdate(page);
    checkpoint[link] = postdate || 'UNRESOLVED';
    if (postdate) { rows[i][postdateIdx] = postdate; resolved++; }
    else unresolved++;

    if (i % 10 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(header, rows);
      log(`  progress: ${i}/${rows.length} rows | resolved=${resolved} unresolved=${unresolved}`);
    }
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(header, rows);
  await browser.close();
  log(`DONE: resolved=${resolved} unresolved=${unresolved} skipped(no link)=${skippedNoLink} already-done=${alreadyDone} total=${rows.length}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

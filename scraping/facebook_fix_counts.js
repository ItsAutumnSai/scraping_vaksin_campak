#!/usr/bin/env node
/**
 * Third (deferred) pass, counts only: revisits each top-level Facebook post
 * (skips comment rows, which already have no numeric counts to fix) and
 * corrects likes/comments/shares using the verified-accurate
 * extractEngagementCounts() — two earlier approaches were both wrong (see
 * lib/facebook_extract.js for details). Does NOT re-resolve text or re-add
 * comments, so it's safe to run after facebook_fetch_fulltext_and_comments.js
 * without duplicating anything. Resumable via its own checkpoint file.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { extractEngagementCounts } = require('./lib/facebook_extract');
const { log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'facebook.json');
const CSV_PATH = path.join(__dirname, 'out', 'facebook_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'facebook_counts_fix.json');
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

function writeCsv(header, rows) {
  const escq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(escq).join(','));
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
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let fixed = 0, processed = 0, skippedComment = 0, skippedNoLink = 0;

  for (let i = 0; i < rows.length; i++) {
    const replysource = rows[i][col.replysource];
    const isComment = !!replysource && replysource !== 'NaN';
    if (isComment) { skippedComment++; continue; }
    const link = rows[i][col.link];
    if (!link) { skippedNoLink++; continue; }
    if (checkpoint[link]) continue;

    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      log(`  [${i}] goto error: ${e.message}`);
      continue;
    }
    if (await isLoginWall(page)) {
      loginWalls++;
      log(`  LOGIN WALL at row ${i}. (${loginWalls}/${MAX_LOGIN_WALLS})`);
      if (loginWalls >= MAX_LOGIN_WALLS) { log('Too many login walls — stopping (not retrying).'); break; }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 1500));

    const { likes, comments, shares } = await extractEngagementCounts(page);
    rows[i][col.likes] = likes;
    rows[i][col.comments] = comments;
    rows[i][col.retweets] = shares; // Facebook has no "retweet" concept — this column holds share count
    fixed++;

    checkpoint[link] = true;
    processed++;
    if (processed % 15 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(header, rows);
      log(`  progress: ${processed} posts fixed`);
    }
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 600));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(header, rows);
  await browser.close();
  log(`DONE: fixed=${fixed} skippedComment=${skippedComment} skippedNoLink=${skippedNoLink}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

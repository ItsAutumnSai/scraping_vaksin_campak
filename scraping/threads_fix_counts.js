#!/usr/bin/env node
/**
 * Fixes likes/comments/reposts/shares on the ORIGINAL (non-reply) Threads
 * rows: threads_scraper.js used its own inline copy of the extraction logic
 * that was never updated when lib/threads_extract.js's positional-number
 * heuristic was replaced with the robust label-anchored version (only
 * threads_fetch_comments.js's newly-added reply rows picked up the fix
 * automatically, since that script imports the shared lib). Revisits each
 * original post's permalink and re-extracts counts with the fixed logic.
 * Does not touch text/date/comment rows. Resumable via checkpoint.
 */
const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { EXTRACT_ALL_POSTS } = require('./lib/threads_extract');
const { log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'threads.json');
const CSV_PATH = path.join(__dirname, 'out', 'threads_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'threads_counts_fix.json');
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
  return page.url().includes('/login');
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const table = parseCsv(raw);
  const header = table[0];
  const rows = table.slice(1);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    viewport: { width: 1366, height: 768 },
  });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let fixed = 0, processed = 0, skippedComment = 0, notFound = 0;

  for (let i = 0; i < rows.length; i++) {
    const replysource = rows[i][col.replysource];
    const isComment = !!replysource && replysource !== 'NaN';
    if (isComment) { skippedComment++; continue; }
    const link = rows[i][col.link];
    const postId = (link.match(/\/post\/(.+)/) || [])[1];
    if (!link || !postId) continue;
    if (checkpoint[link]) continue;

    try {
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 25000 });
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
    await new Promise((r) => setTimeout(r, 2500));

    const posts = await page.evaluate(EXTRACT_ALL_POSTS).catch(() => []);
    const match = posts.find((p) => p.tweetId === postId);
    if (match) {
      rows[i][col.likes] = match.likes;
      rows[i][col.comments] = match.comments;
      rows[i][col.retweets] = match.retweets;
      if (col.shares !== undefined) rows[i][col.shares] = match.shares;
      fixed++;
    } else {
      notFound++;
    }

    checkpoint[link] = true;
    processed++;
    if (processed % 15 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(header, rows);
      log(`  progress: ${processed} posts checked | fixed=${fixed} notFound=${notFound}`);
    }
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(header, rows);
  await browser.close();
  log(`DONE: processed=${processed} fixed=${fixed} notFound=${notFound} skippedComment=${skippedComment}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

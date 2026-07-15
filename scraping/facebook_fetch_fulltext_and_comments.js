#!/usr/bin/env node
/**
 * Second (deferred) pass over an already-collected Facebook CSV: expands
 * "Lihat Selengkapnya"-truncated post text where the permalink page allows it,
 * and appends visible comments as new rows with replysource set to the parent
 * post's link. Run only after facebook_scraper.js's main collection pass has
 * finished, by design — this does per-post page visits, which would slow down
 * discovery of new posts if interleaved with the search-results loop.
 * Resumable via a checkpoint file; rewrites the CSV incrementally.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { expandTruncatedText, extractFullPostText, extractComments, findCanonicalPostLink, extractEngagementCounts } = require('./lib/facebook_extract');
const { esc, log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'facebook.json');
const CSV_PATH = path.join(__dirname, 'out', 'facebook_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'facebook_fulltext_comments.json');
const MAX_LOGIN_WALLS = 3;
const MAX_COMMENTS_PER_POST = 15;

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
  let rows = table.slice(1);
  const col = Object.fromEntries(header.map((h, i) => [h, i]));

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};
  let nextIdx = Math.max(...rows.map((r) => parseInt(r[col.index], 10) || 0)) + 1;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let fullTextResolved = 0, commentsAdded = 0, processed = 0;
  const originalRowCount = rows.length;

  for (let i = 0; i < originalRowCount; i++) {
    const link = rows[i][col.link];
    if (!link) continue;
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

    // "/photo/" lightbox links never expose the caption in expandable form —
    // find the real post permalink (surfaced via comment links) and hop there.
    let effectiveLink = link;
    if (link.includes('/photo/')) {
      const canonical = await findCanonicalPostLink(page);
      if (canonical && canonical !== link) {
        try {
          await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 20000 });
          if (await isLoginWall(page)) { await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
          else { effectiveLink = canonical; await new Promise((r) => setTimeout(r, 1200)); }
        } catch (e) { /* fall back to original page, already loaded */ }
      }
    }
    // Load a bit more of the comment list before reading counts/comments —
    // otherwise only whatever rendered in the initial viewport is captured.
    for (let s = 0; s < 3; s++) {
      await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
    }
    await expandTruncatedText(page);

    const originalText = rows[i][col.tweet];
    const fullText = await extractFullPostText(page, originalText);
    if (fullText && fullText !== originalText) {
      rows[i][col.tweet] = fullText;
      if (effectiveLink !== link) rows[i][col.link] = effectiveLink;
      fullTextResolved++;
    }

    const engagement = await extractEngagementCounts(page);
    if (engagement.likes) rows[i][col.likes] = engagement.likes;
    if (engagement.comments) rows[i][col.comments] = engagement.comments;

    const comments = await extractComments(page, originalText, MAX_COMMENTS_PER_POST);
    for (const c of comments) {
      const newRow = header.map(() => '');
      newRow[col.index] = nextIdx++;
      newRow[col.account] = c.account || 'unknown';
      newRow[col.postdate] = c.postdate || '';
      newRow[col.tweet] = c.text;
      newRow[col.link] = '';
      newRow[col.comments] = 0;
      if (col.retweets !== undefined) newRow[col.retweets] = 0;
      newRow[col.likes] = 0;
      if (col.views !== undefined) newRow[col.views] = -1;
      newRow[col.replysource] = effectiveLink; // parent post link (canonical if resolved)
      rows.push(newRow);
      commentsAdded++;
    }

    checkpoint[link] = true;
    processed++;
    if (processed % 10 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(CSV_PATH, header, rows);
      log(`  progress: ${processed} posts visited | fullText+${fullTextResolved} | comments+${commentsAdded}`);
    }
    await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(CSV_PATH, header, rows);
  await browser.close();
  log(`DONE: posts visited=${processed} fullTextResolved=${fullTextResolved} commentsAdded=${commentsAdded} totalRowsNow=${rows.length}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

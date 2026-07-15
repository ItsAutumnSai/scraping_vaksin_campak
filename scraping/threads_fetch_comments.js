#!/usr/bin/env node
/**
 * Second (deferred) pass over an already-collected Threads CSV: visits each
 * post's own permalink, which shows the post plus its reply thread below, and
 * appends replies as new rows with replysource set to the parent post's link.
 * Run only after threads_scraper.js's main hashtag-page collection has
 * finished, by design — this does one page visit per post, which would slow
 * down discovery of new posts if interleaved with the tag-page scroll loop.
 * Resumable via a checkpoint file; rewrites the CSV incrementally.
 */
const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { EXTRACT_ALL_POSTS } = require('./lib/threads_extract');
const { isLikelyIndonesian } = require('./lib/locale');
const { esc, log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'threads.json');
const CSV_PATH = path.join(__dirname, 'out', 'threads_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'threads_comments.json');
const MAX_LOGIN_WALLS = 3;
const MAX_REPLIES_PER_POST = 15;

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
  const seenPostIds = new Set(rows.map((r) => (r[col.link].match(/\/post\/(.+)/) || [])[1]).filter(Boolean));
  let nextIdx = Math.max(...rows.map((r) => parseInt(r[col.index], 10) || 0)) + 1;

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    viewport: { width: 1366, height: 768 },
  });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let processed = 0, repliesAdded = 0;
  // Bug fixed here: on a resumed run, rows.length already includes reply rows
  // added by an earlier run of this same script (they're appended to the same
  // CSV). Without excluding them, a resume re-scopes the loop to "every row
  // in the file" and starts fetching replies-to-replies for rows that are
  // themselves already comments — unbounded scope creep, not the intended
  // "finish the remaining original posts". Only ever process rows that were
  // NOT added as a reply (replysource is empty/NaN).
  const originalPostRows = rows.filter((r) => {
    const rs = r[col.replysource];
    return !rs || rs === 'NaN';
  });

  for (let i = 0; i < originalPostRows.length; i++) {
    const link = originalPostRows[i][col.link];
    if (!link || checkpoint[link]) continue;
    const parentPostId = (link.match(/\/post\/(.+)/) || [])[1];
    if (!parentPostId) continue;

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
    for (let s = 0; s < 3; s++) {
      await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }

    const posts = await page.evaluate(EXTRACT_ALL_POSTS).catch(() => []);
    let added = 0;
    for (const p of posts) {
      if (p.tweetId === parentPostId) continue; // the post itself, already have it
      if (seenPostIds.has(p.tweetId)) continue;
      if (!isLikelyIndonesian(p.tweet)) continue;
      seenPostIds.add(p.tweetId);
      const newRow = header.map(() => '');
      newRow[col.index] = nextIdx++;
      newRow[col.account] = p.account;
      newRow[col.postdate] = p.postdate;
      newRow[col.tweet] = p.tweet;
      newRow[col.link] = p.link;
      if (col.topic_tag !== undefined) newRow[col.topic_tag] = p.topic_tag || '';
      newRow[col.comments] = p.comments;
      if (col.retweets !== undefined) newRow[col.retweets] = p.retweets;
      newRow[col.likes] = p.likes;
      if (col.shares !== undefined) newRow[col.shares] = p.shares;
      newRow[col.replysource] = link;
      rows.push(newRow);
      added++;
      if (added >= MAX_REPLIES_PER_POST) break;
    }
    repliesAdded += added;

    checkpoint[link] = true;
    processed++;
    if (processed % 10 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeCsv(header, rows);
      log(`  progress: ${processed} posts visited | replies+${repliesAdded}`);
    }
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeCsv(header, rows);
  await browser.close();
  log(`DONE: posts visited=${processed} repliesAdded=${repliesAdded} totalRowsNow=${rows.length}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

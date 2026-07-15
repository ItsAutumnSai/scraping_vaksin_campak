#!/usr/bin/env node
/**
 * Second (deferred) pass over an already-collected X CSV: visits each tweet's
 * own permalink, which shows the tweet plus its reply thread below, and appends
 * replies as new rows with replysource set to the parent tweet's link. Run only
 * after x_scraper.js's main search-based collection has finished, by design —
 * this does one page visit per post, which would slow down discovery of new
 * tweets if interleaved with the date-chunked search loop.
 * Resumable via a checkpoint file; rewrites the CSV incrementally.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { EXTRACT_ALL_TWEETS } = require('./lib/x_extract');
const { isLikelyIndonesian } = require('./lib/locale');
const { esc, log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'x.json');
const CSV_PATH = path.join(__dirname, 'out', 'x_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'x_comments.json');
const MAX_LOGIN_WALLS = 3;
const MAX_REPLIES_PER_TWEET = 15;

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

// x_scraper.js's CSV is NOT quoted for every field (only the tweet text is
// quoted) — see buildRows() in x_scraper.js. Reparse accordingly.
function parseXCsvLine(line, header) {
  // Fields: index,account,postdate,"tweet",link,comments,retweets,likes,views,replysource
  const m = line.match(/^([^,]*),([^,]*),([^,]*),"((?:[^"]|"")*)",([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
  if (!m) return null;
  const [, index, account, postdate, tweet, link, comments, retweets, likes, views, replysource] = m;
  return { index, account, postdate, tweet: tweet.replace(/""/g, '"'), link, comments, retweets, likes, views, replysource };
}

function writeXCsv(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(`${r.index},${r.account},${r.postdate},"${esc(r.tweet)}",${r.link},${r.comments},${r.retweets},${r.likes},${r.views},${r.replysource}`);
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

async function isLoginWall(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) return true;
  const hasLoginForm = await page.$('input[name="text"][autocomplete="username"]').catch(() => null);
  return !!hasLoginForm;
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rawLines = raw.trim().split('\n');
  const header = rawLines[0].split(',');
  const rows = rawLines.slice(1).map((l) => parseXCsvLine(l, header)).filter(Boolean);

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};
  const seenTweetIds = new Set(rows.map((r) => (r.link.match(/status\/(\d+)/) || [])[1]).filter(Boolean));
  let nextIdx = Math.max(...rows.map((r) => parseInt(r.index, 10) || 0)) + 1;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let processed = 0, repliesAdded = 0;
  const originalRowCount = rows.length;

  for (let i = 0; i < originalRowCount; i++) {
    const row = rows[i];
    if (!row.link || checkpoint[row.link]) continue;
    const parentTweetId = (row.link.match(/status\/(\d+)/) || [])[1];
    if (!parentTweetId) continue;

    try {
      await page.goto(row.link, { waitUntil: 'domcontentloaded', timeout: 25000 });
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
    // scroll a bit to load reply tweets below the main one
    for (let s = 0; s < 3; s++) {
      await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }

    const tweets = await page.evaluate(EXTRACT_ALL_TWEETS).catch(() => []);
    let added = 0;
    for (const t of tweets) {
      if (t.tweetId === parentTweetId) continue; // the post itself, already have it
      if (seenTweetIds.has(t.tweetId)) continue;
      if (!isLikelyIndonesian(t.tweet)) continue;
      seenTweetIds.add(t.tweetId);
      rows.push({
        index: nextIdx++, account: t.account, postdate: t.postdate, tweet: t.tweet,
        link: t.link, comments: t.comments, retweets: t.retweets, likes: t.likes,
        views: t.views, replysource: row.link,
      });
      added++;
      if (added >= MAX_REPLIES_PER_TWEET) break;
    }
    repliesAdded += added;

    checkpoint[row.link] = true;
    processed++;
    if (processed % 10 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeXCsv(header, rows);
      log(`  progress: ${processed} tweets visited | replies+${repliesAdded}`);
    }
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeXCsv(header, rows);
  await browser.close();
  log(`DONE: tweets visited=${processed} repliesAdded=${repliesAdded} totalRowsNow=${rows.length}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

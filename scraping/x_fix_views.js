#!/usr/bin/env node
/**
 * Fixes the view-count column on already-collected X rows: plain parseInt()
 * on abbreviated counts like "27.7K" silently truncated to 27 (stops at the
 * decimal point) — see lib/x_extract.js for the corrected parser. Revisits
 * each tweet's own permalink and re-reads just the view count; doesn't touch
 * text/likes/comments/retweets (those come from full-precision aria-labels
 * and were never wrong). Resumable via checkpoint.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadCookiesForContext } = require('./lib/cookies');
const { EXTRACT_ALL_TWEETS } = require('./lib/x_extract');
const { log } = require('./lib/csv');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'x.json');
const CSV_PATH = path.join(__dirname, 'out', 'x_vaccine_2024_2026.csv');
const CHECKPOINT_PATH = path.join(__dirname, 'state', 'x_views_fix.json');
const MAX_LOGIN_WALLS = 3;

function parseXCsvLine(line) {
  const m = line.match(/^([^,]*),([^,]*),([^,]*),"((?:[^"]|"")*)",([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/);
  if (!m) return null;
  const [, index, account, postdate, tweet, link, comments, retweets, likes, views, replysource] = m;
  return { index, account, postdate, tweet: tweet.replace(/""/g, '"'), link, comments, retweets, likes, views, replysource };
}

function writeXCsv(header, rows) {
  const esc = (v) => String(v ?? '').replace(/"/g, '""').replace(/\n/g, ' ').trim();
  const lines = [header.join(',')];
  for (const r of rows) lines.push(`${r.index},${r.account},${r.postdate},"${esc(r.tweet)}",${r.link},${r.comments},${r.retweets},${r.likes},${r.views},${r.replysource}`);
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

async function isLoginWall(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) return true;
  const hasLoginForm = await page.$('input[name="text"][autocomplete="username"]').catch(() => null);
  return !!hasLoginForm;
}

async function main() {
  const rawLines = fs.readFileSync(CSV_PATH, 'utf-8').trim().split('\n');
  const header = rawLines[0].split(',');
  const rows = rawLines.slice(1).map(parseXCsvLine).filter(Boolean);

  const checkpoint = fs.existsSync(CHECKPOINT_PATH) ? JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8')) : {};

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;
  let fixed = 0, processed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tweetId = (row.link.match(/status\/(\d+)/) || [])[1];
    if (!tweetId) continue;
    if (checkpoint[row.link]) continue;

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
    await new Promise((r) => setTimeout(r, 2000));

    // The target tweet isn't always the FIRST article on its own permalink
    // page — if it's a reply, X shows the parent/context tweet(s) above it,
    // so grabbing only the first article silently matched the wrong tweet
    // (verified: a reply's permalink page had an unrelated tweet, from a
    // different account entirely, as article #1) and skipped the real fix.
    // Search every article on the page for the one whose own tweetId matches,
    // scrolling first since X virtualizes the DOM and the focused tweet may
    // not be rendered yet if it sits below the parent-context tweets.
    let parsed = null;
    for (let s = 0; s < 4 && !parsed; s++) {
      const allTweets = await page.evaluate(EXTRACT_ALL_TWEETS).catch(() => []);
      parsed = allTweets.find((t) => t.tweetId === tweetId) || null;
      if (parsed) break;
      await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (parsed && parsed.views !== -1) {
      row.views = parsed.views;
      fixed++;
    }

    checkpoint[row.link] = true;
    processed++;
    if (processed % 15 === 0) {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
      writeXCsv(header, rows);
      log(`  progress: ${processed} tweets checked | fixed=${fixed}`);
    }
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
  }

  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));
  writeXCsv(header, rows);
  await browser.close();
  log(`DONE: processed=${processed} fixed=${fixed}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

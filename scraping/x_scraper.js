#!/usr/bin/env node
/**
 * X.com scraper — search-based, date-chunked across 2024-06 through 2026-06.
 * Adapted from openclaw_workspace/scrape_x_full.js: same DOM-parse approach,
 * proper cookie conversion (lib/cookies.js), resumable seen-id checkpoint,
 * capped total row count, and stops (not retry-loops) on login walls.
 */
const { chromium } = require('playwright');
const path = require('path');
const { loadCookiesForContext } = require('./lib/cookies');
const { CsvWriter, SeenSet, halfMonthRanges, esc, log } = require('./lib/csv');
const { CORE_KEYWORDS } = require('./lib/keywords');
const { isLikelyIndonesian } = require('./lib/locale');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'x.json');
const OUT_PATH = path.join(__dirname, 'out', 'x_vaccine_2024_2026.csv');
const STATE_PATH = path.join(__dirname, 'state', 'x_seen.json');
const CSV_H = 'index,account,postdate,tweet,link,comments,retweets,likes,views,replysource';
const TARGET = 4000;
// Real Indonesian measles-vaccine discourse volume is genuinely uneven across the
// window (much sparser before the 2025 MR catch-up campaign coverage picked up),
// so a low empty-range threshold would abort the whole run partway through 2024
// and never reach the 2025 months we know have real data. This is a last-resort
// "we're stuck/blocked" safety net, not a "this period has no content" signal —
// login-wall detection is what actually catches real blocking.
const MAX_CONSECUTIVE_EMPTY_RANGES = 150;
const MAX_LOGIN_WALLS = 3;

// Optional CLI override for quick verification runs: node x_scraper.js 2025-06 2025-07
const CLI_START = process.argv[2];
const CLI_END = process.argv[3];

const PARSE = (el) => {
  try {
    const link = el.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const href = link.getAttribute('href');
    const m = href.match(/\/status\/(\d+)/);
    if (!m) return null;
    const tweetId = m[1];

    let account = '';
    for (const x of el.querySelectorAll('a[role="link"]')) {
      const hh = x.getAttribute('href');
      if (hh && hh.startsWith('/') && !hh.includes('/status/') && !hh.includes('/i/') && hh.split('/').filter(Boolean).length === 1) {
        account = hh.slice(1).split('?')[0]; break;
      }
    }
    if (!account) {
      for (const s of el.querySelectorAll('span')) {
        const t = s.textContent?.trim();
        if (t && t.startsWith('@')) { account = t.slice(1); break; }
      }
    }

    const time = el.querySelector('time');
    const textEl = el.querySelector('[data-testid="tweetText"]');
    const tweet = textEl?.textContent?.trim() || '';
    const postdate = time?.getAttribute('datetime') || '';

    const getCount = (sel) => {
      const btn = el.querySelector(sel);
      if (!btn) return 0;
      const label = btn.getAttribute('aria-label') || '';
      const n = label.match(/^(\d+)/);
      return n ? parseInt(n[1]) : 0;
    };

    const comments = getCount('[data-testid="reply"]');
    const retweets = getCount('[data-testid="retweet"]');
    const likes = getCount('[data-testid="like"]');

    // View counts are abbreviated ("27.7K", "1M") — plain parseInt() silently
    // truncates at the decimal point (parseInt("27.7K") === 27), badly
    // undercounting. Parse the suffix/decimal properly.
    const parseAbbrevNumber = (s) => {
      if (!s) return -1;
      s = s.trim();
      const mult = /K$/i.test(s) ? 1e3 : /M$/i.test(s) ? 1e6 : 1;
      const n = parseFloat(s.replace(/,/g, '').replace(/[KM]$/i, ''));
      return Number.isNaN(n) ? -1 : Math.round(n * mult);
    };

    let views = -1;
    const analLink = el.querySelector('a[href*="/analytics"]');
    if (analLink) {
      const vt = analLink.textContent?.trim();
      if (vt) views = parseAbbrevNumber(vt);
    }
    if (views === -1) {
      const containers = [...el.querySelectorAll('[data-testid="app-text-transition-container"]')];
      if (containers.length >= 4) {
        const last = containers[containers.length - 1]?.textContent?.trim();
        if (last) views = parseAbbrevNumber(last);
      }
    }

    return { tweetId, account: account || 'unknown', postdate, tweet, link: 'https://x.com' + href, comments, retweets, likes, views };
  } catch (e) { return null; }
};

function buildRows(items, startIdx) {
  return items.map((d, i) => {
    const idx = startIdx + i;
    return `${idx},${d.account},${d.postdate},"${esc(d.tweet)}",${d.link},${d.comments},${d.retweets},${d.likes},${d.views},NaN`;
  });
}

async function isLoginWall(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) return true;
  const hasLoginForm = await page.$('input[name="text"][autocomplete="username"]').catch(() => null);
  return !!hasLoginForm;
}

async function scrapeRange(page, keyword, since, until, seen, remaining) {
  // One keyword per query, matching the original proven-working technique — an
  // OR-combined multi-keyword query was tested and empirically dilutes results
  // toward whichever term has the most global (non-Indonesian) volume, e.g.
  // "rubella" pulls in English medical-Twitter discourse and crowds out the
  // sparser genuine Indonesian matches within the per-query result window.
  const phrase = keyword.includes(' ') ? `"${keyword}"` : keyword;
  const q = encodeURIComponent(`${phrase} since:${since} until:${until}`);
  const url = `https://x.com/search?q=${q}&src=typed_query&f=live`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    return { rows: [], loginWall: false, error: e.message };
  }
  if (await isLoginWall(page)) return { rows: [], loginWall: true };

  await new Promise((r) => setTimeout(r, 2500));
  const collected = [];
  let noNewCount = 0;
  for (let scroll = 0; scroll < 12 && collected.length < remaining && noNewCount < 3; scroll++) {
    const cells = await page.$$('article[data-testid="tweet"]');
    const before = collected.length;
    for (const cell of cells) {
      const data = await cell.evaluate(PARSE).catch(() => null);
      if (!data || seen.has(data.tweetId)) continue;
      seen.add(data.tweetId);
      if (!isLikelyIndonesian(data.tweet)) continue; // e.g. Malay "campak" = "throw" slang
      collected.push(data);
      if (collected.length >= remaining) break;
    }
    noNewCount = collected.length === before ? noNewCount + 1 : 0;
    await page.evaluate(() => window.scrollBy(0, 2200)).catch(() => {});
    await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1200));
  }
  return { rows: collected, loginWall: false };
}

async function main() {
  log('=== X.COM SCRAPE START (2024-06 - 2026-06) ===');
  const csv = new CsvWriter(OUT_PATH, CSV_H);
  const seen = new SeenSet(STATE_PATH); // dedup only — NOT the collected-row budget counter
  let idx = csv.rowCount() + 1;
  let totalCollected = csv.rowCount();

  const [startY, startM] = CLI_START ? CLI_START.split('-').map(Number) : [2024, 6];
  const [endY, endM] = CLI_END ? CLI_END.split('-').map(Number) : [2026, 6];
  const ranges = halfMonthRanges(startY, startM - 1, endY, endM - 1); // halfMonthRanges takes 0-indexed months
  log(`${ranges.length} date-chunks x ${CORE_KEYWORDS.length} keywords queued, starting at ${totalCollected} collected rows, target=${TARGET}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let consecutiveEmpty = 0;
  let loginWalls = 0;

  outer:
  for (const range of ranges) {
    for (const keyword of CORE_KEYWORDS) {
      if (totalCollected >= TARGET) break outer;
      const remaining = TARGET - totalCollected;
      const { rows, loginWall, error } = await scrapeRange(page, keyword, range.since, range.until, seen, Math.min(remaining, 40));

      if (loginWall) {
        loginWalls++;
        log(`LOGIN WALL hit on ${range.since}..${range.until}. (${loginWalls}/${MAX_LOGIN_WALLS})`);
        if (loginWalls >= MAX_LOGIN_WALLS) {
          log('Too many login walls — cookies likely expired/invalid. Stopping (not retrying).');
          break outer;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (error) log(`  error on ${range.since}..${range.until}: ${error}`);

      if (rows.length > 0) {
        csv.appendRows(buildRows(rows, idx));
        idx += rows.length;
        totalCollected += rows.length;
        seen.save();
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
      }
      log(`[${range.since}..${range.until}] +${rows.length} | total=${totalCollected}/${TARGET}`);

      if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY_RANGES) {
        log(`${MAX_CONSECUTIVE_EMPTY_RANGES} consecutive empty ranges — likely rate-limited or exhausted. Stopping.`);
        break outer;
      }
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  }

  await browser.close();
  seen.save();
  log(`DONE: ${seen.size} rows -> ${OUT_PATH}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

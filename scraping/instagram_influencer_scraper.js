#!/usr/bin/env node
/**
 * Instagram scraper (mode 2) — visits specific known mom/family/pediatric
 * influencer accounts' own post grids, instead of hashtag pages. Hashtag pages
 * turned out to be dominated by unrelated marketing/generic-parenting content
 * (verified: only ~43% of hashtag-sourced candidates survived semantic
 * classification in testing) — a curated account list should have a much
 * higher hit rate for genuine "vaksin campak" discourse, since these accounts
 * were selected specifically for covering child-health/vaccination topics.
 *
 * Reads usernames from instagram_influencers.txt (one per line, '#' comments
 * ignored). For each account, collects recent post shortcodes from their grid,
 * visits each post, and keeps only ones whose caption both (a) contains at
 * least one vaccine/measles-related keyword and (b) passes the Indonesian
 * locale filter — an account-level pre-filter, since most posts on even a
 * relevant influencer's feed won't be about vaccines specifically. Appends to
 * the SAME instagram_vaccine_2024_2026.csv and shortcode seen-set as
 * instagram_scraper.js (hashtag mode), so downstream merge/classification
 * needs no changes — this is just a second discovery method for the same file.
 */
const fs = require('fs');
const { chromium } = require('playwright');
const path = require('path');
const { loadCookiesForContext } = require('./lib/cookies');
const { CsvWriter, SeenSet, esc, log } = require('./lib/csv');
const { HASHTAG_KEYWORDS, CORE_KEYWORDS } = require('./lib/keywords');
const { isLikelyIndonesian } = require('./lib/locale');
const { EXTRACT_POST, COLLECT_SHORTCODES } = require('./lib/instagram_extract');

// instagram.json got rate-limited (HTTP 429) by the volume of individual post
// visits the hashtag scraper did; instagram2.json is a second account added
// specifically to keep going once that happened.
const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'instagram2.json');
const OUT_PATH = path.join(__dirname, 'out', 'instagram_vaccine_2024_2026.csv');
const STATE_PATH = path.join(__dirname, 'state', 'instagram_seen.json');
const INFLUENCERS_PATH = path.join(__dirname, 'instagram_influencers.txt');
const CSV_H = 'index,account,postdate,tweet,link,comments,retweets,likes,views,replysource';
const MIN_YEAR_MONTH = '2024-06';
const MAX_YEAR_MONTH = '2026-06';
const MAX_POSTS_PER_ACCOUNT = 60;

const RELEVANCE_KEYWORDS = [...new Set([...HASHTAG_KEYWORDS, ...CORE_KEYWORDS.map((k) => k.toLowerCase().replace(/\s+/g, ''))])];

function inWindow(postdate) {
  if (!postdate) return false;
  const ym = postdate.slice(0, 7);
  return ym >= MIN_YEAR_MONTH && ym <= MAX_YEAR_MONTH;
}

function looksRelevant(caption) {
  if (!caption) return false;
  const lower = caption.toLowerCase().replace(/[^a-z0-9]/g, '');
  return RELEVANCE_KEYWORDS.some((k) => lower.includes(k.replace(/[^a-z0-9]/g, '')));
}

function loadInfluencers() {
  const raw = fs.readFileSync(INFLUENCERS_PATH, 'utf-8');
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

async function main() {
  log('=== INSTAGRAM INFLUENCER-BASED SCRAPE START ===');
  const usernames = loadInfluencers();
  const csv = new CsvWriter(OUT_PATH, CSV_H);
  const seen = new SeenSet(STATE_PATH);
  let idx = csv.rowCount() + 1;
  let totalCollected = csv.rowCount();
  log(`${usernames.length} influencer accounts queued, starting at ${totalCollected} collected rows`);

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  log('Warming up...');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  const homeUrl = page.url();
  if (homeUrl.includes('login') || homeUrl.includes('challenge') || homeUrl.includes('checkpoint')) {
    log(`BLOCKED at login/challenge: ${homeUrl.slice(0, 80)}. Cookies likely expired/invalid. Stopping (not retrying).`);
    await browser.close();
    process.exit(1);
  }
  log('Session OK');

  for (let ai = 0; ai < usernames.length; ai++) {
    const username = usernames[ai];
    log(`[${ai + 1}/${usernames.length}] @${username}`);

    let resp;
    try {
      resp = await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      log(`  goto error: ${e.message}`);
      continue;
    }
    if (resp && resp.status() === 429) {
      log('  HTTP 429 (rate limited). Stopping (not retrying) — resume this script later once it clears.');
      break;
    }
    const curUrl = page.url();
    if (curUrl.includes('login') || curUrl.includes('challenge') || curUrl.includes('checkpoint')) {
      log(`  BLOCKED at login/challenge visiting @${username}. Stopping (not retrying).`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));

    const notFound = await page.evaluate(() => document.body.innerText.includes("Sorry, this page isn't available") || document.body.innerText.includes('Halaman tidak tersedia')).catch(() => false);
    if (notFound) { log(`  @${username} not found/unavailable, skipping`); continue; }

    for (let s = 0; s < 15; s++) {
      await page.evaluate(() => window.scrollBy(0, 800)).catch(() => {});
      await new Promise((r) => setTimeout(r, 700 + Math.random() * 400));
    }

    const shortcodes = await page.evaluate(COLLECT_SHORTCODES).catch(() => []);
    log(`  ${shortcodes.length} shortcodes found`);

    let collected = 0, checked = 0;
    for (const sc of shortcodes) {
      if (collected >= MAX_POSTS_PER_ACCOUNT || checked >= MAX_POSTS_PER_ACCOUNT * 2) break;
      if (seen.has(sc)) continue;
      checked++;

      let postResp;
      try {
        postResp = await page.goto(`https://www.instagram.com/p/${sc}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch { seen.add(sc); continue; }
      if (postResp && postResp.status() === 429) {
        log('  HTTP 429 (rate limited) mid-account. Stopping (not retrying).');
        seen.save();
        await browser.close();
        log(`DONE (rate-limited early stop): ${totalCollected} total rows -> ${OUT_PATH}`);
        return;
      }
      if (!page.url().includes('/p/')) { seen.add(sc); continue; }
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 500));

      const d = await page.evaluate(EXTRACT_POST).catch(() => null);
      if (!d || !d.caption) { seen.add(sc); continue; }

      seen.add(sc);
      if (!inWindow(d.postdate)) continue;
      if (!looksRelevant(d.caption)) continue;
      if (!isLikelyIndonesian(d.caption)) continue;

      const line = `${idx++},${d.account || username},${d.postdate},"${esc(d.caption)}",https://www.instagram.com/p/${sc}/,${d.comments || 0},0,${d.likes || 0},-1,NaN`;
      csv.appendRows([line]);
      collected++;
      totalCollected++;
      seen.save();
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
    }

    log(`  +${collected} relevant (of ${checked} checked) from @${username} | total=${totalCollected}`);
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
  }

  await browser.close();
  seen.save();
  log(`DONE: ${totalCollected} total rows -> ${OUT_PATH}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

#!/usr/bin/env node
/**
 * Threads scraper — hashtag-page scraping (no date-range search exists on Threads,
 * so we cast a wide net across tags and let classify/merge_and_finalize.py filter
 * to 2024-06..2026-06 by parsed postdate afterward).
 * Adapted from openclaw_workspace/scrape_threads_final.js.
 */
const { firefox } = require('playwright');
const path = require('path');
const { loadCookiesForContext } = require('./lib/cookies');
const { CsvWriter, SeenSet, esc, log } = require('./lib/csv');
const { HASHTAG_KEYWORDS } = require('./lib/keywords');
const { isLikelyIndonesian } = require('./lib/locale');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'threads.json');
const OUT_PATH = path.join(__dirname, 'out', 'threads_vaccine_2024_2026.csv');
const STATE_PATH = path.join(__dirname, 'state', 'threads_seen.json');
const CSV_H = 'index,account,postdate,tweet,link,topic_tag,comments,retweets,likes,shares,replysource';
const TARGET = 4000;
const MAX_LOGIN_WALLS = 3;

async function isLoginWall(page) {
  const url = page.url();
  return url.includes('/login');
}

async function scrapeTag(page, kw, seen, perTagTarget) {
  try {
    await page.goto(`https://www.threads.com/tag/${kw}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  } catch (e) {
    return { batch: [], loginWall: false };
  }
  if (await isLoginWall(page)) return { batch: [], loginWall: true };
  await new Promise((r) => setTimeout(r, 3000));
  if (!page.url().includes('/tag/')) { log(`  tag "${kw}" not found, skipping`); return { batch: [], loginWall: false }; }

  await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  const batch = [];
  let noNewCount = 0;
  for (let s = 0; s < 60 && batch.length < perTagTarget && noNewCount < 4; s++) {
    const data = await page.evaluate(() => {
      const allLinks = [...document.querySelectorAll('a[href*="/post/"]')];
      const sid = new Set(); const res = [];
      for (const pl of allLinks) {
        let c = pl;
        for (let d = 0; d < 10; d++) {
          if (!c.parentElement) break;
          c = c.parentElement;
          if (c.querySelector('a[href*="/@"]:not([href*="/post/"])') && c.querySelector('a[href*="/post/"]') && (c.textContent?.trim().length || 0) > 80) break;
        }
        const pe = c.querySelector('a[href*="/post/"]');
        const hr = pe?.getAttribute('href') || '';
        const tid = hr.match(/\/post\/(.+)/)?.[1];
        if (!tid || sid.has(tid)) continue;
        sid.add(tid);
        const pf = c.querySelector('a[href*="/@"]:not([href*="/post/"])');
        const acct = pf?.textContent?.trim() || '';
        const link = hr.startsWith('http') ? hr : 'https://www.threads.com' + hr;
        const timeEl = c.querySelector('time');
        const postdate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '';
        const tagLink = c.querySelector('a[href*="/search?q="][role="link"]');
        const topic_tag = tagLink?.textContent?.trim() || '';
        const spans = [...c.querySelectorAll('span')].map((s) => s.textContent?.trim()).filter(Boolean);
        const tweet = spans.filter((t) => t !== acct && t !== timeEl?.textContent?.trim() && t !== topic_tag && t.length > 8 && !t.startsWith('Translate')).join(' ');
        const nums = [...c.querySelectorAll('*')].filter((x) => !x.children.length && x.textContent?.trim()).map((x) => x.textContent.trim()).filter((t) => /^[\d,.KkM+Bb]+$/.test(t));
        const cn = [];
        for (let i = 0; i < nums.length; i++) {
          if (/^\d+$/.test(nums[i]) && i + 1 < nums.length && /^\d+$/.test(nums[i + 1])) { i++; continue; }
          if (/^\d+$/.test(nums[i]) && parseInt(nums[i]) <= 20) continue;
          cn.push(nums[i]);
        }
        const pn = (s) => { if (!s) return 0; s = s.replace(/,/g, ''); if (s.includes('K')) return Math.round(parseFloat(s) * 1000); if (s.includes('M')) return Math.round(parseFloat(s) * 1000000); return parseInt(s) || 0; };
        res.push({ tweetId: tid, account: acct || 'unknown', postdate, tweet: tweet || c.textContent?.trim()?.slice(0, 1000) || '', link, topic_tag, likes: pn(cn[0]), comments: pn(cn[1]), retweets: pn(cn[2]), shares: pn(cn[3]) });
      }
      return res;
    }).catch(() => []);

    const before = batch.length;
    let sawNewId = false;
    for (const d of data) {
      if (seen.has(d.tweetId)) continue;
      seen.add(d.tweetId); // dedup only — filtered-out (non-ID) posts still count as "seen"
      sawNewId = true;
      if (!isLikelyIndonesian(d.tweet)) continue; // e.g. Malay "campak" = "throw" slang
      batch.push(d);
      if (batch.length >= perTagTarget) break;
    }
    noNewCount = sawNewId ? 0 : noNewCount + 1;
    if (batch.length >= perTagTarget) break;
    await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
    await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
  }
  return { batch, loginWall: false };
}

async function main() {
  log('=== THREADS SCRAPE START ===');
  const csv = new CsvWriter(OUT_PATH, CSV_H);
  const seen = new SeenSet(STATE_PATH); // dedup only — NOT the collected-row budget counter
  let idx = csv.rowCount() + 1;
  let totalCollected = csv.rowCount();
  log(`${HASHTAG_KEYWORDS.length} tags queued, starting at ${totalCollected} collected rows, target=${TARGET}`);

  const browser = await firefox.launch({ headless: true });
  let loginWalls = 0;

  for (let ki = 0; ki < HASHTAG_KEYWORDS.length && totalCollected < TARGET; ki++) {
    const kw = HASHTAG_KEYWORDS[ki];
    const remaining = TARGET - totalCollected;
    const perTag = Math.min(Math.ceil(remaining / (HASHTAG_KEYWORDS.length - ki)) + 20, remaining);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      viewport: { width: 1366, height: 768 },
    });
    context.addCookies(loadCookiesForContext(COOKIE_PATH));
    const page = await context.newPage();

    log(`[${ki + 1}/${HASHTAG_KEYWORDS.length}] "${kw}" target=${perTag}`);
    const { batch, loginWall } = await scrapeTag(page, kw, seen, perTag);
    await context.close();

    if (loginWall) {
      loginWalls++;
      log(`LOGIN WALL hit on tag "${kw}". (${loginWalls}/${MAX_LOGIN_WALLS})`);
      if (loginWalls >= MAX_LOGIN_WALLS) {
        log('Too many login walls — cookies likely expired/invalid. Stopping (not retrying).');
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    if (batch.length > 0) {
      const lines = batch.map((r, i) => `${idx + i},${r.account},${r.postdate},"${esc(r.tweet)}",${r.link},"${esc(r.topic_tag)}",${r.comments},${r.retweets},${r.likes},${r.shares},NaN`);
      csv.appendRows(lines);
      idx += batch.length;
      totalCollected += batch.length;
      seen.save();
    }
    log(`  +${batch.length} | total=${totalCollected}/${TARGET}`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  await browser.close();
  seen.save();
  log(`DONE: ${totalCollected} rows -> ${OUT_PATH}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

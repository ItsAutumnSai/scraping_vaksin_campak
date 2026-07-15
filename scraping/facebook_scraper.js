#!/usr/bin/env node
/**
 * Facebook scraper — real browser rendering via Playwright, not raw HTTP.
 *
 * openclaw_workspace/fb_scraper_v7.js made plain HTTP GETs to mbasic.facebook.com
 * with a hand-built Cookie header. Verified (empirically) that Facebook now serves
 * a "Facebook tidak tersedia di browser ini" (browser not supported) error page to
 * that kind of request regardless of User-Agent — the mbasic HTTP path is dead.
 * A real Playwright browser hitting the same mbasic URL gets transparently
 * redirected to web.facebook.com's modern search UI and renders real results.
 *
 * That UI has no stable data-testid/role="article" hooks (unlike X), and
 * `body.innerText` is polluted by Facebook's decoy/obfuscated characters used
 * against scraping — so extraction targets `div[dir="auto"]` text nodes directly
 * (a stable pattern FB uses for all user-generated text) and walks up the DOM to
 * find the nearest permalink/author link, rather than parsing raw HTML or full
 * page text. Permalinks are frequently unavailable (many search-result posts here
 * are inside Groups with obfuscated/tracking-param-laden URLs and no clean post
 * permalink in the DOM) — this is a real, expected limitation of this platform,
 * not a bug; rows without a resolvable link still get a synthetic id for dedup.
 *
 * Expect Facebook to be the lowest-yield, least-reliable platform of the four.
 */
const { chromium } = require('playwright');
const path = require('path');
const crypto = require('crypto');
const { loadCookiesForContext } = require('./lib/cookies');
const { CsvWriter, SeenSet, esc, log } = require('./lib/csv');
const { CORE_KEYWORDS } = require('./lib/keywords');
const { isLikelyIndonesian } = require('./lib/locale');
const { extractEarliestPostdate } = require('./lib/facebook_date');

const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'facebook.json');
const OUT_PATH = path.join(__dirname, 'out', 'facebook_vaccine_2024_2026.csv');
const STATE_PATH = path.join(__dirname, 'state', 'facebook_seen.json');
const CSV_H = 'index,account,postdate,tweet,link,comments,retweets,likes,views,replysource';
const TARGET = 3000;
const MAX_LOGIN_WALLS = 3;

const PERMALINK_RE = /story_fbid|\/posts\/|\/permalink\/|\/videos\/|\/reel\/|\/photo\/\?fbid=/;

const EXTRACT = () => {
  const blocks = [...document.querySelectorAll('div[dir="auto"]')]
    .map((el) => ({ el, text: el.textContent.trim() }))
    .filter((b) => b.text.length >= 20);

  // Drop blocks whose text is fully contained in a longer sibling block's text
  // — Facebook nests the same caption at multiple wrapper depths.
  const texts = blocks.map((b) => b.text);
  const kept = blocks.filter((b, i) => !texts.some((t, j) => j !== i && t.length > b.text.length && t.includes(b.text)));

  const seenKey = new Set();
  const out = [];
  for (const { el, text } of kept) {
    let node = el;
    let permalink = null, account = null, likes = 0;
    for (let depth = 0; depth < 12 && node; depth++) {
      if (!permalink) {
        const links = node.querySelectorAll ? [...node.querySelectorAll('a[href]')] : [];
        const pl = links.find((a) => /story_fbid|\/posts\/|\/permalink\/|\/videos\/|\/reel\/|\/photo\/\?fbid=/.test(a.getAttribute('href') || ''));
        if (pl) permalink = pl.getAttribute('href');
      }
      if (!account) {
        // "Tindakan untuk postingan oleh <name> ini" is a stable Indonesian-locale
        // accessibility label FB attaches near each post's action bar.
        const withAria = node.querySelectorAll ? [...node.querySelectorAll('[aria-label]')] : [];
        const actionLabel = withAria.find((e) => /Tindakan untuk postingan oleh/.test(e.getAttribute('aria-label') || ''));
        if (actionLabel) {
          const m = actionLabel.getAttribute('aria-label').match(/Tindakan untuk postingan oleh (.+?) ini/);
          if (m) account = m[1].trim();
        }
        if (!account) {
          const prof = node.querySelector && node.querySelector('a[role="link"][href*="facebook.com/"]');
          if (prof) {
            const t = prof.textContent.trim();
            if (t.length > 0 && t.length < 60 && t !== '#') account = t;
          }
        }
      }
      if (!likes) {
        const withAria = node.querySelectorAll ? [...node.querySelectorAll('[aria-label]')] : [];
        const likeLabel = withAria.find((e) => /^Suka:\s*[\d.,]+\s*orang/.test(e.getAttribute('aria-label') || ''));
        if (likeLabel) {
          const m = likeLabel.getAttribute('aria-label').match(/^Suka:\s*([\d.,]+)\s*orang/);
          if (m) likes = parseInt(m[1].replace(/[.,]/g, ''), 10) || 0;
        }
      }
      if (permalink && account && likes) break;
      node = node.parentElement;
    }
    const key = permalink || text.slice(0, 80);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    out.push({ text: text.slice(0, 2000), permalink, account, likes });
  }
  return out;
};

function cleanLink(href) {
  if (!href) return null;
  const noQuery = href.split('&__cft__')[0].split('?__cft__')[0];
  return noQuery.startsWith('http') ? noQuery : `https://web.facebook.com${noQuery}`;
}

function syntheticId(row) {
  if (row.permalink) return row.permalink.split('&__cft__')[0];
  return crypto.createHash('md5').update(row.text.slice(0, 120)).digest('hex');
}

async function isLoginWall(page) {
  const url = page.url();
  return url.includes('/login') || url.includes('checkpoint');
}

async function main() {
  log('=== FACEBOOK SCRAPE START (browser-rendered search) ===');
  const csv = new CsvWriter(OUT_PATH, CSV_H);
  const seen = new SeenSet(STATE_PATH); // dedup only — NOT the collected-row budget counter
  let idx = csv.rowCount() + 1;
  let totalCollected = csv.rowCount();
  log(`${CORE_KEYWORDS.length} keywords queued, starting at ${totalCollected} collected rows, target=${TARGET}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  context.addCookies(loadCookiesForContext(COOKIE_PATH));
  const page = await context.newPage();

  let loginWalls = 0;

  outer:
  for (const keyword of CORE_KEYWORDS) {
    if (totalCollected >= TARGET) break;
    log(`[${CORE_KEYWORDS.indexOf(keyword) + 1}/${CORE_KEYWORDS.length}] "${keyword}"`);

    const url = 'https://mbasic.facebook.com/search/posts/?q=' + encodeURIComponent(keyword);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (e) {
      log(`  goto error: ${e.message}`);
      continue;
    }
    if (await isLoginWall(page)) {
      loginWalls++;
      log(`  LOGIN WALL on "${keyword}". (${loginWalls}/${MAX_LOGIN_WALLS})`);
      if (loginWalls >= MAX_LOGIN_WALLS) {
        log('Too many login walls — cookies likely expired/invalid. Stopping (not retrying).');
        break outer;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise((r) => setTimeout(r, 2500));

    const collected = [];
    let noNewCount = 0;
    for (let s = 0; s < 15 && collected.length < 200 && noNewCount < 4; s++) {
      const rows = await page.evaluate(EXTRACT).catch(() => []);
      const before = collected.length;
      for (const r of rows) {
        const id = syntheticId(r);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!isLikelyIndonesian(r.text)) continue;
        collected.push({ ...r, id, link: cleanLink(r.permalink) || '' });
      }
      noNewCount = collected.length === before ? noNewCount + 1 : 0;
      await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
      await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1200));
    }

    // Search-result listing pages obfuscate timestamps character-by-character
    // (verified empirically) — the post's own permalink page exposes the real
    // date via aria-label instead, so resolve it with a second visit per row.
    for (const r of collected) {
      if (!r.link) { r.postdate = ''; continue; }
      try {
        await page.goto(r.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (await isLoginWall(page)) { r.postdate = ''; continue; }
        await new Promise((res) => setTimeout(res, 1200));
        r.postdate = (await extractEarliestPostdate(page)) || '';
      } catch (e) {
        r.postdate = '';
      }
      await new Promise((res) => setTimeout(res, 800 + Math.random() * 600));
    }

    if (collected.length > 0) {
      const lines = collected.map((r, i) => `${idx + i},"${esc(r.account || 'unknown')}","${r.postdate || ''}",` +
        `"${esc(r.text)}","${r.link}",0,0,${r.likes || 0},-1,NaN`);
      csv.appendRows(lines);
      idx += collected.length;
      totalCollected += collected.length;
      seen.save();
    }
    log(`  +${collected.length} | total=${totalCollected}/${TARGET}`);
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
  }

  await browser.close();
  seen.save();
  log(`DONE: ${totalCollected} rows -> ${OUT_PATH}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

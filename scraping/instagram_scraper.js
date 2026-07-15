#!/usr/bin/env node
/**
 * Instagram scraper — hashtag grid -> visit each post page -> extract from DOM.
 * Adapted from openclaw_workspace/scrape_instagram_working.js (the version whose
 * CSV schema actually matches old_result/instagram_vaccine.csv). Broadened date
 * window from "2025 only" to 2024-06..2026-06, proper cookie conversion, resumable
 * seen-shortcode checkpoint, login/challenge-wall detection that stops rather than
 * retries.
 */
const { chromium } = require('playwright');
const path = require('path');
const { loadCookiesForContext } = require('./lib/cookies');
const { CsvWriter, SeenSet, esc, log } = require('./lib/csv');
const { HASHTAG_KEYWORDS } = require('./lib/keywords');
const { isLikelyIndonesian } = require('./lib/locale');

// instagram.json got rate-limited (HTTP 429) by the volume of individual post
// visits this scraper does; instagram2.json is a second account added
// specifically to keep going once that happened.
const COOKIE_PATH = path.join(__dirname, '..', 'my_cookies', 'instagram2.json');
const OUT_PATH = path.join(__dirname, 'out', 'instagram_vaccine_2024_2026.csv');
const STATE_PATH = path.join(__dirname, 'state', 'instagram_seen.json');
const CSV_H = 'index,account,postdate,tweet,link,comments,retweets,likes,views,replysource';
const TARGET = 4000;
const MIN_YEAR_MONTH = '2024-06';
const MAX_YEAR_MONTH = '2026-06';

function inWindow(postdate) {
  if (!postdate) return false;
  const ym = postdate.slice(0, 7);
  return ym >= MIN_YEAR_MONTH && ym <= MAX_YEAR_MONTH;
}

const EXTRACT = () => {
  const _pn = (s) => (s == null ? 0 : (String(s).includes('K') ? Math.round(parseFloat(s) * 1000) : (String(s).includes('M') ? Math.round(parseFloat(s) * 1000000) : (parseInt(String(s).replace(/,/g, '')) || 0))));
  const out = { account: '', postdate: '', caption: '', likes: 0, comments: 0 };

  const postContainer = document.querySelector('div._ap3a');
  if (postContainer) {
    const acctLink = postContainer.querySelector('a[role="link"][href^="/"]');
    if (acctLink) {
      const h = acctLink.getAttribute('href');
      if (h && /^\/[\w.]+/.test(h)) out.account = h.replace(/[/?#].*$/, '').replace(/^\//, '');
    }
  }
  if (!out.account) {
    const acctSpan = document.querySelector('span._ap3a');
    if (acctSpan) {
      const t = acctSpan.textContent?.trim();
      if (t && t !== 'Profil' && t !== 'Profile') out.account = t;
    }
  }
  if (!out.account) {
    const skip = new Set(['reels', 'explore', 'popular', 'profile', 'profil', 'messages', 'pesan',
      'notifications', 'notifikasi', 'home', 'beranda', 'search', 'cari', 'setting', 'pengaturan',
      'lainnya', 'meta', 'professional', 'dashboard', 'dasbor', 'instagram', '']);
    const main = document.querySelector('main') || document.body;
    const links = [...main.querySelectorAll('a[role="link"][href^="/"]')]
      .filter((a) => {
        const h = (a.getAttribute('href') || '').replace(/[/?#].*$/, '').replace(/^\//, '');
        if (!h || h.includes('/')) return false;
        const t = (a.textContent || '').trim().toLowerCase();
        if (!t || t.length > 30) return false;
        return !skip.has(t) && !h.includes('explore') && !h.includes('reels');
      });
    if (links.length > 0) {
      const last = links[links.length - 1];
      out.account = last.getAttribute('href').replace(/[/?#].*$/, '').replace(/^\//, '');
    }
  }

  const te = document.querySelector('time');
  if (te) out.postdate = te.getAttribute('datetime') || te.textContent?.trim() || '';

  try {
    const scripts = [...document.querySelectorAll('script')];
    for (const s of scripts) {
      const m = s.textContent?.match(/"caption":\{"pk":"[^"]+","text":"((?:[^"\\]|\\.)*)"/);
      if (m && m[1]) {
        const caption = JSON.parse('"' + m[1] + '"');
        if (caption.length > 10) { out.caption = caption.slice(0, 2000); break; }
      }
    }
  } catch (e) {}

  if (!out.caption) {
    const meta = document.querySelector('meta[property="og:description"]');
    if (meta) {
      const content = meta.getAttribute('content') || '';
      if (content && content.length > 10 && !content.includes('Instagram photos and videos')) {
        out.caption = content.slice(0, 2000);
      }
    }
  }

  if (!out.caption) {
    let best = '', bestLen = 0;
    for (const s of document.querySelectorAll('span')) {
      let t = (s.textContent || '').trim();
      if (!t || t.length < 15) continue;
      if (/^[\d,.KkM+Bb]+$/.test(t)) continue;
      if (['Reels', 'Jelajahi', 'Profil', 'Populer', 'Beranda', 'Cari'].includes(t)) continue;
      if (t.length > bestLen && t.length < 3000) { best = t.slice(0, 2000); bestLen = t.length; }
    }
    if (best) out.caption = best;
  }

  out.caption = out.caption || '';

  const nums = [...document.querySelectorAll('span[role="button"]')]
    .map((s) => (s.textContent || '').trim())
    .filter((t) => t && /^[\d,.KkM+Bb]+$/.test(t));
  if (nums.length >= 1) out.likes = _pn(nums[0]);
  if (nums.length >= 2) out.comments = _pn(nums[1]);

  return out;
};

async function main() {
  log('=== INSTAGRAM SCRAPE START (2024-06 - 2026-06) ===');
  const csv = new CsvWriter(OUT_PATH, CSV_H);
  const seen = new SeenSet(STATE_PATH); // dedup only — NOT the collected-row budget counter
  let idx = csv.rowCount() + 1;
  let totalCollected = csv.rowCount();
  log(`${HASHTAG_KEYWORDS.length} tags queued, starting at ${totalCollected} collected rows, target=${TARGET}`);

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

  for (let ki = 0; ki < HASHTAG_KEYWORDS.length && totalCollected < TARGET; ki++) {
    const kw = HASHTAG_KEYWORDS[ki];
    const remaining = TARGET - totalCollected;
    const perKw = Math.min(Math.ceil(remaining / (HASHTAG_KEYWORDS.length - ki)), remaining);
    log(`[${ki + 1}/${HASHTAG_KEYWORDS.length}] #${kw} target=${perKw}`);

    const tagUrl = `https://www.instagram.com/explore/tags/${kw}/`;
    try { await page.goto(tagUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    catch (e) { log(`  goto error: ${e.message}`); continue; }

    const curUrl = page.url();
    if (curUrl.includes('login') || curUrl.includes('challenge') || curUrl.includes('checkpoint')) {
      log(`BLOCKED at login/challenge while visiting #${kw}. Stopping (not retrying).`);
      break;
    }

    try { await page.waitForSelector('a[href*="/p/"]', { timeout: 15000 }); }
    catch { log(`  no posts found in #${kw}`); continue; }
    await new Promise((r) => setTimeout(r, 2000));

    for (let s = 0; s < 40; s++) {
      await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
    }
    await new Promise((r) => setTimeout(r, 1500));

    const shortcodes = await page.evaluate(() => {
      const seenLocal = new Set();
      return [...document.querySelectorAll('a[href*="/p/"]')]
        .map((a) => { const m = (a.getAttribute('href') || '').match(/\/p\/([^/?#]+)/); return m ? m[1] : null; })
        .filter(Boolean)
        .filter((x) => { if (seenLocal.has(x)) return false; seenLocal.add(x); return true; });
    }).catch(() => []);

    log(`  ${shortcodes.length} shortcodes found`);

    let collected = 0;
    for (const sc of shortcodes) {
      if (collected >= perKw) break;
      if (seen.has(sc)) continue;

      try { await page.goto(`https://www.instagram.com/p/${sc}/`, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
      catch { seen.add(sc); continue; }
      if (!page.url().includes('/p/')) { seen.add(sc); continue; }
      await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 500)));

      const d = await page.evaluate(EXTRACT).catch(() => null);
      if (!d || !d.caption) { seen.add(sc); continue; }

      if (!inWindow(d.postdate)) { seen.add(sc); continue; }
      if (!isLikelyIndonesian(d.caption)) { seen.add(sc); continue; }

      seen.add(sc);
      const line = `${idx++},${d.account || 'unknown'},${d.postdate},"${esc(d.caption)}",https://www.instagram.com/p/${sc}/,${d.comments || 0},0,${d.likes || 0},-1,NaN`;
      csv.appendRows([line]);
      collected++;
      totalCollected++;
      seen.save();

      if (collected % 10 === 0) log(`    +${collected}/${perKw}`);
      await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
    }

    log(`  +${collected} from #${kw} | total=${totalCollected}/${TARGET}`);
    await new Promise((r) => setTimeout(r, 5000 + Math.floor(Math.random() * 5000)));
  }

  await browser.close();
  seen.save();
  log(`DONE: ${seen.size} shortcodes seen -> ${OUT_PATH}`);
}

main().catch((err) => { log('FATAL: ' + err.message); process.exit(1); });

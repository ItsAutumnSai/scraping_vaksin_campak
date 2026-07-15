// Runs inside the browser page (passed to page.evaluate) — must be
// self-contained with no references to outer Node.js closures. Shared between
// instagram_scraper.js (hashtag grids) and instagram_influencer_scraper.js
// (specific accounts' own post grids) — both land on the same individual post
// page shape once a shortcode is visited.
const EXTRACT_POST = () => {
  // Handles both "K"/"M" (English UI) and Indonesian "rb"/"jt" (ribu/juta)
  // suffixes, and comma-as-decimal-separator formatting ("7,2 rb" = 7200).
  const _pn = (s) => {
    if (s == null) return 0;
    s = String(s).trim();
    const mult = /jt/i.test(s) ? 1e6 : /rb/i.test(s) ? 1e3 : /M/.test(s) ? 1e6 : /K/i.test(s) ? 1e3 : 1;
    const numPart = s.replace(/[^\d,.-]/g, '');
    const normalized = mult > 1 ? numPart.replace(/\./g, '').replace(',', '.') : numPart.replace(/,/g, '');
    const n = parseFloat(normalized);
    return Number.isNaN(n) ? 0 : Math.round(n * mult);
  };
  const out = { account: '', postdate: '', caption: '', likes: 0, comments: 0, reposts: 0 };

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

  // The action bar concatenates label+count with no separator
  // (e.g. "Suka91KomentariPosting ulang15Bagikan"). Two failure modes ruled
  // out empirically: (1) an earlier version read the first two bare numbers
  // positionally, which grabbed the WRONG value whenever "Komentari" had no
  // visible count (0 comments) — the repost count shifted into the comments
  // slot; (2) anchoring on `svg[aria-label="Suka"]` directly picks up an
  // individual COMMENT's own like button instead of the post's, on any post
  // with enough comments to have one rendered before the real action bar in
  // DOM order. Only the post's own action bar has all four labels together
  // (comments only ever show Like — never Repost/Share), so anchor on that
  // full combination instead of a single button.
  const UNIT_SUFFIX = '(?:rb|jt|K(?![a-zA-Z])|M(?![a-zA-Z]))?';
  const NUM = `([\\d.,\\s]*${UNIT_SUFFIX})`;
  const actionBar = [...document.querySelectorAll('div, section')]
    .map((e) => e.textContent.trim())
    .find((t) => t.length < 200 && /(?:Suka|Like)/.test(t) && /(?:Komentari|Comment)/.test(t) && /(?:Posting ulang|Repost)/.test(t) && /(?:Bagikan|Share)/.test(t));
  if (actionBar) {
    const likeM = actionBar.match(new RegExp(`(?:Suka|Like)${NUM}`, 'i'));
    const commentM = actionBar.match(new RegExp(`(?:Komentari|Comment)${NUM}`, 'i'));
    const repostM = actionBar.match(new RegExp(`(?:Posting ulang|Repost)${NUM}`, 'i'));
    if (likeM && /\d/.test(likeM[1])) out.likes = _pn(likeM[1]);
    if (commentM && /\d/.test(commentM[1])) out.comments = _pn(commentM[1]);
    if (repostM && /\d/.test(repostM[1])) out.reposts = _pn(repostM[1]);
  }

  return out;
};

// Runs inside the page — collects post shortcodes from the current profile
// grid (call after navigating to instagram.com/<username>/ and scrolling).
const COLLECT_SHORTCODES = () => {
  const seenLocal = new Set();
  return [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
    .map((a) => { const m = (a.getAttribute('href') || '').match(/\/(?:p|reel)\/([^/?#]+)/); return m ? m[1] : null; })
    .filter(Boolean)
    .filter((x) => { if (seenLocal.has(x)) return false; seenLocal.add(x); return true; });
};

module.exports = { EXTRACT_POST, COLLECT_SHORTCODES };

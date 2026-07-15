// Runs inside the browser page (passed to page.evaluate / el.evaluate). Each
// exported function here is independently serialized by Playwright and
// executed in an isolated browser context — it must be FULLY self-contained,
// with NO reference to any other function in this file or module scope.
//
// IMPORTANT, learned the hard way: an earlier version had EXTRACT_ALL_TWEETS
// call PARSE_TWEET(el) internally to avoid duplicating the parsing logic.
// That's invalid — page.evaluate(fn) sends only fn's own source text to the
// browser; PARSE_TWEET doesn't exist there, so every call silently threw
// "ReferenceError: PARSE_TWEET is not defined", was swallowed by a
// `.catch(() => [])` at every call site, and returned an empty array. This
// went undetected through an entire scrape run — the "fixed" counts it did
// report came from unrelated per-element `elementHandle.evaluate(PARSE_TWEET)`
// calls, not EXTRACT_ALL_TWEETS. Do not "de-duplicate" these two functions
// again without changing the calling convention (e.g. moving the multi-
// element loop to the Node.js side with $$() + per-handle .evaluate()).
const PARSE_TWEET = (el) => {
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

    // NOTE: analLink.textContent is "27.7K Views" (with a trailing label), not
    // bare "27.7K" — a suffix-anchored /K$/ test silently fails on that and
    // falls through to parseFloat() reading only the leading digits (27.7),
    // rounding to 28 instead of 27700. Extract the leading number+suffix via
    // regex instead of assuming the whole string is just the number.
    const parseAbbrevNumber = (s) => {
      if (!s) return -1;
      const m = s.trim().match(/^([\d,.]+)\s*([KMB]?)/i);
      if (!m) return -1;
      const numPart = m[1].replace(/,/g, '');
      const suffix = m[2].toUpperCase();
      const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
      const n = parseFloat(numPart);
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

// Runs inside the page — collects every tweet article currently in the DOM.
// Self-contained copy of PARSE_TWEET's logic (see file-level comment above
// for why this can't just call PARSE_TWEET(el) instead).
const EXTRACT_ALL_TWEETS = () => {
  const parseOne = (el) => {
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

      // Same fix as PARSE_TWEET above: analLink text is "27.7K Views", not bare
      // "27.7K" — extract the leading number+suffix instead of anchoring the
      // suffix test to the end of the string.
      const parseAbbrevNumber = (s) => {
        if (!s) return -1;
        const m = s.trim().match(/^([\d,.]+)\s*([KMB]?)/i);
        if (!m) return -1;
        const numPart = m[1].replace(/,/g, '');
        const suffix = m[2].toUpperCase();
        const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
        const n = parseFloat(numPart);
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

  return [...document.querySelectorAll('article[data-testid="tweet"]')]
    .map((el) => parseOne(el))
    .filter(Boolean);
};

module.exports = { PARSE_TWEET, EXTRACT_ALL_TWEETS };

// Facebook truncates any long div[dir="auto"] block with an inline "Lihat
// Selengkapnya"/"See more" expand toggle — this happens on permalink pages too,
// not just search-result snippets. Playwright's own .click() silently no-ops on
// these toggles (likely an overlay/visibility quirk); a native in-page
// element.click() works reliably (verified empirically).
async function expandTruncatedText(page) {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[role="button"]')]
      .filter((e) => /lihat selengkapnya|see more/i.test(e.textContent || ''));
    for (const b of btns) b.click();
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
}

/**
 * Finds the matching block on the (already-expanded) permalink page and
 * returns its full text; falls back to the original truncated text if no
 * match is found (e.g. photo-only permalinks that don't render the caption).
 * Two things this has to work around, discovered on /reel/ permalinks (which
 * redirect off web.facebook.com to a different reels-player UI):
 *   1. The caption isn't always in a div[dir="auto"] block like regular post
 *      permalinks — on reels it's a plain <div> with no dir attribute at all.
 *      Falls back to scanning all leaf elements if the dir=auto search misses.
 *   2. The rendered text can have a leading emoji/decoration the originally
 *      scraped snippet doesn't ("🎬 YOUNG WOMAN..." vs. scraped "YOUNG
 *      WOMAN..."), so a strict startsWith() prefix match silently fails even
 *      when the right element is found — use includes() instead.
 */
async function extractFullPostText(page, truncatedText) {
  const seed = (truncatedText || '').replace(/…?\s*Lihat selengkapnya\s*$/i, '').trim().slice(0, 50);
  if (!seed) return truncatedText;
  const full = await page.evaluate((seedText) => {
    const dirAutoBlocks = [...document.querySelectorAll('div[dir="auto"]')].map((e) => e.textContent.trim());
    let match = dirAutoBlocks.find((t) => t.includes(seedText));
    if (match) return match;
    const leafBlocks = [...document.querySelectorAll('div, span, p')]
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent.trim());
    match = leafBlocks.find((t) => t.includes(seedText));
    return match || null;
  }, seed).catch(() => null);
  return full || truncatedText;
}

/**
 * Extracts visible comments from an (already-expanded) permalink page.
 * Each comment is anchored by a "Komentar oleh <Name> <N> minggu yang lalu"
 * aria-label, which is searched for a nearby (same-ancestor) date label and
 * text block. Excludes the post's own text (matched by prefix against
 * postSeedText) so it isn't double-counted as a comment.
 */
async function extractComments(page, postSeedText, maxComments = 20) {
  const seed = (postSeedText || '').replace(/…?\s*Lihat selengkapnya\s*$/i, '').trim().slice(0, 50);
  const comments = await page.evaluate(({ seedText, max }) => {
    const DATE_RE = /(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})\s+pada\s+(\d{1,2})[.:](\d{2})/i;
    const markers = [...document.querySelectorAll('[aria-label]')]
      .filter((e) => /^Komentar oleh /.test(e.getAttribute('aria-label') || ''));

    const out = [];
    for (const marker of markers) {
      if (out.length >= max) break;
      const nameMatch = marker.getAttribute('aria-label').match(/^Komentar oleh (.+?) \d+/);
      const account = nameMatch ? nameMatch[1].trim() : 'unknown';

      let node = marker, text = null, dateLabel = null;
      for (let d = 0; d < 8 && node; d++) {
        if (!text) {
          const blocks = [...(node.querySelectorAll ? node.querySelectorAll('div[dir="auto"]') : [])]
            .map((e) => e.textContent.trim())
            .filter((t) => t.length >= 3 && !(seedText && t.startsWith(seedText)));
          if (blocks.length) text = blocks.sort((a, b) => b.length - a.length)[0];
        }
        if (!dateLabel) {
          const withAria = node.querySelectorAll ? [...node.querySelectorAll('[aria-label]')] : [];
          const dl = withAria.find((e) => DATE_RE.test(e.getAttribute('aria-label') || ''));
          if (dl) dateLabel = dl.getAttribute('aria-label');
        }
        if (text && dateLabel) break;
        node = node.parentElement;
      }
      if (text) out.push({ account, text, dateLabel });
    }
    return out;
  }, { seedText: seed, max: maxComments }).catch(() => []);

  const ID_MONTHS = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };
  const DATE_RE = /(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})\s+pada\s+(\d{1,2})[.:](\d{2})/i;
  return comments.map((c) => {
    let postdate = '';
    if (c.dateLabel) {
      const m = c.dateLabel.match(DATE_RE);
      if (m) {
        const [, day, monthName, year, hour, minute] = m;
        const month = ID_MONTHS[monthName.toLowerCase()];
        const utcMillis = Date.UTC(+year, month, +day, +hour, +minute) - 7 * 60 * 60 * 1000;
        postdate = new Date(utcMillis).toISOString();
      }
    }
    return { account: c.account, text: c.text, postdate };
  });
}

/**
 * "/photo/?fbid=..." links (a lightbox overlay) never render the post's own
 * caption in expandable form — verified empirically, 0% resolve rate across a
 * real sample. The genuine post permalink ("/<page>/posts/pfbid...") is
 * discoverable via comment timestamp links on that same lightbox page. Returns
 * the canonical link if one is found and different from the current page,
 * else null.
 */
async function findCanonicalPostLink(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href*="/posts/pfbid"], a[href*="/posts/"]')]
      .map((a) => a.getAttribute('href'))
      .filter(Boolean);
    if (!links.length) return null;
    const clean = links[0].split('?')[0];
    return clean.startsWith('http') ? clean : `https://web.facebook.com${clean}`;
  }).catch(() => null);
}

/**
 * Two prior approaches to this were both wrong, verified against a real post
 * (2.9K likes / 892 comments / 627 shares, confirmed manually):
 *   1. "<Type>: N orang" aria-labels (e.g. "Suka: 7 orang") are a per-reaction
 *      PREVIEW/tooltip sample of who reacted, not the total — reading these
 *      under-reported likes by ~400x on that post (7 vs 2900).
 *   2. Counting "Komentar oleh ..." markers only counts whatever happened to
 *      be loaded in the DOM at that moment — reported 20 comments on a post
 *      that actually had 892.
 * The real totals are plain numeric text (Indonesian-formatted: comma as
 * decimal separator, "rb"/"jt" for ribu/juta i.e. thousand/million) whose
 * small ancestor container carries a clean, unambiguous aria-label: "Suka"
 * for the like-count widget, "Beri komentar" for the comment button, and
 * "Kirim ini ke teman atau posting di profil Anda." for the share button.
 */
async function extractEngagementCounts(page) {
  return page.evaluate(() => {
    const parseIdNumber = (s) => {
      if (!s) return 0;
      s = s.trim();
      const mult = /jt/i.test(s) ? 1e6 : /rb/i.test(s) ? 1e3 : 1;
      const numPart = s.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
      const n = parseFloat(numPart);
      return Number.isNaN(n) ? 0 : Math.round(n * mult);
    };
    const countNear = (targetAria) => {
      // Facebook repeats this aria-label on several nested elements — a small
      // "preview" badge (e.g. "7", a handful of recent reactors) alongside the
      // real total (e.g. "2,9 rb"), duplicated across 2+ containers. Verified
      // the true total is always the largest candidate found, so take the max
      // across every matching container rather than the first.
      const containers = [...document.querySelectorAll('[aria-label]')]
        .filter((e) => e.getAttribute('aria-label') === targetAria);
      let best = 0;
      for (const container of containers) {
        const leaves = [...container.querySelectorAll('div, span')]
          .filter((e) => e.children.length === 0 && /^[\d][\d.,]*\s?(rb|jt)?$/i.test(e.textContent.trim()));
        for (const leaf of leaves) best = Math.max(best, parseIdNumber(leaf.textContent));
      }
      return best;
    };
    const likes = countNear('Suka');
    const comments = countNear('Beri komentar');
    const shares = countNear('Kirim ini ke teman atau posting di profil Anda.');
    return { likes, comments, shares };
  }).catch(() => ({ likes: 0, comments: 0, shares: 0 }));
}

module.exports = { expandTruncatedText, extractFullPostText, extractComments, findCanonicalPostLink, extractEngagementCounts };

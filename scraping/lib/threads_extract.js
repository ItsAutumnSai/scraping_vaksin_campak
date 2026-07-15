// Runs inside the browser page (passed to page.evaluate) — must be
// self-contained with no references to outer Node.js closures. Shared between
// threads_scraper.js (hashtag tag pages) and threads_fetch_comments.js (reply
// threads on a post's own permalink page) since both list post cards linked via
// `/post/` in the same DOM shape.
//
// Engagement counts: an earlier version guessed at counts positionally (Nth
// largest number found in the post container), which broke whenever a count
// was zero (nothing rendered) or the numbers appeared in an unexpected order —
// verified empirically, ~85-98% of posts showed 0 across all four count
// columns even when real engagement existed. Each action button instead has a
// stable `svg[aria-label="Like"|"Reply"|"Repost"|"Share"]` icon whose small
// parent container's text is the label immediately followed by the count
// (e.g. "Like1.8K") — that's what's used now.
const EXTRACT_ALL_POSTS = () => {
  const parseCount = (s) => {
    if (!s) return 0;
    s = s.replace(/,/g, '');
    if (/K$/i.test(s)) return Math.round(parseFloat(s) * 1000);
    if (/M$/i.test(s)) return Math.round(parseFloat(s) * 1000000);
    return parseInt(s, 10) || 0;
  };
  const getCount = (container, label) => {
    const svg = container.querySelector(`svg[aria-label="${label}"]`);
    if (!svg) return 0;
    let node = svg;
    for (let d = 0; d < 5 && node; d++) {
      const t = node.textContent.trim();
      if (t.length > label.length && t.startsWith(label)) return parseCount(t.slice(label.length));
      node = node.parentElement;
    }
    return 0;
  };

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

    const likes = getCount(c, 'Like');
    const comments = getCount(c, 'Reply');
    const retweets = getCount(c, 'Repost');
    const shares = getCount(c, 'Share');

    res.push({ tweetId: tid, account: acct || 'unknown', postdate, tweet: tweet || c.textContent?.trim()?.slice(0, 1000) || '', link, topic_tag, likes, comments, retweets, shares });
  }
  return res;
};

module.exports = { EXTRACT_ALL_POSTS };

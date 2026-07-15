const { chromium } = require('playwright');
const path = require('path');
const { loadCookiesForContext } = require('./lib/cookies');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'Asia/Jakarta' });
  await context.addCookies(loadCookiesForContext(path.join(__dirname, '..', 'my_cookies', 'facebook.json')));
  const page = await context.newPage();
  const url = process.argv[2];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 3000));

  const before = await page.evaluate(() => document.querySelectorAll('div[dir="auto"]').length);
  console.log('dir=auto blocks before expand:', before);

  // Find "Lihat selengkapnya" clickable spans/divs and click each.
  const expandTargets = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="button"]')]
      .filter((e) => /lihat selengkapnya|see more/i.test(e.textContent || ''));
    return candidates.length;
  });
  console.log('expand buttons found:', expandTargets);

  let clicked = 0;
  for (let i = 0; i < 20; i++) {
    const handle = await page.$$('[role="button"]');
    let didClick = false;
    for (const h of handle) {
      const text = await h.textContent().catch(() => '');
      if (text && /lihat selengkapnya|see more/i.test(text)) {
        try { await h.click({ timeout: 2000 }); clicked++; didClick = true; await new Promise((r) => setTimeout(r, 400)); break; }
        catch (e) { /* stale, continue */ }
      }
    }
    if (!didClick) break;
  }
  console.log('clicked:', clicked);
  await new Promise((r) => setTimeout(r, 1000));

  const blocks = await page.evaluate(() => {
    return [...document.querySelectorAll('div[dir="auto"]')]
      .map((el) => el.textContent.trim())
      .filter((t) => t.length >= 20);
  });
  console.log('block count after expand:', blocks.length);
  blocks.forEach((b, i) => console.log(i, '::', b.slice(0, 300)));
  await browser.close();
})();

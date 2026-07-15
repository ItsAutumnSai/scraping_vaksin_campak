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

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[role="button"]')].filter((e) => /lihat selengkapnya|see more/i.test(e.textContent || ''));
    for (const b of btns) b.click();
  });
  await new Promise((r) => setTimeout(r, 1200));

  const info = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('div[dir="auto"]')]
      .map((el) => ({ el, text: el.textContent.trim() }))
      .filter((b) => b.text.length >= 5);
    return blocks.map(({ el, text }) => {
      // walk up to find a nearby aria-label mentioning a name/action
      let node = el, labels = [];
      for (let d = 0; d < 6 && node; d++) {
        const withAria = node.querySelectorAll ? [...node.querySelectorAll('[aria-label]')] : [];
        for (const w of withAria) labels.push(w.getAttribute('aria-label'));
        node = node.parentElement;
      }
      return { text: text.slice(0, 80), labels: [...new Set(labels)].slice(0, 6) };
    });
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();

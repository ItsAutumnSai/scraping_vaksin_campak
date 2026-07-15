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
  await new Promise((r) => setTimeout(r, 2500));

  const blocks = await page.evaluate(() => {
    return [...document.querySelectorAll('div[dir="auto"]')]
      .map((el) => el.textContent.trim())
      .filter((t) => t.length >= 20);
  });
  console.log('block count:', blocks.length);
  blocks.forEach((b, i) => console.log(i, '::', b.slice(0, 300)));
  await browser.close();
})();

const fs = require('fs');

const SAME_SITE_MAP = {
  no_restriction: 'None',
  unspecified: 'Lax',
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
};

/**
 * Converts a Cookie-Editor browser-extension export (array of
 * {domain, expirationDate, hostOnly, httpOnly, name, path, sameSite, secure, session, storeId, value})
 * into the shape Playwright's context.addCookies() actually validates against.
 */
function toPlaywrightCookies(rawCookies) {
  return rawCookies.map((c) => {
    const sameSiteKey = (c.sameSite || '').toString().toLowerCase();
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: SAME_SITE_MAP[sameSiteKey] || 'Lax',
    };
    if (!c.session && typeof c.expirationDate === 'number') {
      cookie.expires = Math.floor(c.expirationDate);
    }
    // sameSite=None requires secure=true or browsers reject the cookie
    if (cookie.sameSite === 'None') cookie.secure = true;
    return cookie;
  });
}

function loadCookiesForContext(cookiePath) {
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
  return toPlaywrightCookies(raw);
}

/** Raw "name=value; name2=value2" header string, for HTTP-only scrapers (e.g. Facebook mbasic). */
function loadCookieHeader(cookiePath) {
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
  return raw.map((c) => `${c.name}=${c.value}`).join('; ');
}

module.exports = { toPlaywrightCookies, loadCookiesForContext, loadCookieHeader };

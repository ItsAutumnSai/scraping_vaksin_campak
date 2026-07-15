// Facebook obfuscates timestamps character-by-character on search-result listing
// pages specifically to defeat scraping (verified empirically — no <time>, <abbr
// title>, or dateful aria-label on the search page itself). Visiting a post's own
// permalink page, however, exposes full Indonesian-formatted timestamps via
// aria-label (e.g. "Jumat, 29 Agustus 2025 pada 21.42") on reaction/comment
// elements. A permalink page has several such timestamps (the post itself, plus
// every visible comment) — since comments are always posted after the post they
// reply to, the EARLIEST timestamp found on the page is taken as the post's own
// creation time.
const ID_MONTHS = {
  januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
  juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
};

const DATE_LABEL_RE = /(\d{1,2})\s+(Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+(\d{4})\s+pada\s+(\d{1,2})[.:](\d{2})/i;

/** Parses "29 Agustus 2025 pada 21.42" (WIB / Asia-Jakarta, UTC+7) into a UTC ISO string. */
function parseIndonesianLabel(label) {
  const m = label.match(DATE_LABEL_RE);
  if (!m) return null;
  const [, day, monthName, year, hour, minute] = m;
  const month = ID_MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  // Construct as WIB (UTC+7) then convert to UTC.
  const utcMillis = Date.UTC(+year, month, +day, +hour, +minute) - 7 * 60 * 60 * 1000;
  const d = new Date(utcMillis);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Runs inside the page — collects all date-like aria-labels and returns the earliest as ISO UTC. */
async function extractEarliestPostdate(page) {
  const labels = await page.evaluate(() => {
    return [...document.querySelectorAll('[aria-label]')]
      .map((e) => e.getAttribute('aria-label'))
      .filter(Boolean);
  }).catch(() => []);

  let earliest = null;
  for (const label of labels) {
    const iso = parseIndonesianLabel(label);
    if (!iso) continue;
    if (!earliest || iso < earliest) earliest = iso;
  }
  return earliest;
}

module.exports = { parseIndonesianLabel, extractEarliestPostdate };

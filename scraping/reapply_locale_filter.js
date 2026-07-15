#!/usr/bin/env node
/**
 * Re-applies the (improved) isLikelyIndonesian filter to an already-collected
 * CSV and drops rows that now fail, re-indexing what remains. Used after
 * lib/locale.js was strengthened (added franc-based language-family rejection
 * — the original scrape-time filter let through Swahili/Japanese/English/etc.
 * noise it had no way to catch) to clean up data collected before the fix
 * without re-running the whole scrape.
 */
const fs = require('fs');
const path = require('path');
const { isLikelyIndonesian } = require('./lib/locale');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvPath = process.argv[2];
if (!csvPath) { console.error('Usage: node reapply_locale_filter.js <path-to-csv>'); process.exit(1); }

const raw = fs.readFileSync(csvPath, 'utf-8');
const table = parseCsv(raw);
const header = table[0];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const rows = table.slice(1);

const kept = rows.filter((r) => isLikelyIndonesian(r[col.tweet]));
kept.forEach((r, i) => { r[col.index] = i + 1; });

const escq = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lines = [header.join(',')];
for (const r of kept) {
  // preserve original quoting convention: only the free-text field(s) quoted
  const out = header.map((h, i) => (h === 'tweet' || h === 'account' || h === 'postdate' || h === 'topic_tag') ? escq(r[i]) : r[i]);
  lines.push(out.join(','));
}
fs.writeFileSync(csvPath, lines.join('\n') + '\n');
console.log(`${csvPath}: ${rows.length} -> ${kept.length} rows (dropped ${rows.length - kept.length})`);

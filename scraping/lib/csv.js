const fs = require('fs');
const path = require('path');

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ').trim();
}

/** field(v) quotes only when needed-ish; we just always quote free-text fields via esc() at call sites. */
function quoted(v) {
  return `"${esc(v)}"`;
}

class CsvWriter {
  constructor(filePath, header) {
    this.filePath = filePath;
    this.header = header;
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, header + '\n');
    }
  }
  appendRows(lines) {
    if (!lines.length) return;
    fs.appendFileSync(this.filePath, lines.join('\n') + '\n');
  }
  rowCount() {
    if (!fs.existsSync(this.filePath)) return 0;
    const n = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean).length;
    return Math.max(0, n - 1);
  }
}

/** Resumable "seen id" checkpoint, persisted to disk after every save() call. */
class SeenSet {
  constructor(statePath) {
    this.statePath = statePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    this.set = new Set(fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf-8')) : []);
  }
  has(id) { return this.set.has(id); }
  add(id) { this.set.add(id); }
  get size() { return this.set.size; }
  save() { fs.writeFileSync(this.statePath, JSON.stringify([...this.set])); }
}

/**
 * Splits [startDate, endDate) into half-month {since, until} chunks (YYYY-MM-DD),
 * used for date-bounded search scraping (X). endDate is exclusive.
 */
function halfMonthRanges(startYear, startMonth, endYear, endMonth) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ranges = [];
  let y = startYear, m = startMonth; // m is 0-indexed
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const s1 = new Date(y, m, 1);
    const e1 = new Date(y, m, 15);
    const s2 = new Date(y, m, 16);
    const e2 = new Date(y, m + 1, 0);
    ranges.push({ since: fmt(s1), until: fmt(e1) });
    ranges.push({ since: fmt(s2), until: fmt(e2) });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return ranges;
}

const T = () => new Date().toISOString().slice(11, 19);
const log = (m) => process.stdout.write(`[${T()}] ${m}\n`);

module.exports = { esc, quoted, CsvWriter, SeenSet, halfMonthRanges, log };

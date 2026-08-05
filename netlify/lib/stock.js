// VSG — server-side stock report parsing.
//
// This does exactly what the page used to do in the browser: find the sheet
// whose header row contains MATERIAL or LOT #, then sheet_to_json with
// header:1. Same library, same version, same options — so the row arrays it
// produces are byte-for-byte what parseStockRows() already expects.
//
// The reason it moved here is pricing. The .xlsx carries PRICE1 through PRICE4
// (Retail, Trade, Bundle, Wholesale) in every row, so serving the raw file
// handed every anonymous visitor the full wholesale price list. Parsing here
// means the columns a caller is not entitled to never leave the server.

import * as XLSX from 'xlsx';
import { driveList, driveReadBytes, STOCK_FOLDER_ID } from './google.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Cached across warm invocations, keyed on the Drive file's modifiedTime so a
// new report is picked up immediately. Parsing is the expensive part.
let _cache = null; // { key, rows, file }

/** Locate the newest stock report in the Stock folder. */
async function newestReport() {
  const files = await driveList(STOCK_FOLDER_ID, `mimeType='${XLSX_MIME}'`);
  const reports = files
    .filter(f => /ListedReport|GrouppedReport/i.test(f.name))
    .filter(f => !f.name.startsWith('~$'))
    .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
  return reports[0] || null;
}

/**
 * The stock report as an array of row arrays, exactly as the browser produced
 * it. Returns { rows, file } or null if no usable report exists.
 */
export async function getStockRows() {
  const file = await newestReport();
  if (!file) return null;

  const key = `${file.id}:${file.modifiedTime}`;
  if (_cache && _cache.key === key) return { rows: _cache.rows, file: _cache.file };

  const bytes = await driveReadBytes(file.id);
  // A truncated file is worse than none — it would render a partial catalogue.
  if (bytes.length < 10_000) throw new Error('Stock file looks incomplete');

  const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });

  // Sheet detection, identical to the page's: the first sheet whose first row
  // contains MATERIAL or LOT #, falling back to the first sheet.
  let ws = null;
  for (const name of wb.SheetNames) {
    const candidate = wb.Sheets[name];
    const probe = XLSX.utils.sheet_to_json(candidate, { header: 1, range: 0 });
    const header = (probe[0] || []).map(c => String(c || '').toUpperCase());
    if (header.includes('MATERIAL') || header.includes('LOT #')) { ws = candidate; break; }
  }
  if (!ws) ws = wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (!rows || rows.length < 2) throw new Error('Stock sheet has no data rows');

  // SheetJS returns sparse arrays for blank cells. JSON.stringify turns those
  // holes into null, where the browser saw undefined — so a cell that read as
  // '' in the page would arrive as the string "null" for any caller doing
  // String(cell) without a fallback. parseStockRows happens to use
  // String(x||'') everywhere, but shipping a gratuitous difference between the
  // two parses invites a subtle bug later. Densify to '' instead.
  const dense = rows.map(row => {
    const out = new Array(row.length);
    for (let i = 0; i < row.length; i++) {
      out[i] = (row[i] === undefined || row[i] === null) ? '' : row[i];
    }
    return out;
  });

  _cache = { key, rows: dense, file };
  return { rows: dense, file };
}

/**
 * Column indexes of the four price columns, read from the header row.
 * Matched exactly as parseStockRows does, so a renamed column degrades the
 * same way in both places rather than silently exposing a price.
 */
export function priceColumns(rows) {
  const header = (rows[0] || []).map(c => String(c || '').trim().toUpperCase());
  const out = {};
  header.forEach((c, i) => {
    if (c === 'PRICE1') out.price1 = i;
    if (c === 'PRICE2') out.price2 = i;
    if (c === 'PRICE3') out.price3 = i;
    if (c === 'PRICE4') out.price4 = i;
  });
  return out;
}

/**
 * Indexes of every column this module would blank for a caller entitled to
 * `keep`. Exported so the comparison harness can account for them rather than
 * reporting each one as an unexplained difference.
 */
export function strippedColumns(rows, keep) {
  const header = (rows[0] || []).map(c => String(c || '').trim().toUpperCase());
  const cols = priceColumns(rows);
  const keepIdx = new Set(keep.map(name => cols[name]).filter(i => i !== undefined));
  const strip = [];
  header.forEach((cell, i) => {
    if (/PRICE|COST|RATE|\$/.test(cell) && !keepIdx.has(i)) strip.push(i);
  });
  return strip;
}

/**
 * Copy the rows, blanking every price column except those named in `keep`.
 *
 * Fails closed: any column whose header merely looks like a price is blanked
 * unless it is explicitly kept. Matching only the exact PRICE1..PRICE4 names
 * would mean a renamed or added column in a future Vavastone report passed
 * straight through to anonymous visitors — the values would sit in the JSON
 * even though parseStockRows would not display them. That rule is what caught
 * the COST column, which is not one of the four tiers and was being served to
 * every visitor.
 *
 * Blanks rather than removes: parseStockRows locates prices by header position,
 * so dropping a column would shift every column after it. An empty cell parses
 * to 0 exactly as a genuinely empty price already does.
 */
export function withPrices(rows, keep) {
  const strip = strippedColumns(rows, keep);
  if (!strip.length) return rows;

  return rows.map((row, i) => {
    if (i === 0) return row;            // header row stays intact
    const copy = row.slice();
    for (const idx of strip) if (idx < copy.length) copy[idx] = '';
    return copy;
  });
}

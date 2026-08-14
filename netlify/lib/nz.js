// VSG — NZ Direct Stock: sheet access, row parsing, slug resolution.
//
// Slabs shipped direct to New Zealand. Not in Vavastone — a manually
// maintained Google Sheet is the source of truth, edited by internal staff.
//
// NOTE ON FOLDER IDs: these live here rather than in google.js because they are
// NZ-specific and used only by this module and its two functions. Verified
// against Drive 14 Aug 2026. If one stops working, open the folder in Drive and
// copy the ID from the URL — never trust a documented ID.

import { getAccessToken, driveList, driveReadText, driveFindFile, READONLY_SCOPE, STOCK_FOLDER_ID }
  from './google.js';

export const NZ_PARENT_FOLDER_ID  = '1j76jC4J_mev0P54CdjW0-6OAL48w-MIY'; // NZ transit and local stock
export const NZ_SHEET_ID          = '1sHAqoj0KcB57KryRF2aYQVh5s_tgj60xFe1adTuc0W0';
export const NZ_SLABS_FOLDER_ID   = '1XfjCFju1s6oLYb-qawdHIvP8q7TxHPFt';
export const NZ_RENDERS_FOLDER_ID = '1aIqrTCIdC258sRDRXJpMZZvxx4m8Q4E_';

const SHEET_TAB = 'Stock';
const SHEET_RANGE = `${SHEET_TAB}!A:M`;

// A lot is NZ followed by digits, optionally with a -N bundle suffix:
// NZ82925 or NZ82925-1. One lot number can cover several bundles, which is how
// the stone is actually numbered, so the suffix has to be supported.
//
// Matching therefore CANNOT split names on '-' and test segment membership —
// "NZ82925-1" would split into "nz82925" and "1" and never match. Everything
// below searches for this pattern within the name instead.
export const LOT_RE = /^NZ\d+(?:-\d+)?$/i;

// Same pattern, unanchored, for pulling a lot out of a filename or folder name.
const LOT_IN_NAME = /NZ\d+(?:-\d+)?/i;

// Rows in these states never reach the browser at all — not hidden client-side.
const OFF_SITE = new Set(['sold', 'hidden']);

// ── Sheet reading ─────────────────────────────────────────────
// The Sheets API, not driveReadText(). A native Google Sheet has no binary
// content, so Drive's alt=media returns 403; and Drive's CSV export only ever
// returns the FIRST tab, which here is the README. An explicit range is the
// only approach that reliably reads the right tab.
//
// drive.readonly (already requested by google.js) is an accepted scope for
// Sheets reads, so no new scope or environment variable is needed.

export async function readSheetRows() {
  const token = await getAccessToken(READONLY_SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${NZ_SHEET_ID}` +
              `/values/${encodeURIComponent(SHEET_RANGE)}` +
              `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE` +
              `&dateTimeRenderOption=FORMATTED_STRING`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Sheet read failed (${resp.status})`);
  const data = await resp.json();
  return data.values || [];
}

// ── Date handling ─────────────────────────────────────────────
// ETA is DD-MM-YYYY by decision (AU/NZ convention — what the maintainer types).
// Parsed explicitly: 24-09-2026 and 09-24-2026 are indistinguishable to a
// generic date library, and a mis-parse yields a plausible WRONG date rather
// than an error. Day first, always.
//
// If the sheet locale is set to Australia/New Zealand the cell may be a real
// date and arrive as a serial number instead — handled first.

const SHEET_EPOCH = Date.UTC(1899, 11, 30);

export function parseEta(value) {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' && isFinite(value)) {
    const d = new Date(SHEET_EPOCH + Math.round(value) * 86400000);
    return isNaN(d) ? null : d;
  }

  const s = String(value).trim();
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    return isNaN(d) ? null : d;
  }
  // ISO fallback, in case a cell was entered or converted the other way.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return isNaN(d) ? null : d;
  }
  return null;
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

/**
 * Soft arrival window. A named day invites a complaint when the vessel slips;
 * "late September 2026" stays true across a week of movement. Mirrors the
 * fuzzy-window behaviour already used for Melbourne transit stock.
 */
export function etaWindow(date) {
  if (!date) return null;
  const d = date.getUTCDate();
  const part = d <= 10 ? 'Early' : d <= 20 ? 'Mid' : 'Late';
  return `${part} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// ── Availability ──────────────────────────────────────────────
// Branch on Status FIRST, then ETA. Status is a statement of fact; ETA is a
// detail. A missing detail must never override a stated fact — an On Water slab
// with no ETA is still shipped, and showing "Available to order" would be
// untrue as well as commercially weaker.

export function availability(statusRaw, eta) {
  const status = String(statusRaw || '').trim().toLowerCase();

  if (status === 'in stock nz') {
    return { state: 'in_stock', label: 'In stock — New Zealand', order: 0 };
  }
  if (status === 'on water') {
    const w = etaWindow(eta);
    // Lowercase only the qualifier — "Arriving late September 2026". Lowercasing
    // the whole window would also flatten the month name.
    return w
      ? { state: 'on_water', label: `Arriving ${w.charAt(0).toLowerCase()}${w.slice(1)}`, order: 1 }
      : { state: 'on_water', label: 'On the water — ETA TBC', order: 1, flag: 'on_water_no_eta' };
  }
  if (status === 'available to order') {
    return {
      state: 'to_order',
      label: 'Available to order',
      order: 2,
      ...(eta ? { flag: 'to_order_has_eta' } : {}),
    };
  }
  return null; // unknown status — treated as off-site by parseRows()
}

// ── Row parsing ───────────────────────────────────────────────
// Mapped by HEADER NAME, not column position. The README forbids reordering
// columns, but a header lookup fails loudly on a rename instead of silently
// reading prices out of the Notes column.

function headerIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) idx[key] = i;
  });
  const need = (label, ...aliases) => {
    for (const a of [label, ...aliases]) if (a in idx) return idx[a];
    return -1;
  };
  return {
    lot:       need('lot'),
    name:      need('stone name'),
    category:  need('category', 'material'),
    finish:    need('finish'),
    thickness: need('thickness (mm)'),
    width:     need('width (mm)'),
    height:    need('height (mm)'),
    qty:       need('qty (slabs)'),
    status:    need('status'),
    eta:       need('eta (dd-mm-yyyy)', 'eta (yyyy-mm-dd)', 'eta'),
    price:     need('price (per m2)', 'price'),
    currency:  need('currency'),
    notes:     need('notes'),
  };
}

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
};

/**
 * Turn raw sheet values into stock objects. Never returns Sold, Hidden, or
 * unrecognised-status rows. `warnings` is for the operator, not the customer.
 */
export function parseRows(values) {
  const warnings = [];
  if (!values.length) return { stones: [], warnings: ['Sheet is empty'] };

  const col = headerIndex(values[0]);
  if (col.lot < 0 || col.status < 0) {
    return { stones: [], warnings: ['Header row not recognised — has a column been renamed?'] };
  }

  const stones = [];
  const seen = new Set();

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;

    const lot = String(row[col.lot] ?? '').trim().toUpperCase();
    if (!lot) continue;

    // Example rows ship with the template and must never reach a customer.
    const notes = String(row[col.notes] ?? '').trim();
    if (/^EXAMPLE ROW/i.test(notes)) continue;

    if (!LOT_RE.test(lot)) {
      warnings.push(`Row ${r + 1}: lot "${lot}" is not NZ#### — hyphens break photo matching`);
      continue;
    }
    if (seen.has(lot)) { warnings.push(`Row ${r + 1}: duplicate lot ${lot}`); continue; }
    seen.add(lot);

    const statusRaw = String(row[col.status] ?? '').trim();
    if (OFF_SITE.has(statusRaw.toLowerCase())) continue;

    const eta = parseEta(row[col.eta]);
    const avail = availability(statusRaw, eta);
    if (!avail) {
      warnings.push(`Row ${r + 1} (${lot}): unrecognised status "${statusRaw}" — row skipped`);
      continue;
    }
    if (avail.flag === 'on_water_no_eta') warnings.push(`${lot}: On Water with no ETA`);
    if (avail.flag === 'to_order_has_eta') warnings.push(`${lot}: Available to Order but ETA is filled`);

    const width = num(row[col.width]);
    const height = num(row[col.height]);

    stones.push({
      lot,
      name: String(row[col.name] ?? '').trim(),
      category: String(row[col.category] ?? '').trim(),
      finish: String(row[col.finish] ?? '').trim(),
      thickness: num(row[col.thickness]),
      width, height,
      qty: num(row[col.qty]),
      area: width && height ? +((width * height) / 1e6).toFixed(2) : null,
      status: statusRaw,
      state: avail.state,
      availability: avail.label,
      eta: eta ? eta.toISOString().slice(0, 10) : null,
      notes,
      _order: avail.order,
      // Price is attached later, and only when entitled.
      _price: num(row[col.price]),
      _currency: String(row[col.currency] ?? '').trim().toUpperCase() || null,
    });
  }

  // Most-available first: In Stock NZ, then On Water, then Available to Order.
  // Within On Water, soonest arrival leads and undated rows fall to the back —
  // a slab with no ETA is the least useful thing to show a customer first.
  stones.sort((a, b) =>
    a._order - b._order ||
    (a.state === 'on_water' ? (a.eta || '9999').localeCompare(b.eta || '9999') : 0) ||
    a.name.localeCompare(b.name));
  return { stones, warnings };
}

// ── Photos and renders ────────────────────────────────────────
// Lot extracted by REGEX over hyphen-separated segments, never by position —
// a stone name containing a hyphen would break positional parsing, and the
// regex is self-validating: a file that yields no match is a naming error worth
// reporting rather than a silent mis-file.

export function lotFromFilename(filename) {
  const base = String(filename).replace(/\.[^.]+$/, '');
  const m = base.match(LOT_IN_NAME);
  return m ? m[0].toUpperCase() : null;
}

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

let _slabCache = null;   // { at, map: Map<lot, {id,name}> }
let _renderCache = null; // { at, map: Map<lot, [{id,name}]> }
const CACHE_MS = 5 * 60 * 1000;

/** lot -> slab photo. Newest wins when a lot has more than one. */
export async function slabPhotoMap() {
  if (_slabCache && Date.now() - _slabCache.at < CACHE_MS) return _slabCache.map;

  const files = await driveList(NZ_SLABS_FOLDER_ID);
  const map = new Map();
  const dupes = [];
  for (const f of files) {
    if (!IMAGE_EXT.test(f.name)) continue;
    const lot = lotFromFilename(f.name);
    if (!lot) continue;
    const prev = map.get(lot);
    if (prev) {
      dupes.push(lot);
      if ((f.modifiedTime || '') <= (prev.modifiedTime || '')) continue;
    }
    map.set(lot, f);
  }
  map._dupes = dupes;
  _slabCache = { at: Date.now(), map };
  return map;
}

/** lot -> render images, from Renders/<LOT>/ subfolders. */
export async function renderMap() {
  if (_renderCache && Date.now() - _renderCache.at < CACHE_MS) return _renderCache.map;

  const folders = await driveList(
    NZ_RENDERS_FOLDER_ID, "mimeType='application/vnd.google-apps.folder'");
  const map = new Map();

  await Promise.all(folders.map(async (folder) => {
    // Folder may be the bare lot (NZ1001) or follow the StoneName-Lot-VSG
    // convention StoneRender writes for Melbourne stock. Accept both.
    const lot = lotFromFilename(folder.name);
    if (!lot) return;
    const kids = await driveList(folder.id);
    const imgs = kids.filter(k => IMAGE_EXT.test(k.name))
                     .sort((a, b) => a.name.localeCompare(b.name));
    if (imgs.length) map.set(lot, imgs);
  }));

  _renderCache = { at: Date.now(), map };
  return map;
}

// ── Slug resolution ───────────────────────────────────────────
// Per-customer URL: /nz-<customer>-<token>. The slug identifies WHICH customer
// and grants access to the stock LIST. It is NOT authentication and must never
// unlock prices — a URL sitting in a forwarded email is not a credential.
//
// Mapping lives in clients.json as `directSlug`. Revoking one customer means
// clearing that one field; no other customer is affected and no rotation is
// needed. That is why a per-customer token was chosen over a shared secret.

let _clientsCache = null;
const CLIENTS_CACHE_MS = 60 * 1000;

export async function loadClients() {
  if (_clientsCache && Date.now() - _clientsCache.at < CLIENTS_CACHE_MS) return _clientsCache.list;
  const file = await driveFindFile(STOCK_FOLDER_ID, 'clients.json');
  if (!file) throw new Error('clients.json not found');
  const data = JSON.parse(await driveReadText(file.id));
  const list = Array.isArray(data) ? data : (data.clients || []);
  _clientsCache = { at: Date.now(), list };
  return list;
}

const normSlug = s => String(s || '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');

/** Resolve a slug to its client. Returns null if unknown or revoked. */
export async function clientForSlug(slug) {
  const want = normSlug(slug);
  if (!want) return null;
  const list = await loadClients();
  return list.find(c => c.directSlug && normSlug(c.directSlug) === want && c.directAccess) || null;
}

const VALID_TIERS = new Set(['price1', 'price2', 'price3', 'price4']);

/** Direct-stock tier for a client. Falls back to their Melbourne tier. */
export function directTierFor(client) {
  const t = client && (client.directTier || client.tier);
  return VALID_TIERS.has(t) ? t : 'price1';
}

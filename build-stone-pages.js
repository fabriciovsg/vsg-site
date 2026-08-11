// VSG Stone Pages Generator
// Runs in the Netlify build AFTER build-images.js (needs image-manifest-cdn.json).
// Emits: /stone/<slug>/index.html for every in-stock variety + 13 legacy pages,
//        /catalogue/index.html (variety index grouped by material),
//        _redirects (WP URL map with exact per-product rules), sitemap.xml.
//
// VISIBILITY: this script applies the same admin rules as the live gallery,
// read fresh from vsg-site-config.json each build — hiddenLots excluded,
// transit lots only if curated in visibleTransitLots (shown as a soft ETA
// window, never a count), slab QUANTITIES suppressed while slabDisplay is
// "hide", and unphotographed varieties kept out of the catalogue while
// hideNoPhoto is on. If an admin setting changes, the pages follow at the
// next build (3x daily).
//
// LOCAL DEV: if ./dev-data/ contains report.xlsx + vsg-site-config.json it
// runs fully offline; otherwise it fetches both from the Stock Drive folder
// with the same service-account env vars build-images.js uses.

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import * as XLSX from 'xlsx';

const SA_EMAIL = process.env.VSG_SERVICE_ACCOUNT_EMAIL;
const KEY_ID   = process.env.VSG_PRIVATE_KEY_ID;
const RAW_KEY  = (process.env.VSG_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const STOCK_FOLDER_ID = '1BtszKasn-t-haVTX7JzUWTPhuriZsCCq';
const SITE = 'https://victoriastonegallery.com.au';
const CWD = process.cwd();
const DEV_DIR = path.join(CWD, 'dev-data');
const PAGES_CONFIG = JSON.parse(fs.readFileSync(path.join(CWD, 'stone-pages-config.json'), 'utf8'));
const DESCRIPTIONS = JSON.parse(fs.readFileSync(path.join(CWD, 'stone-descriptions.json'), 'utf8'));
const BANNED = PAGES_CONFIG.bannedTerms || [];

const MAT_SLUG = { Granite:'granite', Marble:'marble', Quartzite:'quartzite', Dolomite:'dolomite', Travertine:'travertine', Limestone:'limestone', Onyx:'onyx' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── helpers ──────────────────────────────────────────────────
const slugify = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .replace(/['\u2018\u2019]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
const cleanVarietyName = n => n.trim().replace(/\s+\d+\s*(?:cm|mm)$/i,'');
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Lot ids sometimes embed the finish ("10825 HONED"); trim for display only —
// the raw id stays as the manifest/image key.
const displayLot = lot => lot.replace(/\s+(HONED|POLISHED|LEATHER|BRUSHED)$/i,'').trim();
const normThickness = t => { const n = parseFloat(t)||0; return n>0 && n<10 ? Math.round(n*10) : Math.round(n); }; // Vavastone mixes cm and mm

// Same soft ETA window the gallery uses: +10 day slip buffer, then Early/Mid/Late.
function etaWindow(raw){
  const m = String(raw||'').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
  dt.setUTCDate(dt.getUTCDate()+10);
  const d = dt.getUTCDate();
  return `${d<=10?'Early':d<=20?'Mid':'Late'} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

// ── data loading ─────────────────────────────────────────────
async function loadData(){
  const devReport = fs.existsSync(DEV_DIR) && fs.readdirSync(DEV_DIR).find(f=>/\.xlsx$/i.test(f));
  if (devReport){
    console.log('Stone pages: DEV mode (local dev-data/)');
    return {
      wb: XLSX.read(fs.readFileSync(path.join(DEV_DIR, devReport))),
      cms: JSON.parse(fs.readFileSync(path.join(DEV_DIR,'vsg-site-config.json'),'utf8')),
    };
  }
  if(!SA_EMAIL || !RAW_KEY){ console.error('Stone pages: missing service-account env vars'); process.exit(1); }
  const token = await getAccessToken();
  const list = await driveGet(`https://www.googleapis.com/drive/v3/files?q='${STOCK_FOLDER_ID}'+in+parents+and+trashed=false+and+name+contains+'ListedReport'&orderBy=modifiedTime desc&pageSize=1&fields=files(id,name)`, token);
  if(!list.files?.length){ console.error('Stone pages: no ListedReport in Stock folder'); process.exit(1); }
  console.log(`Stone pages: stock source ${list.files[0].name}`);
  const xls = await driveGetBuffer(`https://www.googleapis.com/drive/v3/files/${list.files[0].id}?alt=media`, token);
  const cfgList = await driveGet(`https://www.googleapis.com/drive/v3/files?q='${STOCK_FOLDER_ID}'+in+parents+and+name='vsg-site-config.json'+and+trashed=false&fields=files(id)`, token);
  const cms = cfgList.files?.length
    ? JSON.parse(await driveGet(`https://www.googleapis.com/drive/v3/files/${cfgList.files[0].id}?alt=media`, token, true))
    : {};
  return { wb: XLSX.read(xls), cms };
}

// ── stock aggregation with the gallery's visibility rules ────
function aggregate(wb, cms){
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
  const hdr = rows[0].map(h=>String(h||'').trim());
  const ix = Object.fromEntries(hdr.map((h,i)=>[h,i]));
  const need = ['LOCATION','MATERIAL','CATEGORY','LOT #','STATUS','FININSHING','THICKNESS','SELL WIDTH','SELL HEIGHT','AVAILABLE'];
  for(const h of need) if(!(h in ix)){ console.error(`Stone pages: column "${h}" missing from stock report — header changed?`); process.exit(1); }

  // Location filter — same rule as the gallery. SYD (a pending consignment)
  // is deliberately excluded in the site config; the generator must not
  // resurrect it. Empty/missing config falls back to including everything,
  // with a loud warning, rather than silently guessing a location list.
  const enabled = new Set(cms.enabledLocations||[]);
  if(!enabled.size) console.warn('Stone pages: enabledLocations missing from config — including ALL locations');
  const hidden = new Set((cms.hiddenLots||[]).map(String));
  const transitVisible = new Set((cms.visibleTransitLots||[]).map(String));
  const anomalies = [];
  const varieties = new Map();

  for(const r of rows.slice(1)){
    const raw = String(r[ix['MATERIAL']]||'').trim();
    if(!raw) continue;
    const name = cleanVarietyName(raw);
    const lot = String(r[ix['LOT #']]||'').trim();
    const status = String(r[ix['STATUS']]||'').trim();
    const loc = String(r[ix['LOCATION']]||'').trim();
    if(enabled.size && !enabled.has(loc)) continue;            // admin: disabled location
    if(hidden.has(lot)) continue;                                   // admin: hidden lot
    if(status==='TRANSIT' && !transitVisible.has(lot)) continue;    // admin: uncurated transit
    if(status!=='AVAILABLE' && status!=='TRANSIT') continue;

    if(!varieties.has(name)) varieties.set(name, { name, cats:new Set(), lots:new Map(), transitEtas:[] });
    const v = varieties.get(name);
    const cat = String(r[ix['CATEGORY']]||'').trim();
    if(cat) v.cats.add(cat);
    const th = normThickness(r[ix['THICKNESS']]);
    if(parseFloat(r[ix['THICKNESS']])>0 && parseFloat(r[ix['THICKNESS']])<10)
      anomalies.push(`thickness in cm not mm: ${name} lot ${lot}`);
    if(!v.lots.has(lot)) v.lots.set(lot, { lot, slabs:0, w:0, h:0, fin:'', th, status });
    const L = v.lots.get(lot);
    L.slabs++;
    L.w = Math.max(L.w, (parseFloat(r[ix['SELL WIDTH']])||0)*10);
    L.h = Math.max(L.h, (parseFloat(r[ix['SELL HEIGHT']])||0)*10);
    L.fin = String(r[ix['FININSHING']]||'').trim() || L.fin;
    if(status==='TRANSIT'){ const w = etaWindow(r[ix['AVAILABLE']]); if(w) v.transitEtas.push(w); }
  }

  for(const v of varieties.values()){
    v.cats = [...v.cats].filter(c=>c && c!=='Natural');
    if(v.cats.length>1) anomalies.push(`multi-category in Vavastone: ${v.name} → ${v.cats.join(', ')}`);
    v.material = PAGES_CONFIG.materialOverrides?.[v.name] || v.cats[0] || '';
  }
  return { varieties, anomalies };
}

// ── page shell ───────────────────────────────────────────────
function shell({ title, description, canonical, jsonld, body }){
  // Chrome (topbar, nav, footer, logo symbol, hamburger) is lifted VERBATIM
  // from the site's own pages so generated pages are indistinguishable from
  // hand-built ones. If the site nav changes, re-harvest these blocks — they
  // are the one thing here that can drift from the rest of the site.
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/stone/stone-pages.css">
<link rel="stylesheet" href="/assets/vsg-theme.css">
<!-- Google Analytics (GA4) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-02BVBJPVRQ"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","G-02BVBJPVRQ");</script>
${jsonld?`<script type="application/ld+json">${jsonld}</script>`:''}
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="vsgLogo" viewBox="0 0 2880 528"><g transform="translate(0.000000,528.000000) scale(0.100000,-0.100000)"
fill="currentColor" stroke="none">
<path d="M67 5254 c-3 -3 16 -43 43 -87 26 -45 57 -98 68 -117 11 -19 60 -105
109 -190 50 -85 125 -216 168 -290 43 -74 97 -168 121 -207 24 -40 44 -75 44
-77 0 -3 22 -41 50 -86 27 -45 50 -83 50 -86 0 -2 20 -37 44 -77 37 -61 79
-134 177 -304 11 -18 27 -48 38 -65 57 -100 457 -792 481 -833 10 -16 41 -70
70 -120 29 -49 61 -105 71 -122 11 -18 27 -48 38 -65 23 -42 158 -273 181
-313 89 -153 120 -207 120 -210 0 -2 22 -40 50 -85 27 -45 50 -83 50 -86 0 -2
20 -37 44 -77 24 -39 78 -133 121 -207 43 -74 85 -148 95 -165 87 -149 168
-289 193 -335 16 -30 33 -59 38 -65 4 -5 40 -66 79 -135 40 -69 81 -140 91
-157 11 -18 27 -48 38 -65 10 -18 42 -73 71 -123 29 -49 64 -110 78 -135 13
-25 34 -61 46 -80 26 -43 43 -72 80 -138 l29 -52 3275 2 3275 3 135 235 c74
129 146 255 159 280 14 25 47 81 73 125 26 44 59 100 72 125 14 25 112 196
218 380 106 184 204 355 218 380 13 25 46 81 72 125 26 44 59 100 73 125 13
25 129 227 257 450 128 223 246 430 263 460 16 30 33 60 37 65 4 6 17 26 28
45 20 36 115 202 157 275 24 42 233 405 268 465 11 19 33 60 50 90 17 30 38
67 49 82 10 14 18 29 18 32 0 3 14 29 31 58 34 56 56 95 90 156 12 20 25 42
29 47 4 6 21 35 37 65 17 30 72 127 123 215 51 88 104 180 118 205 14 25 50
88 80 140 191 329 292 509 292 519 0 17 -278 15 -321 -3 -51 -21 -57 -31 -299
-456 -20 -36 -133 -231 -250 -435 -117 -203 -226 -395 -243 -425 -16 -30 -33
-59 -37 -65 -4 -5 -17 -27 -29 -48 -12 -20 -31 -54 -43 -75 -12 -20 -38 -66
-58 -102 -20 -36 -46 -82 -58 -102 -12 -21 -30 -53 -41 -70 -10 -18 -51 -89
-91 -158 -40 -69 -86 -150 -103 -180 -16 -30 -38 -67 -49 -82 -10 -14 -18 -28
-18 -31 0 -3 -41 -76 -91 -163 -50 -88 -100 -175 -111 -194 -11 -19 -24 -39
-28 -45 -4 -5 -21 -35 -37 -65 -17 -30 -117 -206 -223 -390 -106 -184 -201
-351 -212 -370 -11 -19 -42 -72 -69 -118 -27 -45 -49 -84 -49 -86 0 -2 -18
-34 -40 -70 -22 -36 -40 -68 -40 -72 0 -3 -8 -18 -18 -32 -11 -15 -33 -52 -49
-82 -25 -44 -138 -243 -274 -477 -11 -18 -28 -49 -39 -69 -11 -19 -27 -45 -34
-57 -8 -12 -23 -38 -33 -57 -79 -147 -117 -201 -157 -225 l-43 -25 -536 0
c-549 0 -561 1 -528 35 5 6 42 66 81 135 40 69 82 141 93 160 11 19 33 60 50
90 17 30 38 67 49 82 10 14 18 29 18 33 0 4 8 19 18 33 11 15 33 52 49 82 17
30 63 111 103 180 102 176 306 530 600 1040 81 140 198 343 260 450 62 107
126 220 143 250 17 30 48 84 69 119 21 34 38 65 38 68 0 3 8 17 18 31 11 15
33 52 49 82 17 30 72 127 123 215 131 227 128 222 149 258 127 223 259 451
281 487 15 25 39 65 53 90 13 25 57 101 97 170 40 69 86 150 103 180 16 30 38
67 49 82 10 14 18 29 18 32 0 3 14 29 31 58 18 29 40 67 49 83 132 227 170
295 170 304 0 14 -261 15 -311 1 -39 -11 -67 -37 -97 -90 -11 -19 -52 -90 -91
-157 -149 -257 -211 -365 -211 -368 0 -2 -18 -33 -41 -70 -47 -78 -67 -113
-121 -209 -21 -38 -42 -74 -47 -80 -4 -6 -22 -36 -38 -66 -17 -30 -63 -111
-103 -180 -40 -69 -84 -145 -98 -170 -13 -25 -46 -81 -72 -125 -26 -44 -103
-177 -170 -295 -67 -118 -144 -251 -170 -295 -26 -44 -59 -100 -72 -125 -14
-25 -58 -101 -98 -170 -40 -69 -80 -138 -90 -155 -9 -16 -33 -57 -52 -90 -20
-33 -47 -80 -60 -105 -23 -41 -185 -322 -228 -395 -55 -93 -287 -498 -313
-545 -16 -30 -33 -59 -37 -65 -5 -5 -76 -129 -160 -275 -84 -146 -160 -278
-170 -295 -100 -172 -168 -290 -196 -340 -18 -33 -46 -77 -63 -97 -59 -71 -35
-68 -623 -68 -290 0 -528 3 -528 6 0 6 3 11 180 319 72 126 135 234 139 240 5
5 22 35 38 65 25 46 121 212 193 335 17 29 176 306 529 920 95 165 176 305
181 310 4 6 21 35 37 65 24 44 169 296 273 475 21 37 235 407 261 453 11 18
38 66 60 105 23 40 49 86 59 102 86 147 168 289 193 335 16 30 33 60 37 65 8
10 212 362 258 445 32 58 232 403 288 499 64 108 71 103 -115 99 -143 -3 -163
-5 -188 -24 -22 -16 -221 -338 -250 -404 -3 -8 -14 -26 -23 -40 -9 -14 -31
-50 -47 -80 -17 -30 -63 -111 -103 -180 -95 -164 -106 -183 -131 -227 -12 -21
-25 -42 -29 -48 -4 -5 -21 -35 -37 -65 -36 -67 -168 -295 -233 -405 -26 -44
-59 -100 -72 -125 -21 -38 -81 -141 -191 -330 -11 -19 -46 -80 -77 -135 -31
-55 -108 -188 -170 -295 -126 -218 -142 -246 -169 -292 -10 -18 -60 -105 -111
-193 -51 -88 -106 -185 -123 -215 -16 -30 -33 -59 -37 -65 -5 -5 -93 -158
-198 -340 -104 -181 -213 -370 -242 -420 -29 -49 -64 -110 -78 -135 -14 -25
-50 -88 -80 -140 -30 -52 -63 -110 -73 -127 -39 -67 -58 -101 -129 -223 -40
-69 -86 -150 -103 -180 -45 -81 -53 -91 -98 -122 l-42 -28 -534 0 c-293 0
-533 4 -533 8 0 4 4 12 9 18 9 9 161 270 224 384 16 30 38 67 49 82 10 14 18
29 18 32 0 4 20 39 44 79 24 39 78 133 121 207 43 74 87 151 98 170 11 19 33
60 50 90 16 30 33 60 37 65 4 6 17 26 28 45 92 162 285 497 291 505 5 5 22 35
38 65 17 30 63 111 103 180 95 164 106 183 131 228 12 20 25 42 29 47 4 6 21
35 37 65 36 67 168 295 233 405 26 44 59 100 72 125 14 25 58 101 98 170 40
69 83 143 95 165 44 77 133 232 245 425 117 202 137 238 169 293 10 17 87 151
170 297 84 145 156 269 160 275 5 5 22 35 38 65 57 104 174 305 184 315 29 30
9 35 -142 35 -192 0 -208 -7 -269 -114 -9 -17 -50 -87 -90 -156 -40 -68 -81
-138 -90 -155 -134 -235 -324 -562 -330 -570 -4 -5 -21 -35 -37 -65 -26 -46
-216 -378 -273 -475 -10 -16 -68 -118 -130 -225 -119 -206 -127 -220 -191
-333 -23 -40 -49 -85 -59 -102 -86 -147 -168 -289 -193 -335 -16 -30 -33 -59
-37 -65 -8 -10 -214 -367 -258 -445 -13 -25 -64 -112 -112 -195 -48 -82 -122
-211 -165 -285 -43 -74 -86 -150 -96 -168 -11 -17 -27 -47 -38 -65 -17 -29
-67 -117 -120 -209 -10 -18 -42 -73 -71 -123 -29 -49 -66 -115 -83 -145 -16
-30 -33 -59 -37 -65 -4 -5 -17 -26 -28 -45 -247 -436 -264 -462 -320 -486 -39
-16 -1074 -22 -1080 -6 -1 5 57 112 129 238 73 126 149 258 169 294 20 36 88
153 150 260 62 107 126 220 143 250 16 30 33 60 37 65 4 6 17 26 28 45 22 39
235 409 262 455 80 137 120 207 120 210 0 2 18 33 41 70 47 78 67 113 121 209
21 38 42 74 47 80 4 6 22 36 38 66 25 46 209 366 273 475 10 17 95 165 190
330 94 165 175 305 180 310 4 6 21 35 37 65 25 46 107 188 193 335 10 17 36
62 59 102 167 292 303 528 310 538 5 5 22 35 38 65 17 30 69 122 116 204 48
82 84 152 81 157 -9 16 -291 11 -322 -5 -44 -23 -64 -51 -187 -266 -123 -213
-364 -633 -395 -685 -57 -98 -207 -358 -233 -405 -17 -30 -48 -84 -69 -119
-21 -34 -38 -65 -38 -68 0 -3 -8 -17 -18 -31 -11 -15 -33 -52 -49 -82 -17 -30
-72 -127 -123 -215 -130 -225 -128 -222 -149 -257 -10 -18 -78 -136 -151 -263
-73 -126 -150 -259 -170 -295 -20 -36 -70 -121 -110 -190 -40 -69 -86 -150
-103 -180 -16 -30 -38 -67 -49 -82 -10 -14 -18 -29 -18 -32 0 -3 -14 -29 -31
-58 -44 -73 -52 -88 -176 -303 -241 -416 -336 -582 -356 -615 -11 -19 -38 -66
-59 -104 -21 -38 -42 -74 -47 -80 -4 -6 -22 -36 -38 -66 -96 -176 -198 -346
-227 -378 -44 -50 -151 -68 -212 -37 -56 28 -86 71 -284 420 -34 61 -75 130
-90 155 -15 25 -39 65 -53 90 -13 25 -66 116 -116 203 -257 444 -285 492 -330
570 -10 17 -50 86 -88 152 -205 353 -298 515 -320 555 -14 25 -38 65 -53 90
-15 25 -56 95 -90 155 -63 110 -147 256 -266 458 -35 59 -64 109 -64 112 0 2
-23 40 -50 85 -28 45 -50 83 -50 86 0 2 -20 37 -44 77 -24 39 -78 133 -121
207 -43 74 -85 149 -95 165 -10 17 -59 102 -110 190 -51 88 -101 175 -111 193
-39 67 -59 101 -134 232 -43 74 -97 168 -121 207 -24 40 -44 75 -44 77 0 2
-19 35 -42 72 -23 38 -55 94 -71 124 -76 140 -94 150 -292 150 -78 0 -144 -3
-148 -6z M17295 3949 c-65 -14 -117 -30 -162 -50 -24 -11 -45 -19 -47 -19 -22
0 -142 -86 -200 -144 -317 -313 -299 -855 37 -1137 210 -176 512 -235 801
-155 120 33 336 171 336 214 0 9 -50 67 -112 129 l-112 112 -56 -53 c-213
-203 -570 -156 -704 93 -95 178 -71 429 55 566 173 188 462 200 642 27 l49
-47 64 70 c120 129 156 175 151 188 -9 23 -124 105 -195 138 -66 32 -85 38
-197 64 -67 16 -286 18 -350 4z M21580 3939 c-41 -10 -84 -23 -95 -28 -11 -5
-42 -19 -70 -31 -280 -125 -451 -433 -423 -765 29 -345 243 -592 593 -687 67
-18 343 -18 410 0 275 75 477 254 559 496 127 375 -34 784 -373 950 -135 66
-229 86 -398 85 -91 0 -150 -6 -203 -20z m295 -294 c358 -68 493 -537 230
-801 -209 -210 -591 -148 -712 114 -123 265 -6 591 239 666 126 38 145 40 243
21z M27770 3894 c-16 -37 -30 -68 -30 -70 0 -2 -11 -27 -24 -56 -13 -29 -43
-98 -66 -153 -23 -55 -50 -118 -60 -141 -11 -22 -29 -65 -40 -95 -12 -29 -32
-77 -46 -107 -13 -29 -24 -55 -24 -57 0 -2 -13 -34 -30 -70 -16 -36 -30 -68
-30 -70 0 -2 -11 -28 -24 -57 -13 -29 -45 -102 -70 -163 -26 -60 -51 -119 -56
-130 -48 -104 -118 -280 -114 -286 3 -5 79 -9 169 -9 l164 0 17 38 c9 20 20
46 25 57 5 11 28 70 53 130 l45 110 314 3 314 2 14 -32 c7 -18 23 -55 35 -83
12 -27 37 -86 54 -130 17 -44 37 -83 43 -87 17 -11 325 -10 331 1 3 5 -1 21
-8 37 -8 16 -22 47 -31 69 -10 22 -23 54 -30 70 -8 17 -28 66 -45 110 -17 44
-43 104 -56 133 -13 29 -24 55 -24 57 0 3 -9 27 -21 53 -12 26 -24 56 -29 67
-4 11 -13 34 -20 50 -96 228 -150 357 -150 360 0 3 -11 28 -24 57 -13 29 -39
89 -56 133 -17 44 -42 103 -54 130 -12 28 -33 77 -46 110 -35 90 -24 85 -191
85 l-149 0 -30 -66z m253 -547 c38 -94 79 -194 92 -222 12 -27 21 -53 18 -57
-6 -11 -370 -10 -377 0 -2 4 1 21 8 37 7 17 33 77 56 135 24 58 51 123 60 145
9 22 25 61 35 88 10 26 23 47 29 47 6 0 42 -78 79 -173z M12860 3931 c0 -10 8
-31 36 -96 7 -16 63 -156 124 -310 61 -154 117 -293 124 -310 14 -33 45 -108
72 -172 10 -24 70 -172 133 -330 l116 -288 150 -3 151 -2 248 622 c136 343
254 637 261 653 42 95 85 211 85 227 0 17 -13 18 -169 18 l-169 0 -22 -57
c-12 -32 -26 -67 -30 -78 -8 -19 -74 -191 -142 -370 -16 -44 -34 -89 -38 -100
-4 -11 -27 -69 -50 -130 -23 -60 -46 -119 -51 -130 -5 -11 -20 -51 -33 -90
-13 -38 -28 -71 -34 -73 -5 -1 -30 55 -56 125 -26 70 -61 164 -78 208 -16 44
-39 104 -49 133 -10 28 -28 76 -38 105 -10 28 -38 102 -61 162 -23 61 -50 133
-60 160 -10 28 -25 68 -33 90 l-15 40 -186 3 c-116 1 -186 -1 -186 -7z M15330
3938 c-1 -6 -1 -1484 0 -1496 0 -10 36 -12 163 -10 l162 3 0 750 0 750 -162 3
c-90 1 -163 1 -163 0z M18922 3788 l3 -153 227 -3 228 -2 2 -598 3 -597 160 0
160 0 5 595 c3 327 6 596 8 597 1 2 102 4 225 5 l222 3 0 150 0 150 -623 3
-623 2 3 -152z M23596 3932 c-7 -12 -6 -1470 1 -1489 7 -18 323 -19 323 0 1 6
0 108 0 226 0 148 3 217 11 227 9 11 41 14 130 14 l118 0 39 -52 c21 -29 96
-137 166 -240 l127 -188 184 0 c101 0 186 4 189 8 3 5 -76 122 -174 261 -176
247 -196 281 -165 281 51 0 174 90 224 164 61 90 76 149 76 291 0 257 -98 395
-340 482 -45 16 -97 18 -477 21 -256 2 -429 -1 -432 -6z m791 -313 c175 -97
157 -348 -27 -399 -63 -18 -427 -13 -434 6 -8 21 -8 399 1 407 3 4 100 7 214
7 193 0 211 -2 246 -21z M25868 3198 c-2 -425 1 -748 6 -756 7 -9 47 -12 165
-10 l156 3 0 750 0 750 -162 3 -163 2 -2 -742z M13110 1668 c-128 -26 -203
-105 -203 -213 -1 -120 60 -174 253 -224 166 -44 220 -78 220 -139 0 -73 -70
-115 -191 -115 -96 0 -161 18 -230 65 -26 17 -27 17 -41 -5 -39 -59 -30 -78
52 -115 180 -79 406 -48 484 67 39 59 42 157 6 212 -38 58 -80 78 -275 131
-125 33 -165 63 -165 121 0 80 68 127 181 127 57 0 173 -30 194 -51 16 -16 26
-10 41 27 19 46 15 57 -33 79 -79 38 -204 52 -293 33z M14830 1665 c-217 -50
-346 -239 -311 -456 24 -149 137 -273 287 -317 52 -15 214 -16 251 -1 203 82
289 206 281 403 -10 261 -244 432 -508 371z m164 -96 c160 -44 230 -133 230
-294 0 -95 -8 -123 -61 -191 -96 -127 -310 -141 -439 -30 -108 93 -128 284
-41 398 76 99 201 147 311 117z M18350 1666 c-264 -73 -385 -332 -268 -573
103 -210 396 -281 621 -149 l47 27 0 164 c0 91 -3 165 -7 165 -5 0 -73 1 -153
1 l-145 1 -3 -51 -3 -51 100 0 101 0 0 -89 0 -88 -51 -22 c-155 -64 -350 9
-415 156 -25 56 -23 185 3 244 80 178 318 230 485 106 l28 -21 30 29 c38 36
38 48 -2 78 -101 76 -251 105 -368 73z M13679 1663 c-16 -93 -16 -92 129 -95
l127 -3 5 -340 5 -340 50 0 50 0 5 340 c3 187 7 341 8 342 1 1 59 4 130 5
l127 3 0 45 0 45 -317 3 c-175 1 -319 -1 -319 -5z M15665 1658 c-3 -7 -4 -184
-3 -393 l3 -380 43 -3 c73 -5 72 -13 70 288 -2 148 0 271 3 275 3 3 102 -115
220 -262 252 -314 243 -305 289 -301 l35 3 5 375 c3 206 1 383 -3 393 -7 14
-18 17 -55 15 l-47 -3 -3 -282 c-1 -156 -6 -283 -10 -283 -4 0 -28 28 -54 63
-26 34 -127 161 -225 282 -178 220 -178 220 -221 223 -28 2 -44 -1 -47 -10z
M16716 1654 c-14 -36 -7 -751 8 -763 9 -8 92 -11 282 -9 l269 3 3 48 3 47
-221 0 -220 0 -10 24 c-14 39 -6 216 11 227 8 5 96 9 197 9 l183 0 -3 43 -3
42 -192 3 c-144 2 -193 6 -194 15 -6 64 -3 205 4 215 7 9 63 12 218 12 226 0
211 -4 211 55 0 14 0 30 -1 35 -2 19 -538 13 -545 -6z M19352 1658 c-6 -6 -12
-15 -12 -20 0 -4 -14 -38 -31 -75 -43 -92 -73 -158 -99 -218 -12 -27 -33 -74
-46 -102 -13 -29 -36 -79 -50 -110 -14 -32 -42 -91 -60 -132 -51 -109 -50
-116 11 -116 56 0 62 8 114 138 l23 57 208 0 207 0 46 -100 46 -100 50 0 c61
0 66 7 42 56 -11 22 -51 111 -91 199 -40 88 -89 196 -109 240 -21 44 -46 100
-57 124 -10 25 -32 72 -49 105 l-30 61 -50 3 c-30 2 -55 -2 -63 -10z m86 -165
c11 -27 37 -86 58 -133 20 -47 45 -104 55 -127 11 -23 19 -47 19 -52 0 -14
-306 -15 -314 -2 -3 5 9 42 28 82 18 41 53 120 77 176 24 57 47 103 50 103 3
0 15 -21 27 -47z M20122 1278 l3 -393 240 -3 c294 -3 285 -5 285 53 l0 45
-207 2 -208 3 -5 340 c-3 187 -7 341 -8 343 -1 1 -25 2 -52 2 l-50 0 2 -392z
M20956 1655 c-12 -33 -7 -750 6 -763 9 -9 82 -12 265 -12 l253 0 6 24 c3 13 4
35 2 47 l-3 24 -210 5 -210 5 -5 340 -5 340 -46 3 c-36 2 -48 -1 -53 -13z
M21824 1659 c-9 -15 -5 -762 5 -772 4 -4 129 -6 277 -5 l269 3 3 48 3 47 -224
0 c-171 0 -226 3 -230 13 -7 20 -3 221 6 235 6 9 57 12 198 12 l190 0 -3 43
-3 42 -195 5 -194 5 1 110 c1 61 2 113 2 118 1 4 97 7 215 7 l214 0 4 40 c2
22 -1 45 -6 50 -14 14 -523 13 -532 -1z M22679 1661 c-2 -6 -3 -184 -1 -396
l2 -385 43 0 c63 0 67 9 67 132 l0 108 123 0 122 -1 80 -117 80 -117 52 -2
c29 -1 55 3 58 7 3 5 -33 63 -80 129 -81 112 -93 141 -61 141 23 0 94 70 115
113 30 63 29 185 -2 247 -26 50 -95 108 -154 128 -50 18 -439 29 -444 13z
m432 -123 c58 -34 74 -65 74 -147 0 -130 -53 -164 -257 -169 l-138 -4 0 170
c0 93 3 172 8 176 4 5 66 6 137 4 119 -3 134 -6 176 -30z M23545 1660 c-3 -6
11 -39 33 -73 21 -34 61 -98 87 -142 26 -44 76 -126 111 -181 l63 -102 3 -138
3 -139 50 0 50 0 5 140 5 140 54 85 c30 47 63 101 75 121 11 19 54 90 94 156
39 67 72 126 72 132 0 8 -17 11 -51 9 l-50 -3 -86 -140 c-47 -77 -101 -166
-120 -197 -19 -32 -38 -58 -43 -58 -5 0 -27 30 -49 68 -22 37 -76 126 -119
197 l-79 130 -51 3 c-28 2 -53 -2 -57 -8z"/>
</g></symbol></svg>
<div class="topbar">
  <div id="cms-topbar-text">Melbourne Natural Stone Gallery — Direct from the Source to Your Project</div>
  <div class="topbar-right">
    <a href="tel:0397027539" id="cms-phone-link">03 9702 7539</a>
    <a href="mailto:sales@victoriastonegallery.com.au" id="cms-email-link">sales@victoriastonegallery.com.au</a>
    <a href="https://www.facebook.com/victoriastonegallery" target="_blank">Facebook</a>
    <a href="https://www.instagram.com/victoriastonegallery/" target="_blank">Instagram</a>
  </div>
</div>
<nav id="nav">
  <a href="/" class="nav-logo" aria-label="Victoria Stone Gallery"><svg class="vsg-logo-svg nav-logo-svg" viewBox="0 0 2880 528" role="img" aria-label="Victoria Stone Gallery"><use href="#vsgLogo"/></svg></a>
  <button class="nav-hamburger" id="navHamburger" onclick="toggleMobileNav()" aria-label="Menu"><span></span><span></span><span></span></button>
  <ul class="nav-links" id="navLinks">
    <li><a href="/catalogue/" class="current">Catalogue</a></li>
    <li><a href="/#gallery">Gallery</a></li>
    <li><a href="/#about">About</a></li>
    <li><a href="/#why">Why VSG</a></li>
    <li><a href="/stones/">Stone Knowledge</a></li>
    <li><a href="/#fabricators">Fabricators</a></li>
    <li><a href="/#gallery" class="nav-shortlist-btn">&#9825; My Shortlist</a></li>
    <li><a href="/#contact" class="nav-cta">Contact Us</a></li>
  </ul>
</nav>
${body}
<footer>
  <div class="footer-top">
    <div>
      <svg class="vsg-logo-svg footer-logo-svg" viewBox="0 0 2880 528" role="img" aria-label="Victoria Stone Gallery"><use href="#vsgLogo"/></svg>
      <p class="footer-tagline" id="cms-footer-tagline">Melbourne's premier wholesaler of natural stone slabs. Hand-selected from quarries around the world, delivered to your project.</p>
    </div>
    <div><div class="footer-col-title">Explore</div><ul class="footer-links"><li><a href="/#about">About Us</a></li><li><a href="/catalogue/" class="current">Product Catalogue</a></li><li><a href="/#gallery">Gallery</a></li><li><a href="/stones/">Stone Knowledge</a></li><li><a href="/#why">Why VSG</a></li><li><a href="/#events">Events</a></li></ul></div>
    <div><div class="footer-col-title">Stone Types</div><ul class="footer-links"><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Marble')">Marble</a></li><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Quartzite')">Quartzite</a></li><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Granite')">Granite</a></li><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Dolomite')">Dolomite</a></li><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Limestone')">Limestone</a></li><li><a href="/#gallery" onclick="sessionStorage.setItem('vsg-pending-filter','Travertine')">Travertine</a></li></ul></div>
    <div><div class="footer-col-title">Connect</div><ul class="footer-links"><li><a href="https://www.facebook.com/victoriastonegallery" target="_blank">Facebook</a></li><li><a href="https://www.instagram.com/victoriastonegallery/" target="_blank">Instagram</a></li><li><a href="https://www.pinterest.com.au/victoriastonegallery/pins/" target="_blank">Pinterest</a></li><li><a href="https://www.houzz.com.au/professionals/tile-stone-and-benchtops/victoria-stone-gallery-pfvwau-pf~472554601" target="_blank">Houzz</a></li><li><a href="/#contact">Contact Us</a></li></ul></div>
  </div>
  <p class="footer-acknowledgement">We acknowledge the Wurundjeri people who are the Traditional Custodians of the Land where we work, live and play. We offer our eternal respect to the Elders of the Kulin Nation &#8211; past, present &amp; emerging.</p>
  <div class="footer-bottom"><span>&copy; 2026 Victoria Stone Gallery. All rights reserved.</span><span>37&#8211;39 Gaine Road, Dandenong South VIC 3175</span></div>
</footer>
<script>function toggleMobileNav(){
  const links=document.getElementById('navLinks');
  const btn=document.getElementById('navHamburger');
  const open=links.classList.toggle('open');
  btn.classList.toggle('open',open);
  document.body.style.overflow=open?'hidden':'';
}</script>
</body>
</html>`;
}

function introFor(v, colour){
  const d = DESCRIPTIONS[v.name];
  if(d) return d;
  const mat = (v.material||'stone').toLowerCase();
  const fins = [...new Set([...v.lots.values()].map(l=>l.fin).filter(Boolean))];
  const c = colour ? `${colour.toLowerCase()} ` : '';
  return `${v.name} is a ${c}natural ${mat} held in our Melbourne gallery${fins.length?`, currently in ${fins.map(f=>f.toLowerCase()).join(' and ')} finish${fins.length>1?'es':''}`:''}. Every lot is photographed individually and available to view in person before you commit.`;
}

function stonePage(v, slug, manifest, cms, stamp){
  const showSlabs = cms.slabDisplay !== 'hide';
  const avail = [...v.lots.values()].filter(l=>l.status==='AVAILABLE');
  const lotsWithImg = avail.filter(l=>manifest[l.lot]?.slab).sort((a,b)=>b.slabs-a.slabs);
  const chosenLot = (cms.catalogueThumbs||{})[v.name];
  const hero = (chosenLot&&manifest[chosenLot]) ? manifest[chosenLot]
    : (lotsWithImg[0] ? manifest[lotsWithImg[0].lot] : null);
  const finishes = [...new Set(avail.map(l=>l.fin).filter(Boolean))].sort();
  const ths = [...new Set(avail.map(l=>l.th).filter(Boolean))].sort((a,b)=>a-b);
  const maxw = Math.max(0,...avail.map(l=>l.w)), maxh = Math.max(0,...avail.map(l=>l.h));
  const eta = v.transitEtas.sort()[0];
  const matSlug = MAT_SLUG[v.material]||'';
  const cards = lotsWithImg.slice(0,6).map(l=>{
    const e = manifest[l.lot];
    const srcset = e.slabSrcset ? ` srcset="${esc(e.slabSrcset)}" sizes="(max-width:700px) 100vw, 33vw"` : '';
    const qty = showSlabs ? `${l.slabs} slab${l.slabs!==1?'s':''} &middot; ` : '';
    const deepLink=`/?lot=${encodeURIComponent(l.lot)}&name=${encodeURIComponent(v.name)}#gallery`;
    return `<a class="lot-card" href="${deepLink}" title="View this lot in the gallery"><img src="${e.slab}"${srcset} alt="${esc(v.name)} ${esc((v.material||'').toLowerCase())} &mdash; lot ${esc(displayLot(l.lot))}" loading="lazy"><div class="lot-meta"><span>Lot ${esc(displayLot(l.lot))}</span><span>${qty}${l.th}mm ${esc(l.fin)}</span></div></a>`;
  }).join('\n    ');

  const specs = [
    `<div class="spec"><div class="k">In the gallery</div><div class="v">${avail.length} lot${avail.length!==1?'s':''}</div></div>`,
    maxw?`<div class="spec"><div class="k">Typical slab size</div><div class="v">up to ${(maxw/1000).toFixed(1)} &times; ${(maxh/1000).toFixed(1)} m</div></div>`:'',
    ths.length?`<div class="spec"><div class="k">Thickness</div><div class="v">${ths.map(t=>t+'mm').join(' / ')}</div></div>`:'',
    finishes.length?`<div class="spec"><div class="k">Finishes</div><div class="v">${esc(finishes.join(', '))}</div></div>`:'',
    eta?`<div class="spec"><div class="k">Arriving</div><div class="v">More en route &middot; ${esc(eta)}</div></div>`:'',
  ].filter(Boolean).join('\n  ');

  const body = `
<div class="crumbs"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/catalogue/">Catalogue</a> &nbsp;/&nbsp; ${esc(v.material||'Stone')} &nbsp;/&nbsp; ${esc(v.name)}</div>
<header class="stone">
  <div><div class="eyebrow">${esc(v.material||'Natural Stone')} &middot; In the Gallery</div><h1>${esc(v.name)}</h1></div>
  <p class="intro">${esc(introFor(v))}</p>
</header>
${hero?`<div class="hero"><img src="${hero.slabFull||hero.slab}" alt="${esc(v.name)} full slab"></div>`:''}
<div class="specs">
  ${specs}
</div>
<section>
  ${lotsWithImg.length?`<h2>Current <em>lots</em></h2>
  <div class="section-sub">A selection of what's in the gallery now &mdash; photography per lot, as natural stone varies block to block. Stock as at ${stamp}.</div>
  <div class="lots">
    ${cards}
  </div>`:`<h2>In the <em>gallery</em></h2>
  <div class="section-sub">Photography for this stone is on its way. Stock as at ${stamp} &mdash; contact us for current lots and images.</div>`}
  <div class="cta-row">
    <a class="btn primary" href="/?stone=${encodeURIComponent(slugify(v.name))}#gallery">View all lots in the Gallery</a>
    <a class="btn ghost" href="/#contact">Enquire or arrange a viewing</a>
  </div>
</section>
<section style="padding-top:0">
  <div class="guide">
    <p><strong>Choosing ${esc((v.material||'natural stone').toLowerCase())}.</strong> Read our guide on selection, sealing and everyday care before you commit.</p>
    <a class="btn ghost" href="/stones/">${esc(v.material||'Stone')} Guide</a>
  </div>
</section>`;

  const jsonld = JSON.stringify({ '@context':'https://schema.org','@type':'Product',
    name:`${v.name} ${v.material||''}`.trim(),
    description:`Natural ${v.name} ${(v.material||'stone').toLowerCase()} slabs, available from Victoria Stone Gallery, Melbourne.`,
    ...(hero?{image:SITE+(hero.slabFull||hero.slab)}:{}),
    brand:{'@type':'Brand',name:'Victoria Stone Gallery'},
    offers:{'@type':'AggregateOffer',availability:'https://schema.org/InStock',priceCurrency:'AUD',offerCount:avail.length}});

  return shell({
    title:`${v.name} ${v.material||''} Slabs Melbourne | Victoria Stone Gallery`.replace(/\s+/g,' '),
    description:`${v.name} ${(v.material||'stone').toLowerCase()} slabs in Melbourne — ${avail.length} lot${avail.length!==1?'s':''} in the gallery now${finishes.length?`. ${finishes.join(', ')} finishes`:''}. View current lots and arrange a viewing.`,
    canonical:`${SITE}/stone/${slug}/`, jsonld, body });
}

function legacyPage(entry){
  const { name, material, slug } = entry;
  const matSlug = MAT_SLUG[material]||'';
  const body = `
<div class="crumbs"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/catalogue/">Catalogue</a> &nbsp;/&nbsp; ${esc(material)} &nbsp;/&nbsp; ${esc(name)}</div>
<main class="legacy">
  <div class="eyebrow">${esc(material)}</div>
  <h1>${esc(name)}</h1>
  <div class="status">Not currently in the gallery</div>
  <p class="intro">${esc(name)} is a ${esc(material.toLowerCase())} we have carried in the past and can source again. Availability of natural stone shifts with each shipment &mdash; register your interest and we'll be in touch when it returns, or when a close alternative arrives.</p>
  <div class="cta-row">
    <a class="btn primary" href="/#contact">Register your interest</a>
    <a class="btn ghost" href="/catalogue/#${matSlug}">${esc(material)}s in stock now</a>
  </div>
</main>`;
  return shell({
    title:`${name} ${material} Melbourne | Victoria Stone Gallery`,
    description:`${name} ${material.toLowerCase()} — not currently held in our Melbourne gallery. Register your interest, or explore comparable stones in stock now.`,
    canonical:`${SITE}/stone/${slug}/`, jsonld:null, body });
}

function cataloguePage(entries, cms, stamp){
  // Three tiers per material: featured tiles, family cards (expandable),
  // then the remainder collapsed as text links. All links are in the HTML
  // whether expanded or not (<details>), so crawl completeness survives the
  // visual trim — one page carries every stone's internal link.
  const order = ['Marble','Quartzite','Granite','Dolomite','Travertine','Limestone','Onyx'];
  const FAMILIES = PAGES_CONFIG.families || {};
  const FEATURED = PAGES_CONFIG.featuredStones || {};
  const famOf = {};
  for(const [fam,members] of Object.entries(FAMILIES)) for(const m of members) famOf[m]=fam;

  const byMat = new Map();
  for(const e of entries){ if(!byMat.has(e.material)) byMat.set(e.material,[]); byMat.get(e.material).push(e); }

  const tile = e => `<a class="tile" href="/stone/${e.slug}/"><span class="tile-img"><img src="${e.thumb}" alt="${esc(e.name)} close up" loading="lazy"></span><div class="tile-name">${esc(e.name)}</div><div class="tile-sub">${e.lotCount} lot${e.lotCount!==1?'s':''}</div></a>`;

  const sections = order.filter(m=>byMat.has(m)).map(m=>{
    const list = byMat.get(m).sort((a,b)=>a.name.localeCompare(b.name));
    const byName = Object.fromEntries(list.map(e=>[e.name,e]));

    // families present in this material (family goes where most members sit)
    const famsHere = {};
    for(const e of list){ const f=famOf[e.name]; if(f){ (famsHere[f]=famsHere[f]||[]).push(e); } }
    const famNames = Object.keys(famsHere).filter(f=>famsHere[f].length>=2).sort();
    const inFam = new Set(famNames.flatMap(f=>famsHere[f].map(e=>e.name)));
    const standalone = list.filter(e=>!inFam.has(e.name));

    // featured: admin stars first (order of starring, capped at 8, photographed
    // only — a starred stone with no photo is skipped, not shown broken), then
    // the repo config list, then auto = most lots among photographed standalones
    const starred = (cms.catalogueFeatured||[]).map(n=>byName[n]).filter(e=>e&&e.thumb).slice(0,8);
    const curated = starred.length ? starred
      : (FEATURED[m]||[]).map(n=>byName[n]).filter(Boolean);
    const featured = curated.length ? curated
      : standalone.filter(e=>e.thumb).sort((a,b)=>b.lotCount-a.lotCount).slice(0,6);
    const featNames = new Set(featured.map(e=>e.name));
    const rest = standalone.filter(e=>!featNames.has(e.name));

    // Family card image: the flagship member's own slab photo (most-stocked
    // photographed member), zoom-cropped like every other tile — so each
    // family reads as ITSELF. A material-level close-up was tried here and
    // reverted: one close-up per material across seven families rendered
    // seven identical tiles. If per-FAMILY close-ups ever exist (a file per
    // family name in the Category Close-Ups folder), that is the thing to
    // wire in — never the material-level image.
    const famCards = famNames.map(f=>{
      const members = famsHere[f].sort((a,b)=>a.name.localeCompare(b.name));
      const flagship = members.filter(e=>e.thumb).sort((a,b)=>b.lotCount-a.lotCount)[0]||members[0];
      const lots = members.reduce((a,e)=>a+e.lotCount,0);
      const img = flagship.thumb?`<img src="${flagship.thumb}" alt="${esc(f)} family close up" loading="lazy">`:'';
      return `<details class="family"><summary class="tile family-card"><span class="tile-img">${img}</span><div class="tile-name">${esc(f)}</div><div class="tile-sub">${members.length} varieties &middot; ${lots} lots</div></summary><div class="family-members">${members.map(tile).join('')}</div></details>`;
    }).join('\n      ');

    const restLinks = rest.length?`<details class="rest"><summary>All other ${m}s (${rest.length})</summary><div class="rest-links">${rest.map(e=>`<a href="/stone/${e.slug}/">${esc(e.name)}</a>`).join('')}</div></details>`:'';

    return `<section id="${MAT_SLUG[m]}">
  <h2>${m} <em>&middot; ${list.length}</em></h2>
  <div class="tiles">
      ${featured.map(tile).join('\n      ')}
      ${famCards}
  </div>
  ${restLinks}
</section>`;
  }).join('\n');

  const total = entries.length;
  const body = `
<div class="crumbs"><a href="/">Home</a> &nbsp;/&nbsp; Catalogue</div>
<header class="stone" style="grid-template-columns:1fr">
  <div>
    <div class="eyebrow">The Collection, By Name</div>
    <h1>Stone <em style="font-style:italic;color:var(--stone-dark)">Catalogue</em></h1>
    <p class="intro" style="margin-top:18px">Every stone currently in the gallery, by name. Each links to its own page with lot photography and current availability. Stock as at ${stamp}.</p>
  </div>
</header>
${sections}`;
  return shell({
    title:'Natural Stone Catalogue Melbourne | Victoria Stone Gallery',
    description:`Browse ${total} natural stone varieties by name — marble, quartzite, granite, dolomite, travertine and limestone slabs in our Melbourne gallery, updated from live stock.`,
    canonical:`${SITE}/catalogue/`, jsonld:null, body });
}

// ── main ─────────────────────────────────────────────────────
async function main(){
  const { wb, cms } = await loadData();
  const manifest = JSON.parse(fs.readFileSync(path.join(CWD,'image-manifest-cdn.json'),'utf8')).manifest;
  const { varieties, anomalies } = aggregate(wb, cms);
  const stamp = new Date().toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric',timeZone:'Australia/Melbourne'});
  console.log(`Stone pages: ${varieties.size} in-stock varieties after visibility rules`);

  // Clean output first — stale pages from a previous run must not survive a
  // filter change (Netlify checkouts are fresh anyway; this covers local dev).
  fs.rmSync(path.join(CWD,'stone'),{recursive:true,force:true});
  fs.mkdirSync(path.join(CWD,'stone'),{recursive:true});
  fs.writeFileSync(path.join(CWD,'stone','stone-pages.css'), STONE_CSS);

  const catalogueEntries = [];
  const sitemapUrls = [`${SITE}/`,`${SITE}/catalogue/`,`${SITE}/stones/`];
  const usedSlugs = new Map();
  let written = 0;

  for(const v of varieties.values()){
    const matSlug = MAT_SLUG[v.material]||'';
    let base = slugify(v.name);
    const slug = matSlug && !base.includes(matSlug) ? `${base}-${matSlug}` : base;
    if(usedSlugs.has(slug)){ anomalies.push(`slug collision: "${v.name}" vs "${usedSlugs.get(slug)}" → ${slug}; skipped`); continue; }
    usedSlugs.set(slug, v.name);
    const html = stonePage(v, slug, manifest, cms, stamp);
    const dir = path.join(CWD,'stone',slug);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), html);
    written++;
    sitemapUrls.push(`${SITE}/stone/${slug}/`);
    const avail = [...v.lots.values()].filter(l=>l.status==='AVAILABLE');
    const chosen = (cms.catalogueThumbs||{})[v.name];
    const firstImg = (chosen&&manifest[chosen]?.slab)
      || avail.map(l=>manifest[l.lot]?.slab).find(Boolean);
    if(firstImg || cms.hideNoPhoto===false)
      catalogueEntries.push({ name:v.name, material:v.material||'Other', slug, lotCount:avail.length, thumb:firstImg||'' });
  }

  for(const entry of PAGES_CONFIG.legacyPages){
    if(usedSlugs.has(entry.slug)){ console.log(`  legacy "${entry.name}" back in stock — live page wins, legacy skipped`); continue; }
    const dir = path.join(CWD,'stone',entry.slug);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), legacyPage(entry));
    written++;
    sitemapUrls.push(`${SITE}/stone/${entry.slug}/`);
  }

  fs.writeFileSync(path.join(CWD,'catalogue','index.html'), cataloguePage(catalogueEntries, cms, stamp));
  console.log(`Stone pages: ${written} pages + catalogue (${catalogueEntries.length} listed)`);

  // _redirects: static rules + exact WP product map (falls back to variety page if it exists, else configured target)
  const lines = [PAGES_CONFIG.redirectsHeader.trim(), ''];
  for(const r of PAGES_CONFIG.wpRedirects){
    const target = usedSlugs.has(r.slug) || PAGES_CONFIG.legacyPages.some(l=>l.slug===r.slug)
      ? `/stone/${r.slug}/` : '/catalogue/';
    lines.push(`${r.from.padEnd(46)}${target.padEnd(38)}301`);
  }
  lines.push('', PAGES_CONFIG.redirectsFooter.trim(), '');
  fs.writeFileSync(path.join(CWD,'_redirects'), lines.join('\n'));

  fs.writeFileSync(path.join(CWD,'sitemap.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u=>`  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`);
  console.log(`Stone pages: _redirects (${PAGES_CONFIG.wpRedirects.length} exact WP rules) + sitemap (${sitemapUrls.length} URLs)`);

  for(const a of [...new Set(anomalies)].slice(0,30)) console.warn('  DATA:', a);

  // Never ship a banned term (trademark guard)
  for(const term of BANNED){
    const hit = sitemapUrls.find(u=>u.toLowerCase().includes(term.toLowerCase()));
    if(hit){ console.error(`Stone pages: banned term "${term}" in ${hit}`); process.exit(1); }
  }
}

const STONE_CSS = `:root{--cream:#F5F0E8;--stone:#C8B89A;--stone-dark:#A09070;--gold:#B8963C;--bg:#1A1714;--bg2:#211D18;--mid:#8A8072}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--cream);font-family:'Jost',sans-serif;font-weight:300;line-height:1.65}
a{color:inherit}
.crumbs{padding:26px 5vw 0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mid)}
.crumbs a{text-decoration:none;color:var(--stone-dark)}
header.stone{padding:28px 5vw 0;display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:end}
.eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin-bottom:14px}
h1{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:clamp(40px,6vw,72px);line-height:1.02}
.intro{color:var(--stone);font-size:15px;max-width:56ch;margin-top:0}
.hero{padding:34px 5vw 0}
.hero img{width:100%;max-height:62vh;object-fit:cover;display:block}
.specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:rgba(200,184,154,.14);margin:0 5vw;transform:translateY(-38px)}
.spec{background:var(--bg2);padding:20px 22px}
.spec .k{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-dark);margin-bottom:6px}
.spec .v{font-family:'Cormorant Garamond',serif;font-size:23px}
section{padding:26px 5vw 60px}
h2{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:clamp(26px,3.4vw,38px);margin-bottom:8px}
h2 em{font-style:italic;color:var(--stone-dark)}
.section-sub{color:var(--mid);font-size:13px;margin-bottom:26px}
.lots{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:22px}
a.lot-card{display:block;text-decoration:none;color:inherit}
.lot-card img{width:100%;aspect-ratio:16/9.5;object-fit:cover;display:block;transition:opacity .25s}
a.lot-card:hover img{opacity:.85}
a.lot-card:hover .lot-meta span:first-child{color:var(--gold-light)}
.lot-meta{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--stone-dark);padding:9px 2px}
.cta-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:34px}
.btn{display:inline-block;padding:14px 30px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;text-decoration:none;border:1px solid var(--gold)}
.btn.primary{background:var(--gold);color:var(--bg)}
.btn.ghost{color:var(--stone)}
.guide{background:var(--bg2);border:1px solid rgba(200,184,154,.14);padding:30px 34px;display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap}
.guide p{color:var(--stone);font-size:14px;max-width:58ch}
main.legacy{padding:56px 5vw 80px;max-width:820px}
.status{display:inline-block;margin-top:26px;margin-bottom:6px;padding:8px 16px;border:1px solid rgba(200,184,154,.3);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--stone-dark)}
main.legacy .intro{margin-top:20px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
.tile{text-decoration:none;display:block;cursor:pointer}
.tile-img{display:block;width:100%;aspect-ratio:4/3;overflow:hidden;background:var(--bg2)}
.tile-img img{width:100%;height:100%;object-fit:cover;transform:scale(2.2);transform-origin:center 42%;display:block;transition:transform .5s ease}
.tile:hover .tile-img img{transform:scale(1)}
.tile-img img.no-zoom{transform:none}
.tile:hover .tile-img img.no-zoom{transform:none}
.tile-name{font-family:'Cormorant Garamond',serif;font-size:21px;margin-top:10px}
.tile-sub{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--stone-dark)}
details.family{display:block}
details.family>summary{list-style:none}
details.family>summary::-webkit-details-marker{display:none}
.family-card .tile-name::after{content:' +';color:var(--gold)}
details.family[open] .family-card .tile-name::after{content:' \\2212'}
.family-members{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:18px;padding:18px 0 8px;border-top:1px solid rgba(200,184,154,.14);border-bottom:1px solid rgba(200,184,154,.14);margin:14px 0 6px}
details.family[open]{grid-column:1/-1}
details.rest{margin-top:24px}
details.rest summary{cursor:pointer;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-dark)}
.rest-links{display:flex;flex-wrap:wrap;gap:8px 22px;padding-top:16px}
.rest-links a{font-size:13px;color:var(--stone);text-decoration:none;border-bottom:1px solid rgba(200,184,154,.25)}
@media(max-width:820px){header.stone{grid-template-columns:1fr}.specs{transform:none;margin-top:26px}}
/* ── site chrome (harvested from /catalogue/ page) ── */
.topbar{background:var(--black);color:var(--stone);font-size:12.5px;letter-spacing:.01em;font-weight:300;display:flex;justify-content:space-between;align-items:center;padding:9px 48px;}
.topbar a{color:var(--stone);text-decoration:none;}
.topbar a:hover{color:var(--gold-light);}
.topbar-right{display:flex;gap:20px;align-items:center;}
nav{position:sticky;top:0;z-index:200;background:var(--surface-nav);backdrop-filter:blur(12px);border-bottom:1px solid rgba(200,184,154,.12);display:flex;align-items:center;justify-content:space-between;gap:32px;padding:0 48px;height:72px;transition:box-shadow .3s;}
nav.scrolled{box-shadow:0 4px 32px rgba(0,0,0,.4);}
.nav-hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:8px;position:relative;z-index:601;-webkit-tap-highlight-color:transparent;}
.nav-hamburger span{display:block;width:24px;height:1.5px;background:var(--surface-dark-text);transition:all .3s;}
.nav-hamburger.open span:nth-child(1){transform:translateY(6.5px) rotate(45deg);}
.nav-hamburger.open span:nth-child(2){opacity:0;}
.nav-hamburger.open span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg);}
.nav-logo{text-decoration:none;display:flex;align-items:center;}
.vsg-logo-svg{display:block;width:auto;color:var(--surface-dark-text);fill:currentColor;}
.nav-logo-svg{height:30px;}
.footer-logo-svg{height:34px;color:var(--surface-dark-text);}
.nav-links{display:flex;gap:28px;list-style:none;align-items:center;}
.nav-links a{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--surface-dark-text-secondary);text-decoration:none;transition:color .2s;font-weight:400;}
.nav-links a:hover,.nav-links a.current{color:var(--gold-light);}
.nav-cta{background:var(--gold);color:white!important;padding:10px 22px;letter-spacing:.12em;font-size:11px;white-space:nowrap;transition:background .2s!important;}
.nav-cta:hover{background:var(--gold-light)!important;}
/* Selector doubled with .nav-links a… because that rule (0,1,1) outranks a bare
   class (0,1,0) and would otherwise force this link to the stone nav-link colour
   and 12px. The main site's version is a <button>, which .nav-links a never
   matched, so this only bites where the control is a link. */
.nav-shortlist-btn,.nav-links a.nav-shortlist-btn{position:relative;background:transparent;border:1px solid rgba(184,150,60,.4);color:var(--gold);padding:8px 16px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-family:'Jost',sans-serif;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:7px;white-space:nowrap;text-decoration:none;}
/* This page had no hover state for the shortlist control at all — added for parity
   with the main site and /stones/. */
.nav-shortlist-btn:hover,.nav-links a.nav-shortlist-btn:hover{background:var(--gold);color:white;border-color:var(--gold);}
footer{background:var(--surface-dark);padding:64px 48px 32px;}
.footer-top{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:48px;padding-bottom:48px;border-bottom:1px solid rgba(200,184,154,.12);margin-bottom:32px;max-width:1280px;margin-left:auto;margin-right:auto;}
.footer-tagline{font-size:13px;color:var(--surface-dark-text-muted);line-height:1.7;max-width:280px;margin-top:16px;}
.footer-col-title{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold-light);margin-bottom:20px;}
.footer-links{list-style:none;display:flex;flex-direction:column;gap:10px;}
.footer-links a{font-size:13px;color:var(--surface-dark-text-secondary);text-decoration:none;transition:color .2s;}
.footer-links a:hover{color:var(--surface-dark-text);}
.footer-bottom{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--surface-dark-text-faint);letter-spacing:.06em;flex-wrap:wrap;gap:12px;max-width:1280px;margin-left:auto;margin-right:auto;}
.footer-acknowledgement{font-size:11px;color:var(--surface-dark-text-faint);line-height:1.7;max-width:1280px;margin:0 auto 20px;}
`;

// Drive helpers (mirrors build-images.js)
async function driveGet(url, token, raw=false){
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{Authorization:`Bearer ${token}`}},res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ if(res.statusCode!==200){reject(new Error(`Drive ${res.statusCode}: ${d.slice(0,100)}`));return;} resolve(raw?d:JSON.parse(d)); });
    }).on('error',reject);
  });
}
async function driveGetBuffer(url, token){
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{Authorization:`Bearer ${token}`}},res=>{
      const chunks=[]; res.on('data',c=>chunks.push(c));
      res.on('end',()=>{ if(res.statusCode!==200){reject(new Error(`Drive ${res.statusCode}`));return;} resolve(Buffer.concat(chunks)); });
    }).on('error',reject);
  });
}
async function getAccessToken(){
  const now=Math.floor(Date.now()/1000);
  const claim={iss:SA_EMAIL,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600};
  const b64url=d=>{const b=typeof d==='string'?Buffer.from(d):d;return b.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');};
  const h=b64url(JSON.stringify({alg:'RS256',typ:'JWT',kid:KEY_ID}));
  const p=b64url(JSON.stringify(claim));
  const sig=crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(RAW_KEY);
  const jwt=`${h}.${p}.${b64url(sig)}`;
  const body=`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{const j=JSON.parse(d);j.access_token?resolve(j.access_token):reject(new Error(j.error_description||d));});
    });
    req.on('error',reject);req.write(body);req.end();
  });
}

main().catch(e=>{ console.error('Stone pages failed:', e); process.exit(1); });

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
${jsonld?`<script type="application/ld+json">${jsonld}</script>`:''}
</head>
<body>
<div class="topbar"><div>Melbourne Natural Stone Gallery &mdash; Direct from the Source to Your Project</div></div>
<nav><a class="logo" href="/">Victoria Stone Gallery</a><div class="links"><a href="/#gallery">Gallery</a><a href="/catalogue/">Catalogue</a><a href="/stones/">Stone Guide</a><a href="/#contact">Contact</a></div></nav>
${body}
<footer><div>&copy; ${new Date().getFullYear()} Victoria Stone Gallery &middot; Melbourne</div><div>37&ndash;39 Gaine Road, Dandenong South VIC 3175 &middot; 03 9702 7539</div></footer>
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
  const hero = lotsWithImg[0] ? manifest[lotsWithImg[0].lot] : null;
  const finishes = [...new Set(avail.map(l=>l.fin).filter(Boolean))].sort();
  const ths = [...new Set(avail.map(l=>l.th).filter(Boolean))].sort((a,b)=>a-b);
  const maxw = Math.max(0,...avail.map(l=>l.w)), maxh = Math.max(0,...avail.map(l=>l.h));
  const eta = v.transitEtas.sort()[0];
  const matSlug = MAT_SLUG[v.material]||'';
  const cards = lotsWithImg.slice(0,6).map(l=>{
    const e = manifest[l.lot];
    const srcset = e.slabSrcset ? ` srcset="${esc(e.slabSrcset)}" sizes="(max-width:700px) 100vw, 33vw"` : '';
    const qty = showSlabs ? `${l.slabs} slab${l.slabs!==1?'s':''} &middot; ` : '';
    return `<div class="lot-card"><img src="${e.slab}"${srcset} alt="${esc(v.name)} ${esc((v.material||'').toLowerCase())} &mdash; lot ${esc(displayLot(l.lot))}" loading="lazy"><div class="lot-meta"><span>Lot ${esc(displayLot(l.lot))}</span><span>${qty}${l.th}mm ${esc(l.fin)}</span></div></div>`;
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

    // featured: curated list, else auto = most lots among photographed standalones
    const curated = (FEATURED[m]||[]).map(n=>byName[n]).filter(Boolean);
    const featured = curated.length ? curated
      : standalone.filter(e=>e.thumb).sort((a,b)=>b.lotCount-a.lotCount).slice(0,6);
    const featNames = new Set(featured.map(e=>e.name));
    const rest = standalone.filter(e=>!featNames.has(e.name));

    const famCards = famNames.map(f=>{
      const members = famsHere[f].sort((a,b)=>a.name.localeCompare(b.name));
      const flagship = members.filter(e=>e.thumb).sort((a,b)=>b.lotCount-a.lotCount)[0]||members[0];
      const lots = members.reduce((a,e)=>a+e.lotCount,0);
      return `<details class="family"><summary class="tile family-card"><span class="tile-img">${flagship.thumb?`<img src="${flagship.thumb}" alt="${esc(f)} family close up" loading="lazy">`:''}</span><div class="tile-name">${esc(f)}</div><div class="tile-sub">${members.length} varieties &middot; ${lots} lots</div></summary><div class="family-members">${members.map(tile).join('')}</div></details>`;
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
    const firstImg = avail.map(l=>manifest[l.lot]?.slab).find(Boolean);
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
.topbar{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--stone-dark);padding:10px 5vw;border-bottom:1px solid rgba(200,184,154,.12)}
nav{padding:18px 5vw;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(200,184,154,.08)}
.logo{font-family:'Cormorant Garamond',serif;font-size:19px;letter-spacing:.2em;text-transform:uppercase;text-decoration:none}
nav .links a{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--stone);text-decoration:none;margin-left:26px}
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
.lot-card img{width:100%;aspect-ratio:16/9.5;object-fit:cover;display:block}
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
footer{border-top:1px solid rgba(200,184,154,.1);padding:34px 5vw;font-size:11px;letter-spacing:.06em;color:var(--mid);display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
@media(max-width:820px){header.stone{grid-template-columns:1fr}.specs{transform:none;margin-top:26px}}`;

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

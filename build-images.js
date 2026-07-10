// VSG Image Pipeline — Netlify Build Script (v2 — parallel + incremental)
import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { createWriteStream, mkdirSync } from 'fs';

const SA_EMAIL = process.env.VSG_SERVICE_ACCOUNT_EMAIL;
const KEY_ID   = process.env.VSG_PRIVATE_KEY_ID;
const RAW_KEY  = (process.env.VSG_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STOCK_FOLDER_ID   = '1BtszKasn-t-haVTX7JzUWTPhuriZsCCq';
const MANIFEST_FILENAME = 'image-manifest.json';

const OUT_DIR     = path.join(process.cwd(), 'img');
const SLAB_DIR    = path.join(OUT_DIR, 'slabs');
const PROJECT_DIR = path.join(OUT_DIR, 'projects');
const CACHE_FILE  = '/opt/build/cache/vsg-image-cache.json'; // Netlify persistent cache
const CDN_MANIFEST = path.join(process.cwd(), 'image-manifest-cdn.json');

const QUALITY  = 90;
const WIDTHS   = [400, 800, 1200, 1600];
const PARALLEL = 8; // concurrent image downloads+process
const TIMEOUT_BUFFER_MS = 3 * 60 * 1000; // stop 3min before limit to save cache+manifest

async function main() {
  if (!SA_EMAIL || !RAW_KEY) { console.error('Missing env vars'); process.exit(1); }
  const startTime = Date.now();
  const BUILD_LIMIT_MS = (parseInt(process.env.BUILD_TIMEOUT_MIN || '24') * 60 * 1000);

  console.log('VSG Image Pipeline v2 starting...');
  const sharp = (await import('sharp')).default;
  const token = await getAccessToken();
  console.log('Authenticated');

  const cache = loadCache();
  console.log(`Cache: ${Object.keys(cache).length} entries`);

  const manifest = await fetchManifest(token);
  if (!manifest) { console.error('No manifest'); process.exit(1); }
  console.log(`Manifest: ${Object.keys(manifest).length} lots`);

  mkdirSync(SLAB_DIR,    { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  // Build work queue — slabs first (higher priority), then projects
  const queue = [];
  for (const [lot, entry] of Object.entries(manifest)) {
    if (entry.slab) queue.push({ type: 'slab', lot, url: entry.slab });
  }
  for (const [lot, entry] of Object.entries(manifest)) {
    if (entry.projects) entry.projects.forEach((url, i) =>
      queue.push({ type: 'project', lot, idx: i, url })
    );
  }
  console.log(`Queue: ${queue.length} images to check`);

  // Process in parallel batches
  let processed = 0, skipped = 0, errors = 0;
  const results = {}; // lot -> {slab, projects[]}

  const isTimedOut = () => (Date.now() - startTime) > (BUILD_LIMIT_MS - TIMEOUT_BUFFER_MS);

  for (let i = 0; i < queue.length; i += PARALLEL) {
    if (isTimedOut()) {
      console.log(`⚠ Time limit approaching — stopping at ${i}/${queue.length} images`);
      break;
    }
    const batch = queue.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async item => {
      try {
        const fileId = extractFileId(item.url);
        const cacheKey = fileId;
        // Quick metadata check — skip if md5 unchanged
        const meta = await getDriveMeta(fileId, token);
        if (cache[cacheKey]?.md5 === meta.md5Checksum) {
          // Verify output file still exists
          const cachedPath = cache[cacheKey].path800;
          if (cachedPath && fs.existsSync(cachedPath)) {
            recordResult(results, item, cache[cacheKey]);
            skipped++; return;
          }
        }
        // Download and process
        const tmpPath = `/tmp/vsg_${fileId}`;
        await downloadFile(fileId, tmpPath, token);
        const paths = await generateWebP(tmpPath, item, sharp);
        cache[cacheKey] = { md5: meta.md5Checksum, ...paths };
        recordResult(results, item, paths);
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        processed++;
        if (processed % 20 === 0) console.log(`  ${processed} processed, ${skipped} skipped...`);
      } catch(e) {
        console.warn(`  Error ${item.lot}[${item.type}]: ${e.message}`);
        errors++;
      }
    }));
  }

  // Build CDN manifest from results + cache for any not yet processed
  const cdnManifest = {};
  for (const [lot, entry] of Object.entries(manifest)) {
    const r = results[lot] || {};
    const slabId = entry.slab ? extractFileId(entry.slab) : null;
    const slab800  = slabId && cache[slabId]?.path800;
    const slab1200 = slabId && cache[slabId]?.path1200;
    const projects = (entry.projects || []).map((url, i) => {
      const id = extractFileId(url);
      return { thumb: cache[id]?.path800 || null, full: cache[id]?.path1200 || cache[id]?.path800 || null };
    }).filter(p => p.thumb);
    if (slab800 || projects.length) {
      cdnManifest[lot] = {
        slab:      slab800  || null,
        slabFull:  slab1200 || slab800 || null,
        slabSrcset: slabId ? buildSrcset(cache[slabId]) : null,
        projects:      projects.map(p => p.thumb),
        projectsFull:  projects.map(p => p.full),
        projectCount:  projects.length
      };
    }
  }

  // Save everything
  saveCache(cache);
  fs.writeFileSync(CDN_MANIFEST, JSON.stringify({
    built: new Date().toISOString(),
    source: 'netlify-cdn',
    slabMatches: Object.values(cdnManifest).filter(e=>e.slab).length,
    projectMatches: Object.values(cdnManifest).filter(e=>e.projectCount).length,
    manifest: cdnManifest
  }));

  const elapsed = ((Date.now()-startTime)/1000/60).toFixed(1);
  console.log(`\n✓ Done in ${elapsed}min — processed:${processed} skipped:${skipped} errors:${errors}`);
  console.log(`  CDN manifest: ${Object.keys(cdnManifest).length} lots`);
}

function recordResult(results, item, paths) {
  if (!results[item.lot]) results[item.lot] = { slab: null, projects: [] };
  if (item.type === 'slab') results[item.lot].slab = paths.path800;
  else results[item.lot].projects[item.idx] = paths.path800;
}

function buildSrcset(paths) {
  if (!paths) return null;
  return WIDTHS.map(w => paths[`path${w}`] ? `${paths[`path${w}`]} ${w}w` : null).filter(Boolean).join(', ');
}

async function generateWebP(tmpPath, item, sharp) {
  const safeBase = `${item.lot.replace(/[^a-z0-9\-_]/gi,'_')}${item.type==='project'?`_p${item.idx+1}`:''}`;
  const subDir = item.type === 'project' ? path.join(PROJECT_DIR, item.lot.replace(/[^a-z0-9\-_]/gi,'_')) : SLAB_DIR;
  mkdirSync(subDir, { recursive: true });
  const paths = {};
  for (const w of WIDTHS) {
    const outFile = path.join(subDir, `${safeBase}-${w}.webp`);
    await sharp(tmpPath).resize(w, null, { withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(outFile);
    paths[`path${w}`] = '/' + path.relative(process.cwd(), outFile);
  }
  return paths;
}

async function fetchManifest(token) {
  const res = await driveGet(`https://www.googleapis.com/drive/v3/files?q='${STOCK_FOLDER_ID}'+in+parents+and+name='${MANIFEST_FILENAME}'+and+trashed=false&fields=files(id)`, token);
  if (!res.files?.length) return null;
  const text = await driveGet(`https://www.googleapis.com/drive/v3/files/${res.files[0].id}?alt=media`, token, true);
  return JSON.parse(text).manifest;
}

async function getDriveMeta(fileId, token) {
  return driveGet(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=md5Checksum,name`, token);
}

async function downloadFile(fileId, dest, token) {
  // Download the original full-resolution file — NOT the thumbnail.
  // Thumbnails are pre-compressed JPEGs; recompressing them to WebP degrades quality.
  // The original file gives Sharp a high-res source to work from.
  return new Promise((resolve, reject) => {
    const options = { headers: { Authorization: `Bearer ${token}` } };
    https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, options, res => {
      if (res.statusCode === 403 || res.statusCode === 404) {
        reject(new Error(`HTTP ${res.statusCode} for file ${fileId}`)); return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const ws = createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', resolve); ws.on('error', reject);
    }).on('error', reject);
  });
}

function extractFileId(url) {
  const m = url.match(/[?&]id=([^&]+)/);
  return m ? m[1] : url;
}

async function driveGet(url, token, raw = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`Drive ${res.statusCode}: ${d.slice(0,100)}`)); return; }
        resolve(raw ? d : JSON.parse(d));
      });
    }).on('error', reject);
  });
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCache(cache) {
  try { mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch(e) { console.warn('Cache save failed:', e.message); }
}

// JWT Auth
async function getAccessToken() {
  const now = Math.floor(Date.now()/1000);
  const claim = { iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now+3600 };
  const h = b64url(JSON.stringify({ alg:'RS256', typ:'JWT', kid:KEY_ID }));
  const p = b64url(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(RAW_KEY);
  const jwt = `${h}.${p}.${b64url(sig)}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ const j=JSON.parse(d); j.access_token?resolve(j.access_token):reject(new Error(j.error_description||d)); });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}
function b64url(data) {
  const buf = typeof data==='string'?Buffer.from(data):data;
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

main().catch(e => { console.error('Pipeline failed:', e); process.exit(1); });

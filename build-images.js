// VSG Image Pipeline — Netlify Build Script
// Runs on Netlify's build servers after each GitHub push.
// Downloads slab and project images from Google Drive,
// generates WebP variants, and writes a static manifest.
//
// Environment variables required (set in Netlify dashboard):
//   VSG_PRIVATE_KEY          — service account PEM key (with \n newlines)
//   VSG_PRIVATE_KEY_ID       — key ID
//   VSG_SERVICE_ACCOUNT_EMAIL — service account email

import fs   from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';

// ── CONFIG ────────────────────────────────────────────────────
const SA_EMAIL   = process.env.VSG_SERVICE_ACCOUNT_EMAIL;
const KEY_ID     = process.env.VSG_PRIVATE_KEY_ID;
const RAW_KEY    = (process.env.VSG_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const STOCK_FOLDER_ID   = '1BtszKasn-t-haVTX7JzUWTPhuriZsCCq';
const SLAB_FOLDER_ID    = '1e2uzwpG0iOzg7O79F-aqMXeUsUIVF-AA';
const PROJECT_FOLDER_ID = '13meCoYDTCLZ9_CuHO2JjgxoTAlg_ElEv';
const MANIFEST_FILENAME = 'image-manifest.json';

const OUT_DIR     = path.join(process.cwd(), 'img');        // output into site
const SLAB_DIR    = path.join(OUT_DIR, 'slabs');
const PROJECT_DIR = path.join(OUT_DIR, 'projects');
const CACHE_FILE  = path.join(process.cwd(), '.image-cache.json'); // persisted by Netlify cache

const WIDTHS      = [400, 800, 1600];  // px — grid thumb, modal, lightbox
const QUALITY     = 82;

// ── ENTRY POINT ───────────────────────────────────────────────
async function main() {
  if (!SA_EMAIL || !RAW_KEY) {
    console.error('Missing VSG_SERVICE_ACCOUNT_EMAIL or VSG_PRIVATE_KEY env vars');
    process.exit(1);
  }
  console.log('VSG Image Pipeline starting...');

  // Import sharp (installed by Netlify from package.json)
  const sharp = (await import('sharp')).default;

  // 1. Auth
  const token = await getAccessToken();
  console.log('Authenticated to Drive');

  // 2. Load existing cache (from Netlify persistent cache)
  const cache = loadCache();
  console.log(`Cache: ${Object.keys(cache).length} previously processed files`);

  // 3. Read manifest from Apps Script (already built by stock sync)
  const manifest = await fetchManifest(token);
  if (!manifest) { console.error('No manifest found — run Apps Script first'); process.exit(1); }
  console.log(`Manifest: ${Object.keys(manifest).length} lots with images`);

  // 4. Process images
  mkdirSync(SLAB_DIR,    { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  let processed = 0, skipped = 0, errors = 0;
  const newManifest = {};

  for (const [lot, entry] of Object.entries(manifest)) {
    const lotEntry = { slab: null, slabSrcset: null, projects: [], projectCount: 0 };

    // Slab image
    if (entry.slab) {
      const fileId = extractFileId(entry.slab);
      try {
        const result = await processImage(fileId, lot, 'slab', SLAB_DIR, sharp, token, cache);
        if (result) {
          lotEntry.slab      = result.default;   // 800px — primary
          lotEntry.slabSrcset = result.srcset;   // full srcset string
          if (result.cached) skipped++; else processed++;
        }
      } catch(e) { console.warn(`  Slab ${lot}: ${e.message}`); errors++; }
    }

    // Project images
    for (let i = 0; i < entry.projects.length; i++) {
      const fileId = extractFileId(entry.projects[i]);
      const scene  = path.join(lot, String(i+1).padStart(2,'0'));
      try {
        const result = await processImage(fileId, scene, 'project', PROJECT_DIR, sharp, token, cache);
        if (result) {
          lotEntry.projects.push({ src: result.default, srcset: result.srcset });
          if (result.cached) skipped++; else processed++;
        }
      } catch(e) { console.warn(`  Project ${lot}[${i}]: ${e.message}`); errors++; }
    }
    lotEntry.projectCount = lotEntry.projects.length;
    if (lotEntry.slab || lotEntry.projectCount) newManifest[lot] = lotEntry;
  }

  // 5. Write static manifest pointing to Netlify CDN paths
  const staticManifest = {
    built:   new Date().toISOString(),
    source:  'netlify-cdn',
    lots:    Object.keys(manifest).length,
    slabMatches:    Object.values(newManifest).filter(e=>e.slab).length,
    projectMatches: Object.values(newManifest).filter(e=>e.projectCount).length,
    manifest: newManifest
  };
  fs.writeFileSync(
    path.join(process.cwd(), 'image-manifest-cdn.json'),
    JSON.stringify(staticManifest)
  );

  // 6. Save updated cache
  saveCache(cache);

  console.log(`\n✓ Pipeline complete:`);
  console.log(`  Processed: ${processed}  Skipped (cached): ${skipped}  Errors: ${errors}`);
  console.log(`  Output manifest: image-manifest-cdn.json`);
  console.log(`  ${staticManifest.slabMatches} slab matches, ${staticManifest.projectMatches} project matches`);
}

// ── IMAGE PROCESSING ──────────────────────────────────────────
async function processImage(fileId, name, type, outDir, sharp, token, cache) {
  // Check cache — skip if md5 unchanged
  const meta   = await getDriveMeta(fileId, token);
  const cacheKey = fileId;
  if (cache[cacheKey] && cache[cacheKey].md5 === meta.md5Checksum) {
    return { ...cache[cacheKey].paths, cached: true };
  }

  // Download original
  const tmpPath = path.join('/tmp', `vsg_${fileId}`);
  await downloadDriveFile(fileId, tmpPath, token);

  // Generate WebP variants
  const safeBase = String(name).replace(/[^a-z0-9\-_\/]/gi,'_');
  const subDir   = type === 'project' ? path.join(outDir, path.dirname(safeBase)) : outDir;
  mkdirSync(subDir, { recursive: true });
  const baseName = path.basename(safeBase);

  const paths = {};
  const srcsetParts = [];
  for (const w of WIDTHS) {
    const outFile = path.join(subDir, `${baseName}-${w}.webp`);
    await sharp(tmpPath)
      .resize(w, null, { withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toFile(outFile);
    const relPath = '/' + path.relative(process.cwd(), outFile);
    srcsetParts.push(`${relPath} ${w}w`);
    if (w === 800) paths.default = relPath;
  }
  paths.srcset = srcsetParts.join(', ');

  // Update cache
  cache[cacheKey] = { md5: meta.md5Checksum, paths };

  // Clean up tmp
  try { fs.unlinkSync(tmpPath); } catch(e) {}

  return { ...paths, cached: false };
}

// ── DRIVE HELPERS ─────────────────────────────────────────────
async function fetchManifest(token) {
  const res = await driveRequest(
    `https://www.googleapis.com/drive/v3/files?q='${STOCK_FOLDER_ID}'+in+parents+and+name='${MANIFEST_FILENAME}'+and+trashed=false&fields=files(id)`,
    token
  );
  const files = res.files || [];
  if (!files.length) return null;
  const content = await driveRequest(
    `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`,
    token, true
  );
  return typeof content === 'string' ? JSON.parse(content).manifest : content.manifest;
}

async function getDriveMeta(fileId, token) {
  return driveRequest(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=md5Checksum,name`,
    token
  );
}

async function downloadDriveFile(fileId, dest, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  return new Promise((resolve, reject) => {
    const options = { headers: { Authorization: `Bearer ${token}` } };
    https.get(url, options, res => {
      if (res.statusCode !== 200) { reject(new Error(`Drive download ${res.statusCode}`)); return; }
      const ws = createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function extractFileId(driveUrl) {
  const m = driveUrl.match(/[?&]id=([^&]+)/);
  return m ? m[1] : driveUrl;
}

async function driveRequest(url, token, raw = false) {
  return new Promise((resolve, reject) => {
    const options = { headers: { Authorization: `Bearer ${token}` } };
    https.get(url, options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`Drive API ${res.statusCode}: ${data.slice(0,200)}`)); return; }
        resolve(raw ? data : JSON.parse(data));
      });
    }).on('error', reject);
  });
}

// ── JWT / AUTH ────────────────────────────────────────────────
async function getAccessToken() {
  const now  = Math.floor(Date.now() / 1000);
  const claim = { iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/drive.readonly',
                  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID }));
  const payload = b64url(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(RAW_KEY);
  const jwt = `${header}.${payload}.${b64url(sig)}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ const j=JSON.parse(d); j.access_token?resolve(j.access_token):reject(new Error(j.error_description||d)); }); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}
function b64url(data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ── CACHE ─────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

main().catch(e => { console.error('Pipeline failed:', e); process.exit(1); });

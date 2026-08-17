// VSG Category Image Pipeline — pulls the nine stone-knowledge article images
// straight from the Drive "Category Close-Ups" folder at build time.
//
// Drop a correctly named JPEG in that folder and it goes live on the next build.
// No repo commit, no manual conversion, no HTML edit.
//
// FAIL-SAFE BY DESIGN. This script never fails the build and never overwrites a
// good image with a bad fetch. Same lesson as vsg-sync.sh: write to a temp path,
// validate, and only then move into place. If Drive is unreachable, if the folder
// is empty, if a download returns HTTP 200 with a truncated body — the previous
// image survives (restored from netlify-plugin-cache) and the build continues.
//
// Output: category-images/<slug>.webp  (1600x1200, ~4:3, matching .related-card)
//
// NOTE ON CACHE HEADERS: these live OUTSIDE /img/ deliberately. /img/* is served
// immutable for a year, which is correct for lot photos (their filenames change
// when the photo changes) but wrong here, where the filename is stable and the
// content is what changes. netlify.toml gives category-images/* a short TTL so a
// replaced photo actually reaches browsers.

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import os from 'os';

const SA_EMAIL = process.env.VSG_SERVICE_ACCOUNT_EMAIL;
const KEY_ID   = process.env.VSG_PRIVATE_KEY_ID;
const RAW_KEY  = (process.env.VSG_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const FOLDER_ID = '1MwX07Lx4hzNSlBeL7YcAkE4d8TQlujYc'; // "Category Close-Ups"
const OUT_DIR   = path.join(process.cwd(), 'category-images');
const WIDTH = 1600, HEIGHT = 1200, QUALITY = 82;

// Only these nine slugs are accepted. Anything else in the folder is ignored, so
// stray files, exports and "marble copy.jpg" can sit there without doing damage.
const SLUGS = new Set([
  'marble','granite','quartzite','limestone','dolomite','travertine',
  'care-and-maintenance','finishes-guide','buying-guide',
]);

async function main() {
  if (!SA_EMAIL || !RAW_KEY) {
    console.log('[category-images] No service account env vars — skipping.');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let sharp, token, files;
  try {
    sharp = (await import('sharp')).default;
    token = await getAccessToken();
    files = await listFolder(FOLDER_ID, token);
  } catch (e) {
    console.log(`[category-images] Setup failed (${e.message}) — keeping existing images.`);
    return;
  }

  if (!files.length) {
    console.log('[category-images] Folder returned no files — keeping existing images.');
    return;
  }

  // Map slug -> newest matching file, so a re-upload wins over an older duplicate.
  const wanted = new Map();
  for (const f of files) {
    if (!/\.(jpe?g|png|webp)$/i.test(f.name)) continue;
    const slug = f.name.replace(/\.[^.]+$/, '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!SLUGS.has(slug)) continue;
    const prev = wanted.get(slug);
    if (!prev || new Date(f.modifiedTime) > new Date(prev.modifiedTime)) wanted.set(slug, f);
  }

  const missing = [...SLUGS].filter(s => !wanted.has(s));
  if (missing.length) console.log(`[category-images] Not in Drive: ${missing.join(', ')}`);

  const cachePath = path.join(OUT_DIR, '.cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}

  let written = 0, skipped = 0, failed = 0;

  for (const [slug, f] of wanted) {
    const finalPath = path.join(OUT_DIR, `${slug}.webp`);
    const stamp = `${f.id}:${f.modifiedTime}:${f.size || ''}`;

    if (cache[slug] === stamp && fs.existsSync(finalPath)) { skipped++; continue; }

    const tmpSrc = path.join(os.tmpdir(), `cat-${slug}-${Date.now()}`);
    const tmpOut = `${finalPath}.tmp`;
    try {
      await downloadFile(f.id, tmpSrc, token);

      // Validate BEFORE touching the live file. A truncated or non-image body
      // throws here, and the existing .webp is left exactly as it was.
      const meta = await sharp(tmpSrc).metadata();
      if (!meta.width || !meta.height) throw new Error('unreadable image');
      if (meta.width < 800) throw new Error(`too small (${meta.width}px wide)`);

      await sharp(tmpSrc)
        .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
        .webp({ quality: QUALITY })
        .toFile(tmpOut);

      const size = fs.statSync(tmpOut).size;
      if (size < 5000) throw new Error(`output suspiciously small (${size}B)`);

      fs.renameSync(tmpOut, finalPath);   // atomic swap, last step only
      cache[slug] = stamp;
      written++;
      console.log(`[category-images] ${slug}.webp  ${(size/1024|0)}KB  <- ${f.name}`);
    } catch (e) {
      failed++;
      console.log(`[category-images] ${slug}: ${e.message} — keeping previous image.`);
    } finally {
      for (const p of [tmpSrc, tmpOut]) { try { fs.unlinkSync(p); } catch {} }
    }
  }

  try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1)); } catch {}

  const onDisk = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.webp'));
  console.log(`[category-images] ${written} written, ${skipped} unchanged, ${failed} failed; ${onDisk.length}/9 present.`);
}

function listFolder(folderId, token) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}`
            + `&fields=files(id,name,modifiedTime,size)&pageSize=100`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${token}` } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Drive list HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d).files || []); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(fileId, dest, token) {
  return new Promise((resolve, reject) => {
    https.get(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }, res => {
        if (res.statusCode !== 200) return reject(new Error(`download HTTP ${res.statusCode}`));
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', resolve); ws.on('error', reject);
      }).on('error', reject);
  });
}

async function getAccessToken() {
  const now = Math.floor(Date.now()/1000);
  const claim = { iss: SA_EMAIL, scope: 'https://www.googleapis.com/auth/drive.readonly',
                  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now+3600 };
  const h = b64url(JSON.stringify({ alg:'RS256', typ:'JWT', kid:KEY_ID }));
  const p = b64url(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(RAW_KEY);
  const jwt = `${h}.${p}.${b64url(sig)}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'oauth2.googleapis.com', path:'/token', method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try { const j=JSON.parse(d); j.access_token?resolve(j.access_token):reject(new Error(j.error_description||d)); } catch(e){ reject(e); } });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

function b64url(data) {
  const buf = typeof data==='string'?Buffer.from(data):data;
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// Never fail the build. A broken image is a cosmetic problem; a failed build
// takes the whole site's next deploy with it.
main().catch(e => { console.log('[category-images] Unexpected error, continuing:', e.message); });

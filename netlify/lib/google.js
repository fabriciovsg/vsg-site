// VSG — shared Google Drive access for Netlify Functions.
//
// The service account credential lives ONLY in environment variables here.
// It is never sent to the browser. Same three variables the build already
// uses (build-images.js), so nothing new needs provisioning — but check the
// variable Scopes in Netlify include "Functions", not just "Builds".
//
// Read paths request drive.readonly. The write scope is deliberately NOT
// available from this module; admin writes get their own function in Phase 2.

import crypto from 'node:crypto';

const SA_EMAIL = process.env.VSG_SERVICE_ACCOUNT_EMAIL;
const KEY_ID   = process.env.VSG_PRIVATE_KEY_ID;
const RAW_KEY   = (process.env.VSG_PRIVATE_KEY || '').replace(/\\n/g, '\n');

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Folder IDs — verified against the live pages 3 Aug 2026.
// If a folder ID stops working, open the folder in Drive and copy from the URL.
export const STOCK_FOLDER_ID          = '1BtszKasn-t-haVTX7JzUWTPhuriZsCCq';
export const SLAB_IMAGES_FOLDER_ID    = '1e2uzwpG0iOzg7O79F-aqMXeUsUIVF-AA';
export const PROJECT_IMAGES_FOLDER_ID = '13meCoYDTCLZ9_CuHO2JjgxoTAlg_ElEv';
export const SITE_CONFIG_FILE_ID      = '1-CM8zoEfnObuVY53OW5chE_3jTJTQE1-';

const READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function b64url(data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Token cache lives in module scope, so it survives across warm invocations
// of the same function instance. Cold starts pay one token exchange.
let _token = null;
let _tokenExpiry = 0;

export async function getAccessToken() {
  if (!SA_EMAIL || !RAW_KEY) {
    throw new Error('Missing VSG_SERVICE_ACCOUNT_EMAIL or VSG_PRIVATE_KEY — check the variable Scopes include Functions');
  }
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID }));
  const claim  = b64url(JSON.stringify({
    iss: SA_EMAIL,
    scope: READONLY_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(RAW_KEY));
  const assertion = `${header}.${claim}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    // Do not echo the response body — it can contain credential detail.
    throw new Error(`Token exchange failed (${resp.status})`);
  }
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

async function driveFetch(url, init = {}) {
  const token = await getAccessToken();
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

/** List children of a folder. Returns [] on any non-200 (matches page behaviour). */
export async function driveList(folderId, extraQuery = '') {
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false${extraQuery ? ' and ' + extraQuery : ''}`
  );
  const url = `${DRIVE_API}/files?q=${q}&fields=files(id,name,mimeType,modifiedTime)&pageSize=1000`;
  const resp = await driveFetch(url);
  if (!resp.ok) return [];
  return (await resp.json()).files || [];
}

/** Find one file by exact name within a folder. Returns null if absent. */
export async function driveFindFile(folderId, filename) {
  const safe = String(filename).replace(/'/g, "\\'");
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and name='${safe}'`);
  const url = `${DRIVE_API}/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1`;
  const resp = await driveFetch(url);
  if (!resp.ok) return null;
  return ((await resp.json()).files || [])[0] || null;
}

/** Read a file's bytes by ID. */
export async function driveReadBytes(fileId) {
  const resp = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!resp.ok) throw new Error(`Drive read failed (${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}

/** Read a file's contents as text. */
export async function driveReadText(fileId) {
  const resp = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!resp.ok) throw new Error(`Drive read failed (${resp.status})`);
  return await resp.text();
}

// GET /api/file?name=location-map.json
//
// Serves a small set of named JSON files from the Stock folder.
//
// The whitelist is the entire security model here. The Stock folder also holds
// clients.json — customer names, emails, passwords and pricing tiers — which
// the main page currently fetches into every anonymous visitor's browser at
// load. That file is NOT in this whitelist and must never be. Client data gets
// an authenticated endpoint in Phase 2 that returns only the logged-in
// client's own tier, never the list.

import { driveFindFile, driveReadText, STOCK_FOLDER_ID } from '../lib/google.js';
import { guard, json, fail, cacheControl } from '../lib/http.js';

const ALLOWED = new Set([
  'location-map.json',
  'image-manifest.json',
  'colour-cache.json',
]);

export default guard(async (req) => {
  const name = new URL(req.url).searchParams.get('name');

  if (!name) return fail(req, 400, 'Missing name parameter');
  if (!ALLOWED.has(name)) return fail(req, 403, 'File not available via this endpoint');

  const file = await driveFindFile(STOCK_FOLDER_ID, name);
  if (!file) return fail(req, 404, 'Not found');

  const text = await driveReadText(file.id);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(req, 502, 'File is not valid JSON');
  }

  return json(req, parsed, {
    cache: cacheControl(60, 300),
    extra: { 'X-VSG-Modified': file.modifiedTime || '' },
  });
});

export const config = { path: '/api/file' };

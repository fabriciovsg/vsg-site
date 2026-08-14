// GET /api/direct-image?lot=NZ1001            slab photo
// GET /api/direct-image?lot=NZ1001&render=0   room scene
//
// The NZ folder is shared Restricted, so Drive thumbnail URLs render for nobody
// — proxying is the only way these images reach the page. That is also the
// right outcome: the photos never enter the public repo and the folder never
// needs "anyone with the link".
//
// Unlike /api/direct-stock this IS CDN-cached. The bytes are identical for
// every viewer and carry no commercial terms, so one Drive fetch per image per
// day is the whole cost. Photos added by the maintainer appear immediately —
// no build, unlike the Melbourne CDN pipeline which waits for the 17:00 deploy.
//
// No slug check here deliberately: it would defeat the CDN cache (the response
// would have to Vary per customer) for no gain, since a bare lot number reveals
// nothing without the sheet row it belongs to.

import { getAccessToken, DRIVE_API, READONLY_SCOPE } from '../lib/google.js';
import { slabPhotoMap, renderMap, LOT_RE } from '../lib/nz.js';
import { guard, fail, corsHeaders, cacheControl } from '../lib/http.js';

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export default guard(async (req) => {
  const url = new URL(req.url);
  const lot = String(url.searchParams.get('lot') || '').trim().toUpperCase();
  const renderParam = url.searchParams.get('render');

  // Validate the shape before any Drive call — an arbitrary string must never
  // reach a lookup.
  if (!LOT_RE.test(lot)) return fail(req, 400, 'Invalid lot');

  let file = null;

  if (renderParam !== null) {
    const i = Number(renderParam);
    if (!Number.isInteger(i) || i < 0 || i > 50) return fail(req, 400, 'Invalid render index');
    const list = (await renderMap()).get(lot) || [];
    file = list[i] || null;
  } else {
    file = (await slabPhotoMap()).get(lot) || null;
  }

  if (!file) return fail(req, 404, 'Not found');

  const token = await getAccessToken(READONLY_SCOPE);
  const resp = await fetch(`${DRIVE_API}/files/${file.id}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return fail(req, 502, 'Image unavailable');

  const ext = (file.name.match(/\.([^.]+)$/) || [])[1] || 'jpg';
  const bytes = Buffer.from(await resp.arrayBuffer());

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': MIME[ext.toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cacheControl(86400, 86400, 604800),
      'X-Robots-Tag': 'noindex, noimageindex',
      ...corsHeaders(req),
    },
  });
});

export const config = { path: '/api/direct-image' };

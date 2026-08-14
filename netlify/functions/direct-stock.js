// GET /api/direct-stock?slug=nz-trendstone-4k2p
//     Authorization: Bearer <client token>   (optional — unlocks pricing)
//
// NZ direct stock: slabs shipped direct to New Zealand, from a manually
// maintained Google Sheet. Never in Vavastone.
//
// TWO GATES, TWO JOBS:
//   slug   -> whether the stock LIST is visible.   Low friction, low stakes.
//   login  -> whether PRICES are visible.          Higher friction, paid once.
//
// Nobody signs in merely to browse. Prices are stripped SERVER-SIDE and are
// simply absent from the response for anyone not entitled — never sent and
// hidden in the browser, which is not a control for withheld commercial terms.
//
// Never cached at the CDN. A per-customer response in a shared cache is exactly
// how wholesale pricing leaks to the wrong customer.

import {
  readSheetRows, parseRows, slabPhotoMap, renderMap,
  clientForSlug, directTierFor,
} from '../lib/nz.js';
import { verifyToken } from '../lib/auth.js';
import { guard, fail, corsHeaders, bearer } from '../lib/http.js';

export default guard(async (req) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');

  if (!slug) return fail(req, 400, 'Missing slug');

  // One message for every rejection. Distinguishing "no such link" from
  // "revoked" would let someone probe which customers exist.
  const client = await clientForSlug(slug);
  if (!client) return fail(req, 404, 'This link is not valid or has expired');

  // Pricing requires BOTH a valid signed login AND the directPricing flag, and
  // the signed-in client must be the one the slug belongs to — otherwise any
  // trade login would unlock prices on anyone else's link.
  const claims = verifyToken('client', bearer(req));
  const sameClient = claims && claims.email &&
    String(claims.email).toLowerCase() === String(client.email || '').toLowerCase();
  const mayPrice = Boolean(sameClient && claims.directPricing);
  const tier = directTierFor(client);

  const [values, photos, renders] = await Promise.all([
    readSheetRows(), slabPhotoMap(), renderMap(),
  ]);

  const { stones, warnings } = parseRows(values);

  const rows = stones.map((s) => {
    const { _price, _currency, _order, ...pub } = s;

    const photo = photos.get(s.lot);
    const rend = renders.get(s.lot) || [];

    const out = {
      ...pub,
      image: photo ? `/api/direct-image?lot=${encodeURIComponent(s.lot)}` : null,
      renders: rend.map((_, i) =>
        `/api/direct-image?lot=${encodeURIComponent(s.lot)}&render=${i}`),
    };

    // Per-row currency: no global AUD/NZD decision exists, and totalling across
    // currencies is meaningless — the page must group or suppress mixed totals.
    if (mayPrice && _price) {
      out.price = _price;
      out.currency = _currency || 'NZD';
      out.priceBasis = 'per_m2';
      if (s.area) out.slabPrice = +(_price * s.area).toFixed(2);
    }
    return out;
  });

  const body = {
    rows,
    client: { name: client.name || null },  // "Prepared for Trendstone"
    pricing: mayPrice,
    tier: mayPrice ? tier : null,
    counts: {
      total: rows.length,
      inStock: rows.filter(r => r.state === 'in_stock').length,
      onWater: rows.filter(r => r.state === 'on_water').length,
      toOrder: rows.filter(r => r.state === 'to_order').length,
    },
  };

  // Data-quality warnings are for the operator only. A customer should never be
  // shown that the sheet is inconsistent.
  if (claims && claims.admin) body.warnings = warnings;
  if (warnings.length) console.warn('[direct-stock]', warnings.join(' | '));

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Vary': 'Origin, Authorization',
      'X-Robots-Tag': 'noindex, nofollow',
      ...corsHeaders(req),
    },
  });
});

export const config = { path: '/api/direct-stock' };

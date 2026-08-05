// GET /api/stock-rows-client   Authorization: Bearer <client token>
//
// Same rows, plus the one price column the logged-in client is entitled to.
// The tier comes from the signed token issued by /api/client-login, not from
// anything the caller sends — so a client cannot ask for a better tier than
// they were given.
//
// Separate path from the public feed, and never cached: a per-client response
// sitting in a shared CDN cache is exactly how wholesale pricing would leak to
// anonymous visitors. Vary is belt and braces on top of no-store.

import { getStockRows, withPrices } from '../lib/stock.js';
import { verifyToken } from '../lib/auth.js';
import { guard, fail, corsHeaders } from '../lib/http.js';

const VALID_TIERS = ['price1', 'price2', 'price3', 'price4'];

export default guard(async (req) => {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const claims = verifyToken('client', token);
  if (!claims) return fail(req, 401, 'Not signed in');

  const tier = VALID_TIERS.includes(claims.tier) ? claims.tier : 'price1';

  const result = await getStockRows();
  if (!result) return fail(req, 404, 'No stock report found');

  // Exactly one price column: the client's own tier. Retail is not bundled in
  // as a matter of course — a Trade client seeing the Retail figure alongside
  // their own is not something to hand over by default.
  const keep = [tier];
  const rows = withPrices(result.rows, keep);

  return new Response(JSON.stringify({
    rows, tier, file: result.file.name, modified: result.file.modifiedTime,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'Vary': 'Origin, Authorization',
      ...corsHeaders(req),
    },
  });
});

export const config = { path: '/api/stock-rows-client' };

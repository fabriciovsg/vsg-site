// GET /api/stock-rows-admin   Authorization: Bearer <admin token>
//
// Same rows as the public feed, plus ALL four price tiers — for the admin
// Browse Stock triage view (spotting lots with missing prices or tier
// inversions). The token comes from /api/admin-login, same as every other
// admin action.
//
// Mirrors stock-rows-client.js exactly in shape and caching: separate path,
// never cached, Vary on Authorization. A response carrying wholesale pricing
// must never be a cache key mistake away from the anonymous feed.
//
// COST and SPECIAL PRICE are deliberately NOT requested here: withPrices'
// keep-list covers the four tiers, and the browse view doesn't need cost to
// do its job. If cost is ever wanted client-side, decide that on purpose —
// don't widen this list casually.

import { getStockRows, withPrices } from '../lib/stock.js';
import { verifyToken } from '../lib/auth.js';
import { guard, fail, corsHeaders } from '../lib/http.js';

export default guard(async (req) => {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const claims = verifyToken('admin', token);
  if (!claims) return fail(req, 401, 'Not signed in');

  const result = await getStockRows();
  if (!result) return fail(req, 404, 'No stock report found');

  const rows = withPrices(result.rows, ['price1', 'price2', 'price3', 'price4']);

  return new Response(JSON.stringify({
    rows, file: result.file.name, modified: result.file.modifiedTime,
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

export const config = { path: '/api/stock-rows-admin' };

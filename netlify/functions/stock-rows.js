// GET /api/stock-rows
//
// The stock report as JSON row arrays, carrying NO prices at all.
//
// Retail is withheld along with Trade, Bundle, Wholesale and COST: an
// anonymous visitor should not be able to read any price from this site, and
// a figure sitting unused in the JSON is still readable in devtools.
//
// Two page features read PRICE1 — the five-dollar-sign bracket and the price
// range filter — and both degrade safely: calcPriceThresholds returns early
// when no prices are present, and getPriceBracket is guarded by both the value
// and the thresholds flag. If either is ever switched back on for the public
// showroom, the bracket has to be computed server-side and sent as a band
// rather than a number; do not solve it by putting PRICE1 back.
//
// This response is CDN-cached and identical for everybody, which is only safe
// because it contains no per-client data. The authenticated variant lives at a
// separate path precisely so no cache key mistake can ever serve one for the
// other.

import { getStockRows, withPrices } from '../lib/stock.js';
import { guard, json, fail, cacheControl } from '../lib/http.js';

export default guard(async (req) => {
  const result = await getStockRows();
  if (!result) return fail(req, 404, 'No stock report found');

  const rows = withPrices(result.rows, []);

  return json(req, { rows, file: result.file.name, modified: result.file.modifiedTime },
    { cache: cacheControl(60, 300) });
});

export const config = { path: '/api/stock-rows' };

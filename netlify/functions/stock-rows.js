// GET /api/stock-rows
//
// The stock report as JSON row arrays, carrying PRICE1 (Retail) only.
//
// PRICE2/3/4 — Trade, Bundle and Wholesale — are blanked before the response
// leaves the server. The page needs PRICE1 for the price brackets, the price
// filter and calcPriceThresholds; it has never needed the other three unless a
// client is logged in, and those come from /api/stock-rows-client instead.
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

  const rows = withPrices(result.rows, ['price1']);

  return json(req, { rows, file: result.file.name, modified: result.file.modifiedTime },
    { cache: cacheControl(60, 300) });
});

export const config = { path: '/api/stock-rows' };

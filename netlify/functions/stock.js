// GET /api/stock
//
// Returns the most recently modified stock report from the Stock folder as
// raw .xlsx bytes.
//
// Deliberately a byte proxy, not a re-parse. The page's parseStockRows logic
// (column mapping, the FININSHING header typo, lot-vs-block handling, finish
// suffixes) stays exactly where it is and keeps working unchanged. Moving that
// server-side is a worthwhile optimisation later — it would cut the ~716 KB
// payload down hard — but doing it in the same change as the credential
// removal would mean two things failing at once with one symptom.
//
// Selection matches the page: newest file matching ListedReport or
// GrouppedReport, both supported.

import { driveList, driveReadBytes, STOCK_FOLDER_ID } from '../lib/google.js';
import { guard, fail, corsHeaders, cacheControl } from '../lib/http.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export default guard(async (req) => {
  const files = await driveList(STOCK_FOLDER_ID, `mimeType='${XLSX_MIME}'`);

  const reports = files
    .filter(f => /ListedReport|GrouppedReport/i.test(f.name))
    .filter(f => !f.name.startsWith('~$'))          // Excel lock files
    .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

  if (!reports.length) return fail(req, 404, 'No stock report found');

  const file  = reports[0];
  const bytes = await driveReadBytes(file.id);

  // A truncated file is worse than no file — the page would render a partial
  // catalogue and quietly save it as the good snapshot.
  if (bytes.length < 10_000) return fail(req, 502, 'Stock file looks incomplete');

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Length': String(bytes.length),
      // Sync runs every 30 min; 5 min of CDN cache keeps it fresh enough
      // while collapsing bursts of visitors onto one Drive read.
      'Cache-Control': cacheControl(60, 300),
      'X-VSG-Stock-File': file.name,
      'X-VSG-Stock-Modified': file.modifiedTime || '',
      // Let the browser read those two headers cross-origin.
      'Access-Control-Expose-Headers': 'X-VSG-Stock-File, X-VSG-Stock-Modified',
      ...corsHeaders(req),
    },
  });
});

export const config = { path: '/api/stock' };

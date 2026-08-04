// VSG — shared HTTP helpers for the API functions.
//
// CORS matters because the Email Builder and Sign Generator are separate
// Netlify Drop sites. They deploy by drag-and-drop with no build step, so
// they can never receive a build-time environment variable — they have to
// call these functions cross-origin instead.

const STATIC_ALLOWED_ORIGINS = new Set([
  'https://vsgallery.com.au',
  'https://www.vsgallery.com.au',
  'https://victoriastonegallery.com.au',
  'https://www.victoriastonegallery.com.au',
  'https://vsg-email-builder.netlify.app',
  'https://vsgslabsigns.netlify.app',
]);

// Branch deploys and deploy previews: develop--vsgallery.netlify.app etc.
const NETLIFY_PREVIEW = /^https:\/\/[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/i;

// Escape hatch without a redeploy: VSG_EXTRA_ORIGINS="https://a.com,https://b.com"
const EXTRA = (process.env.VSG_EXTRA_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  if (EXTRA.includes(origin)) return true;
  return NETLIFY_PREVIEW.test(origin);
}

export function corsHeaders(req) {
  const origin = req.headers.get('origin');
  // Vary MUST be present on every response, allowed origin or not. These
  // endpoints are CDN-cached, and without it the first cached copy (typically
  // a same-origin request carrying no Origin header, so no CORS headers) gets
  // replayed to cross-origin callers, who then see no Access-Control-Allow-Origin
  // and fail — with the function never running to produce one.
  if (!isAllowedOrigin(origin)) return { 'Vary': 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** Handle a CORS preflight. Returns a Response, or null if not a preflight. */
export function preflight(req) {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

/**
 * Cache-Control tuned so repeat hits are served by Netlify's CDN rather than
 * re-invoking the function. maxAge is what the browser holds; sMaxAge is what
 * the CDN holds. stale-while-revalidate keeps the site up if Drive is slow.
 */
export function cacheControl(maxAge, sMaxAge, swr = 600) {
  return `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;
}

export function json(req, body, { status = 200, cache = null, extra = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(cache ? { 'Cache-Control': cache } : { 'Cache-Control': 'no-store' }),
      ...corsHeaders(req),
      ...extra,
    },
  });
}

export function fail(req, status, message) {
  return json(req, { error: message }, { status });
}

/**
 * Wrap a handler so an unexpected throw returns a clean 502 rather than a
 * stack trace. Errors go to the function log, never to the client.
 */
export function guard(handler) {
  return async (req, context) => {
    const pre = preflight(req);
    if (pre) return pre;
    if (req.method !== 'GET') return fail(req, 405, 'Method not allowed');
    try {
      return await handler(req, context);
    } catch (err) {
      console.error('[vsg-api]', err && err.message ? err.message : err);
      return fail(req, 502, 'Upstream error');
    }
  };
}

// GET /api/config
//
// Returns vsg-site-config.json — the CMS config that drives categories,
// copy and siteTheme. This replaces the authenticated Drive read currently
// done by all three pages.
//
// /stones/ fetches it by file ID; /catalogue/ resolves it by name first.
// Both collapse to this one endpoint, which is what removes the drift that
// broke the Stone Knowledge hub on 3 Aug.

import { driveReadText, SITE_CONFIG_FILE_ID } from '../lib/google.js';
import { guard, json, cacheControl } from '../lib/http.js';

export default guard(async (req) => {
  const text = await driveReadText(SITE_CONFIG_FILE_ID);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A malformed config should not take the site down — the pages already
    // fall back to CMS_DEFAULTS when the fetch yields nothing usable.
    return json(req, { error: 'Config is not valid JSON' }, { status: 502 });
  }

  // Short CDN cache: admin edits appear within a minute without every visitor
  // costing a function invocation.
  return json(req, parsed, { cache: cacheControl(30, 60) });
});

export const config = { path: '/api/config' };

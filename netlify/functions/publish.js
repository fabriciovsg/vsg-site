// /api/publish — admin-triggered site rebuild ("Publish Now")
//
// GET   -> current deploy state, so the button can show Building… / Published
// POST  -> { stage: 'manifest' }  kick the Apps Script image-manifest rebuild
//          { stage: 'build' }     fire the Netlify build hook
//
// WHY TWO STAGES
// The manifest rebuild takes ~67 seconds (measured 6 Aug 2026). A Netlify
// Function is capped well below that, so this endpoint cannot rebuild the
// manifest and fire the hook in one request. Instead the browser orchestrates:
// POST manifest -> wait -> POST build -> poll GET. The waiting happens in a
// tab, which has no timeout, rather than in a function, which does.
//
// WHY THE ORDER MATTERS
// build-images.js reads image-manifest.json. Firing a build before the
// manifest knows about photos added to Drive produces a green deploy that is
// silently missing the new images — then you build again 10 minutes later.
// Manifest first, always.
//
// THE LOCK
// A build takes ~10 minutes and nothing on the page says so, which invites
// repeat presses. Repeat presses do not make it faster — Netlify queues them,
// so the site publishes LATER, and each one costs build minutes. This is the
// same mechanism that produced ~36 production builds a day in July 2026 when
// a 15-minute trigger was calling the hook. So: before firing, ask Netlify
// whether a deploy is already in flight, and refuse if so. The authoritative
// check is the deploys API, not a stored timestamp — it also catches builds
// started from the Netlify UI or by the daily 17:00 deployToNetlify() job.

import { verifyToken } from '../lib/auth.js';
import { json, fail, bearer, preflight } from '../lib/http.js';

const SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;

// States that mean "a build is already happening — do not start another".
const IN_FLIGHT = new Set(['new', 'pending_review', 'accepted', 'enqueued', 'building', 'uploading', 'processing']);

/** Ask Netlify about the most recent deploy on the production branch. */
async function latestDeploy() {
  const token = process.env.NETLIFY_API_TOKEN;
  if (!token || !SITE_ID) return null;   // not configured — fall back to the timestamp lock

  const r = await fetch(
    `https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys?per_page=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) return null;

  const list = await r.json();
  const d = Array.isArray(list) && list[0];
  if (!d) return null;

  return {
    state: d.state,
    branch: d.branch,
    context: d.context,
    createdAt: d.created_at,
    title: d.title || d.commit_ref || null,
    errorMessage: d.error_message || null,
    busy: IN_FLIGHT.has(d.state),
  };
}

/**
 * Fallback lock for when NETLIFY_API_TOKEN isn't set. Module scope survives
 * between invocations on a warm instance but not across cold starts, so this
 * is genuinely best-effort — it stops the double-click, not much more. The
 * deploys API above is the real guard.
 */
let lastFiredAt = 0;
const COOLDOWN_MS = 12 * 60 * 1000;

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const claims = verifyToken('admin', bearer(req));
  if (!claims) return fail(req, 401, 'Not signed in');

  // ── STATUS ────────────────────────────────────────────────
  if (req.method === 'GET') {
    const deploy = await latestDeploy().catch(() => null);
    return json(req, {
      deploy,
      cooldownRemaining: Math.max(0, COOLDOWN_MS - (Date.now() - lastFiredAt)),
    });
  }

  if (req.method !== 'POST') return fail(req, 405, 'Method not allowed');

  let body = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const stage = (body && body.stage) || 'build';

  // ── STAGE 1: rebuild the image manifest ───────────────────
  if (stage === 'manifest') {
    const url = process.env.APPS_SCRIPT_URL;
    const secret = process.env.APPS_SCRIPT_SECRET;
    if (!url || !secret) return fail(req, 500, 'Apps Script URL/secret not configured');

    // Fire and let it run. Apps Script executes to completion once it has the
    // request, whether or not we stay connected — which is the only way to
    // start a ~67s job from inside a function that cannot wait that long.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      await fetch(`${url}?action=manifest&secret=${encodeURIComponent(secret)}`,
        { redirect: 'follow', signal: ctrl.signal });
    } catch {
      // An abort here is the expected path, not an error.
    } finally {
      clearTimeout(timer);
    }

    return json(req, { started: true, expectedSeconds: 90 });
  }

  // ── STAGE 2: fire the build ───────────────────────────────
  if (stage === 'build') {
    const hook = process.env.NETLIFY_BUILD_HOOK;
    if (!hook) return fail(req, 500, 'Build hook not configured');

    const deploy = await latestDeploy().catch(() => null);
    if (deploy && deploy.busy) {
      const mins = Math.round((Date.now() - new Date(deploy.createdAt).getTime()) / 60000);
      return json(req, {
        skipped: true,
        reason: 'already-building',
        message: `A build started ${mins} minute${mins === 1 ? '' : 's'} ago and is still running.`,
        deploy,
      });
    }

    if (!deploy && Date.now() - lastFiredAt < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (Date.now() - lastFiredAt)) / 60000);
      return json(req, {
        skipped: true,
        reason: 'cooldown',
        message: `A build was started recently — try again in about ${mins} minute${mins === 1 ? '' : 's'}.`,
        deploy: null,
      });
    }

    const r = await fetch(hook, { method: 'POST' });
    if (!r.ok) return fail(req, 502, `Build hook returned ${r.status}`);

    lastFiredAt = Date.now();
    console.log('[vsg-publish] build triggered by admin');
    return json(req, { started: true, expectedMinutes: 10 });
  }

  return fail(req, 400, 'Unknown stage');
};

export const config = { path: '/api/publish' };

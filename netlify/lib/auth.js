// VSG — authentication for the write endpoints.
//
// Two separate concerns:
//   1. Admin auth  — one operator password, checked server-side, exchanged for
//      a short-lived token. Replaces the ADMIN_PASSWORD string comparison that
//      ran in the browser, where anyone could read it in view-source.
//   2. Client auth — per-customer login for trade pricing, validated against
//      clients.json which now never leaves the server.
//
// No dependencies: everything here uses node:crypto.

import crypto from 'node:crypto';

const ADMIN_PASSWORD = process.env.VSG_ADMIN_PASSWORD || '';
const TOKEN_TTL_MS   = 2 * 60 * 60 * 1000;   // 2 hours

// ── Token signing ─────────────────────────────────────────────
// The signing key is derived from the admin password rather than being a
// separate env var. One less thing to provision, and changing the password
// invalidates every outstanding token automatically.
let _keyCache = new Map();
function signingKey(context) {
  if (!ADMIN_PASSWORD) throw new Error('VSG_ADMIN_PASSWORD is not set');
  if (!_keyCache.has(context)) {
    _keyCache.set(context, crypto.createHash('sha256')
      .update(`vsg|${context}|${ADMIN_PASSWORD}`).digest());
  }
  return _keyCache.get(context);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Issue a signed, expiring token. `claims` is small public metadata. */
export function issueToken(context, claims = {}) {
  const payload = b64url(JSON.stringify({ ...claims, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = b64url(crypto.createHmac('sha256', signingKey(context)).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Verify a token. Returns the claims object, or null if invalid or expired. */
export function verifyToken(context, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  let expected;
  try {
    expected = b64url(crypto.createHmac('sha256', signingKey(context)).update(payload).digest());
  } catch { return null; }

  // Compare as fixed-length buffers so a mismatch does not leak position.
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    if (!claims.exp || Date.now() > claims.exp) return null;
    return claims;
  } catch { return null; }
}

/** Constant-time admin password check. */
export function checkAdminPassword(supplied) {
  if (!ADMIN_PASSWORD || typeof supplied !== 'string') return false;
  // Hash both sides first so differing lengths can be compared safely.
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Client passwords ──────────────────────────────────────────
// scrypt, salted per password. Stored as scrypt$<salt>$<derived key>.
//
// Plaintext values are deliberately REJECTED rather than accepted and upgraded
// on first login. Every existing password in clients.json was fetched into
// every anonymous visitor's browser on page load, so they must be treated as
// already disclosed. Silently re-hashing them would preserve credentials that
// have been public. New passwords instead.

const SCRYPT_KEYLEN = 64;

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

export function verifyPassword(plain, stored) {
  if (!isHashed(stored) || typeof plain !== 'string') return false;
  const [, saltB64, keyB64] = stored.split('$');
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const dk = crypto.scryptSync(plain, salt, expected.length);
    return crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

/** Readable password for issuing to a client — avoids ambiguous characters. */
export function generatePassword(words = 3) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = n => Array.from(crypto.randomBytes(n))
    .map(b => alphabet[b % alphabet.length]).join('');
  return Array.from({ length: words }, () => pick(4)).join('-');
}

// ── Brute-force damping ───────────────────────────────────────
// Per-instance only, so it is not a complete defence — but it turns an online
// guessing attack into a slow one, and the delay costs a real operator nothing.
const attempts = new Map(); // key -> { count, first }
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

export function recordFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count++;
}

export function clearFailures(key) { attempts.delete(key); }

/** Fixed delay on any failed credential check. */
export const failDelay = () => new Promise(r => setTimeout(r, 400));

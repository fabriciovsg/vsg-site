// POST /api/client-login   { email, password }  ->  { name, tier, token }
//
// clients.json stays on the server. Previously the whole file — names, emails,
// plaintext passwords and pricing tiers — was fetched into every anonymous
// visitor's browser at page load, before anyone logged in.
//
// Only the matched client's own name and tier come back. Nothing about any
// other client, and no password material.
//
// Plaintext stored passwords are rejected rather than accepted, because every
// one of them was publicly readable. Those clients need a new password issued
// from the admin panel.

import { driveReadText, driveFindFile, STOCK_FOLDER_ID } from '../lib/google.js';
import {
  verifyPassword, isHashed, issueToken,
  tooManyAttempts, recordFailure, clearFailures, failDelay,
} from '../lib/auth.js';
import { guardPost, json, fail, clientKey } from '../lib/http.js';

export default guardPost(async (req, body) => {
  const key = clientKey(req);
  const email    = String((body && body.email) || '').trim().toLowerCase();
  const password = (body && body.password) || '';

  if (!email || !password) return fail(req, 400, 'Email and password required');

  if (tooManyAttempts(key)) {
    await failDelay();
    return fail(req, 429, 'Too many attempts — wait a few minutes');
  }

  const file = await driveFindFile(STOCK_FOLDER_ID, 'clients.json');
  if (!file) return fail(req, 502, 'Client list unavailable');

  let list;
  try {
    const data = JSON.parse(await driveReadText(file.id));
    list = Array.isArray(data) ? data : (data.clients || []);
  } catch {
    return fail(req, 502, 'Client list unreadable');
  }

  const match = list.find(c =>
    String(c.email || '').trim().toLowerCase() === email ||
    String(c.name  || '').trim().toLowerCase() === email);

  // One message for every failure mode. Distinguishing "no such client" from
  // "wrong password" would let anyone enumerate the customer list.
  if (!match || !verifyPassword(password, match.password)) {
    recordFailure(key);
    await failDelay();
    // Signal a needed reset only when the account exists and was never hashed,
    // so the client is told something useful instead of retrying a dead password.
    if (match && match.password && !isHashed(match.password)) {
      return fail(req, 409, 'Your password needs resetting — please contact us for a new one');
    }
    return fail(req, 401, 'Incorrect email or password');
  }

  clearFailures(key);

  // NZ direct-stock capability travels in the SIGNED token, never as something
  // the caller can assert. Flags describe what a client may see, not where they
  // are: NZ customers also buy Melbourne stock, and direct access is granted
  // per client rather than implied by region.
  //   directAccess  — may view direct/in-transit stock
  //   directPricing — may see prices on it
  //   directTier    — price tier for direct stock (defaults to their Melbourne tier)
  // email is included so /api/direct-stock can confirm the signed-in client is
  // the one the slug belongs to; without it, any trade login would unlock
  // prices on another customer's link.
  return json(req, {
    name: match.name,
    tier: match.tier,
    directAccess: Boolean(match.directAccess),
    directPricing: Boolean(match.directPricing),
    token: issueToken('client', {
      tier: match.tier,
      name: match.name,
      email,
      directAccess: Boolean(match.directAccess),
      directPricing: Boolean(match.directPricing),
      directTier: match.directTier || match.tier || null,
    }),
    expiresIn: 2 * 60 * 60,
  });
});

export const config = { path: '/api/client-login' };

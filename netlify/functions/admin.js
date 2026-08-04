// POST /api/admin   { action, ... }   Authorization: Bearer <token>
//
// The only write path in the system. Requires a token from /api/admin-login,
// and is the only place a write-scoped Drive token is ever requested.
//
// Actions:
//   save-config        { config }            overwrite vsg-site-config.json
//   save-colour-cache  { cache }             overwrite colour-cache.json
//   list-clients       {}                    clients WITHOUT password material
//   save-clients       { clients }           upsert; hashes any new passwords
//   generate-password  {}                    a readable password to issue

import {
  driveReadText, driveWriteFile, driveFindFile,
  SITE_CONFIG_FILE_ID, STOCK_FOLDER_ID,
} from '../lib/google.js';
import {
  verifyToken, hashPassword, isHashed, generatePassword,
} from '../lib/auth.js';
import { guardPost, json, fail, bearer } from '../lib/http.js';

const CLIENTS_FILE = 'clients.json';
const COLOUR_FILE  = 'colour-cache.json';

/** Resolve a Stock-folder file to its ID, failing loudly if absent. */
async function stockFileId(name) {
  const f = await driveFindFile(STOCK_FOLDER_ID, name);
  if (!f) throw new Error(`${name} not found in Stock folder`);
  return f.id;
}

async function readClients() {
  const id = await stockFileId(CLIENTS_FILE);
  const text = await driveReadText(id);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('clients.json is not valid JSON'); }
  const list = Array.isArray(data) ? data : (data.clients || []);
  return { id, list, wrapped: !Array.isArray(data) };
}

export default guardPost(async (req, body) => {
  if (!verifyToken('admin', bearer(req))) {
    return fail(req, 401, 'Not authorised — sign in again');
  }

  const action = body && body.action;

  // ── CMS config ──────────────────────────────────────────────
  if (action === 'save-config') {
    if (!body.config || typeof body.config !== 'object') {
      return fail(req, 400, 'Missing config object');
    }
    // Refuse to write something the site could not read back.
    if (!Array.isArray(body.config.categories)) {
      return fail(req, 400, 'Refusing to save: config has no categories array');
    }
    await driveWriteFile(SITE_CONFIG_FILE_ID, JSON.stringify(body.config, null, 2));
    return json(req, { ok: true, saved: 'vsg-site-config.json' });
  }

  // ── Colour cache ────────────────────────────────────────────
  if (action === 'save-colour-cache') {
    if (!body.cache || typeof body.cache !== 'object') {
      return fail(req, 400, 'Missing cache object');
    }
    const id = await stockFileId(COLOUR_FILE);
    await driveWriteFile(id, JSON.stringify(body.cache, null, 2));
    return json(req, { ok: true, saved: COLOUR_FILE });
  }

  // ── Clients ─────────────────────────────────────────────────
  if (action === 'list-clients') {
    const { list } = await readClients();
    // Never return password material, even to an authenticated admin. The
    // panel only needs to know whether a password has been set yet.
    return json(req, {
      clients: list.map(c => ({
        name: c.name, email: c.email, tier: c.tier,
        hasPassword: isHashed(c.password),
        needsNewPassword: !!c.password && !isHashed(c.password),
      })),
    });
  }

  if (action === 'save-clients') {
    if (!Array.isArray(body.clients)) return fail(req, 400, 'Expected a clients array');

    const { id, list, wrapped } = await readClients();
    const existing = new Map(list.map(c => [String(c.email || c.name).toLowerCase(), c]));

    const merged = body.clients.map(incoming => {
      const key  = String(incoming.email || incoming.name).toLowerCase();
      const prev = existing.get(key);
      const out  = {
        name:  incoming.name,
        email: incoming.email,
        tier:  incoming.tier,
      };
      if (incoming.newPassword) {
        // Hash here; the plaintext is never stored and never travels back.
        out.password = hashPassword(incoming.newPassword);
      } else if (prev && isHashed(prev.password)) {
        out.password = prev.password;           // unchanged
      }
      // A previously plaintext password is intentionally dropped rather than
      // carried over — those values were public and must not survive.
      return out;
    });

    const payload = wrapped ? { clients: merged } : merged;
    await driveWriteFile(id, JSON.stringify(payload, null, 2));
    return json(req, {
      ok: true,
      saved: CLIENTS_FILE,
      count: merged.length,
      withPassword: merged.filter(c => isHashed(c.password)).length,
    });
  }

  if (action === 'generate-password') {
    return json(req, { password: generatePassword() });
  }

  return fail(req, 400, 'Unknown action');
});

export const config = { path: '/api/admin' };

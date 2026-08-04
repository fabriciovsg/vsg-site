// POST /api/admin-login   { password }  ->  { token, expiresIn }
//
// Replaces the client-side check. Previously the admin panel compared the typed
// password against ADMIN_PASSWORD, a string sitting in the page source — so the
// "gate" was readable by anyone who pressed View Source, and any visitor could
// have written to the CMS config, the colour cache or the client list.
//
// The panel UI can stay exactly where it is. Authority moves here: without a
// token from this endpoint, /api/admin refuses every write.

import {
  checkAdminPassword, issueToken,
  tooManyAttempts, recordFailure, clearFailures, failDelay,
} from '../lib/auth.js';
import { guardPost, json, fail, clientKey } from '../lib/http.js';

export default guardPost(async (req, body) => {
  const key = clientKey(req);

  if (tooManyAttempts(key)) {
    await failDelay();
    return fail(req, 429, 'Too many attempts — wait a few minutes');
  }

  if (!checkAdminPassword(body && body.password)) {
    recordFailure(key);
    await failDelay();
    // Deliberately vague: no hint about whether a password was even configured.
    return fail(req, 401, 'Incorrect password');
  }

  clearFailures(key);
  return json(req, {
    token: issueToken('admin'),
    expiresIn: 2 * 60 * 60,
  });
});

export const config = { path: '/api/admin-login' };

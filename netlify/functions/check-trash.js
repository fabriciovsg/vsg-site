// TEMPORARY diagnostic — checks the service account's own Drive trash for
// any file named vsg-site-config.json. Not part of the normal app; delete
// this file (and its Netlify deploy) once you've read the result.
//
// Uses the same VSG_SERVICE_ACCOUNT_EMAIL / VSG_PRIVATE_KEY / VSG_PRIVATE_KEY_ID
// env vars every other function already uses — nothing new to configure.

import { driveFetch, DRIVE_API } from '../lib/google.js';
import { guard, json } from '../lib/http.js';

export default guard(async (req) => {
  const q = encodeURIComponent(
    "trashed=true and name contains 'vsg-site-config'"
  );
  const url = `${DRIVE_API}/files?q=${q}&fields=files(id,name,trashedTime,size)&pageSize=20`;
  const resp = await driveFetch(url);
  const body = await resp.json();
  return json(req, { status: resp.status, ...body });
});

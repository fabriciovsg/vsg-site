// GET /api/drive-list?scope=<scope>[&folder=<id>]
//
// Folder listings for the image lookups the gallery does.
//
// Deliberately NOT a pass-through for arbitrary folder IDs. The service
// account can reach the entire Victoria Stone Gallery Drive (it is shared at
// the root, so access inherits everywhere), and an endpoint taking any folder
// ID would let anyone walk all of it — which is most of what the exposed key
// allowed in the first place. Callers name a scope instead, and per-folder
// scopes are validated against the children of the two image roots.
//
// Scopes:
//   slab-folders     — category subfolders of Slab Images
//   slab-images      — images in one slab category folder (needs &folder)
//   transit-images   — images in the "In Transit" folder
//   arriving-images  — images in the "Arriving Soon" folder
//   project-folders  — per-stone subfolders of Project Images
//   project-images   — images in one project folder (needs &folder)

import {
  driveList,
  SLAB_IMAGES_FOLDER_ID,
  PROJECT_IMAGES_FOLDER_ID,
} from '../lib/google.js';
import { guard, json, fail, cacheControl } from '../lib/http.js';

const FOLDER_MIME = "mimeType='application/vnd.google-apps.folder'";
const IMAGE_MIME  = "mimeType contains 'image/'";

// Cached child-ID sets, per warm instance, so validating a folder parameter
// costs nothing after the first call.
const childCache = new Map(); // rootId -> { ids:Set, at:number }
const CHILD_TTL = 10 * 60 * 1000;

async function childIds(rootId, filterQuery) {
  const hit = childCache.get(rootId);
  if (hit && Date.now() - hit.at < CHILD_TTL) return hit.ids;
  const folders = await driveList(rootId, filterQuery);
  const ids = new Set(folders.map(f => f.id));
  childCache.set(rootId, { ids, at: Date.now() });
  return ids;
}

async function findNamedFolder(rootId, name) {
  const folders = await driveList(rootId, FOLDER_MIME);
  return folders.find(f => f.name.toLowerCase() === name.toLowerCase()) || null;
}

export default guard(async (req) => {
  const params = new URL(req.url).searchParams;
  const scope  = params.get('scope');
  const folder = params.get('folder');

  // Slab category folders
  if (scope === 'slab-folders') {
    const files = await driveList(SLAB_IMAGES_FOLDER_ID, FOLDER_MIME);
    return json(req, { files }, { cache: cacheControl(300, 900) });
  }

  // Project subfolders. No mimeType filter — some are Shortcuts with a
  // different mimeType, so filter client-side by name pattern as the page does.
  if (scope === 'project-folders') {
    const all = await driveList(PROJECT_IMAGES_FOLDER_ID, '');
    return json(req, { files: all.filter(f => f.name.includes('-')) },
      { cache: cacheControl(300, 900) });
  }

  if (scope === 'transit-images' || scope === 'arriving-images') {
    const name = scope === 'transit-images' ? 'In Transit' : 'Arriving Soon';
    const target = await findNamedFolder(SLAB_IMAGES_FOLDER_ID, name);
    if (!target) return json(req, { files: [] }, { cache: cacheControl(120, 300) });
    const files = await driveList(target.id, IMAGE_MIME);
    return json(req, { files }, { cache: cacheControl(120, 300) });
  }

  if (scope === 'slab-images' || scope === 'project-images') {
    if (!folder) return fail(req, 400, 'Missing folder parameter');

    const root = scope === 'slab-images' ? SLAB_IMAGES_FOLDER_ID : PROJECT_IMAGES_FOLDER_ID;
    // Project folders may be Shortcuts, so no mimeType filter on that root.
    const allowed = await childIds(root, scope === 'slab-images' ? FOLDER_MIME : '');

    if (!allowed.has(folder)) return fail(req, 403, 'Folder not in scope');

    const files = await driveList(folder, IMAGE_MIME);
    return json(req, { files }, { cache: cacheControl(300, 900) });
  }

  return fail(req, 400, 'Unknown scope');
});

export const config = { path: '/api/drive-list' };

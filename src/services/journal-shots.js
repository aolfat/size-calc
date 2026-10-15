// Trade screenshots (docs/journal-step-3.md): the images in the private trade-shots Storage bucket, each under its
// owner's folder (<user id>/<id>.<ext>), and the trade_shots rows saying which trade each belongs to. Shown through
// signed links that last an hour. Row-level security and the bucket's rules keep every file its owner's. Never touches the page.
import { state } from '../state.js';
import { supabaseClient } from './supabase.js';

export const SHOTS_BUCKET = 'trade-shots';
/** at most this many on a trade */
export const MAX_SHOTS = 10;
/** the bucket refuses files over this (the app shrinks them well under it first) */
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;
const LINK_SECONDS = 3600;

const notPushed = (/** @type {any} */ res) => res?.error && /schema cache|does not exist|bucket not found/i.test(res.error.message || '');
function refused(res, what) {
  if (!res?.error) return;
  const err = new Error(notPushed(res) ? "the database doesn't have screenshots yet: npx supabase db push" : res.error.message || what);
  err.status = res.status || res.error.statusCode || 0;
  throw err;
}
async function client() {
  if (!state.session) throw new Error('Sign in with Google to keep screenshots.');
  return supabaseClient();
}
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** every screenshot of yours, oldest first: [{ id, trade_key, path, caption, width, height, bytes, created_at }] */
export async function loadShots() {
  const c = await client();
  const res = await c.from('trade_shots').select('id,trade_key,path,caption,width,height,bytes,created_at').order('created_at', { ascending: true }).limit(5000);
  refused(res, 'Supabase refused the read.');
  return res.data || [];
}

/**
 * Keep one image on a trade: the file into your folder of the bucket, then its row. If the row can't be saved, the
 * file is taken back out, so nothing is left behind.
 * @param {string} tradeKey @param {{ blob: Blob, type: string, width: number, height: number }} img
 */
export async function uploadShot(tradeKey, img) {
  const c = await client();
  const uid = state.session.user.id, id = newId();
  const path = `${uid}/${id}.${EXT[img.type] || 'jpg'}`;
  refused(await c.storage.from(SHOTS_BUCKET).upload(path, img.blob, { contentType: img.type, upsert: false }), 'Supabase refused the upload.');
  const row = { id, trade_key: tradeKey, path, caption: null, width: img.width || null, height: img.height || null, bytes: img.blob.size || null };
  const res = await c.from('trade_shots').insert([row]);
  if (res?.error) { await c.storage.from(SHOTS_BUCKET).remove([path]); refused(res, 'Supabase refused the save.'); }
  return { ...row, created_at: new Date().toISOString() };
}

/** signed links for these files: path → url */
export async function signShots(paths) {
  if (!paths.length) return {};
  const c = await client();
  const res = await c.storage.from(SHOTS_BUCKET).createSignedUrls(paths, LINK_SECONDS);
  refused(res, 'Supabase refused the links.');
  /** @type {Record<string, string>} */
  const out = {};
  for (const r of res.data || []) if (r?.signedUrl && !r.error) out[r.path] = r.signedUrl;
  return out;
}

/** the file, then its row */
export async function deleteShot(shot) {
  const c = await client();
  refused(await c.storage.from(SHOTS_BUCKET).remove([shot.path]), 'Supabase refused the delete.');
  refused(await c.from('trade_shots').delete().eq('id', shot.id), 'Supabase refused the delete.');
}

export async function saveShotCaption(id, caption) {
  const c = await client();
  refused(await c.from('trade_shots').update({ caption }).eq('id', id), 'Supabase refused the save.');
}

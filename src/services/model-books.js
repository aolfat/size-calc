// Model Books persistence: private books and screenshot examples, with image files in their owner's folder.
import { state } from '../state.js';
import { SHOTS_BUCKET } from './journal-shots.js';
import { supabaseClient } from './supabase.js';

export const MODEL_BUCKET = 'model-books';
export const MODEL_IMAGE_BYTES = 2 * 1024 * 1024;
const MODEL_LINK_SECONDS = 3600;

function modelRefused(res) {
  if (!res?.error) return;
  const msg = res.error.message || 'The request failed.';
  throw new Error(/schema cache|does not exist|bucket not found/i.test(msg) ? "Model Books isn't available yet. Try again after the app is updated." : msg);
}
export function checkModelOwner(uid) {
  if (!uid || state.session?.user?.id !== uid) throw new Error('Your account changed. Open Model Books again.');
}
async function modelClient(uid) {
  checkModelOwner(uid);
  const c = await supabaseClient();
  checkModelOwner(uid);
  return c;
}

const EXAMPLE_COLUMNS = 'id,book_id,title,notes,setup_keys,path,width,height,bytes,created_at';
const readExamples = (c, uid, cols) => c.from('model_examples').select(cols).eq('user_id', uid).order('created_at', { ascending: false }).limit(10000);

/** noTradeLink: the database doesn't have model_examples.trade_key yet, so examples read without it and none come from a trade */
export async function readModelBooks(uid) {
  const c = await modelClient(uid);
  let [books, examples] = await Promise.all([
    c.from('model_books').select('id,name,description,created_at').eq('user_id', uid).order('created_at', { ascending: true }).limit(1000),
    readExamples(c, uid, `${EXAMPLE_COLUMNS},trade_key`),
  ]);
  const noTradeLink = /trade_key/.test(examples?.error?.message || '');
  if (noTradeLink) examples = await readExamples(c, uid, EXAMPLE_COLUMNS);
  checkModelOwner(uid);
  modelRefused(books); modelRefused(examples);
  return { books: books.data || [], examples: examples.data || [], noTradeLink };
}

export async function keepModelBook(uid, row) {
  const c = await modelClient(uid);
  modelRefused(await c.from('model_books').upsert([{ ...row, user_id: uid }], { onConflict: 'user_id,id' }));
  checkModelOwner(uid);
}

/**
 * A failed row insert takes back its uploaded image. All writes pin the Google owner from before the upload. A draft from
 * a trade page carries one of the trade's screenshots (shot, a trade_shots row) instead of an image: Storage copies it
 * from your folder of trade-shots into your folder of model-books, and the row keeps the trade's key.
 */
export async function keepModelExample(uid, draft) {
  const c = await modelClient(uid);
  const id = draft.id || crypto.randomUUID();
  const row = { id, book_id: draft.book_id || null, title: draft.title.trim(), notes: draft.notes.trim(), setup_keys: draft.setup_keys };
  if (draft.id) {
    modelRefused(await c.from('model_examples').update(row).eq('id', id).eq('user_id', uid));
    checkModelOwner(uid);
    return row;
  }
  const shot = draft.shot, img = draft.image;
  if (shot) {
    if (!draft.trade_key || !shot.width || !shot.height || !(shot.bytes > 0 && shot.bytes <= MODEL_IMAGE_BYTES)) throw new Error("That screenshot is missing its size. Pick another, or add it again on the trade.");
  } else if (!img || img.blob.size > MODEL_IMAGE_BYTES) throw new Error('The screenshot must be under 2 MB after shrinking.');
  const ext = shot ? /\.(webp|jpg|png)$/.exec(shot.path)?.[1] : { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[img.type];
  if (!ext) throw new Error('Choose a PNG, JPEG, or WebP screenshot.');
  const path = `${uid}/${id}.${ext}`;
  modelRefused(shot ? await c.storage.from(SHOTS_BUCKET).copy(shot.path, path, { destinationBucket: MODEL_BUCKET })
    : await c.storage.from(MODEL_BUCKET).upload(path, img.blob, { contentType: img.type, upsert: false }));
  try {
    checkModelOwner(uid);
    Object.assign(row, shot ? { path, width: shot.width, height: shot.height, bytes: shot.bytes, trade_key: draft.trade_key }
      : { path, width: img.width, height: img.height, bytes: img.blob.size }, { created_at: new Date().toISOString() });
    modelRefused(await c.from('model_examples').insert([{ ...row, user_id: uid }]));
    checkModelOwner(uid);
    return row;
  } catch(e) {
    // Once the row landed its file belongs to it, even if the account changed before the answer returned.
    if (state.session?.user?.id === uid) await c.storage.from(MODEL_BUCKET).remove([path]).catch(() => {});
    throw e;
  }
}

export async function modelImageLinks(uid, paths) {
  const c = await modelClient(uid);
  const res = await c.storage.from(MODEL_BUCKET).createSignedUrls(paths, MODEL_LINK_SECONDS);
  checkModelOwner(uid); modelRefused(res);
  const urls = {};
  for (const r of res.data || []) if (r.signedUrl && !r.error) urls[r.path] = { url: r.signedUrl, expires: Date.now() + (MODEL_LINK_SECONDS - 60) * 1000 };
  return urls;
}

export async function removeModelExample(uid, row) {
  const c = await modelClient(uid);
  // Keep the row if Storage refuses; a missing file can be removed again when retrying the row delete.
  modelRefused(await c.storage.from(MODEL_BUCKET).remove([row.path]));
  checkModelOwner(uid);
  modelRefused(await c.from('model_examples').delete().eq('id', row.id).eq('user_id', uid));
}

export async function removeModelBook(uid, id) {
  const c = await modelClient(uid);
  // The foreign key refuses a populated book, even if another tab added an example after this tab read it.
  modelRefused(await c.from('model_books').delete().eq('id', id).eq('user_id', uid));
  checkModelOwner(uid);
}

// The claude-model-example Edge Function (docs/claude-access.md): a Claude key adds a Model books example with its
// screenshot. Plain JS with no imports, so Node's tests load it as is: index.ts hands it Deno's request and environment.
// It reads the image itself (PNG, JPEG or WebP, 2 MB, its size from its own header, never the caller's word), adds the
// row with claude_model_example_add (which checks the key, and is the service role's alone), uploads the file to the key
// owner's folder, and takes the row back if Storage refuses it.

export const MODEL_BUCKET = 'model-books';
export const MODEL_IMAGE_BYTES = 2 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

/**
 * An image's type and size from its own bytes, or why it isn't one the app keeps.
 * @param {Uint8Array} b @returns {{ type: string, ext: string, width: number, height: number } | string}
 */
export function imageInfo(b) {
  if (!b?.length) return 'No image.';
  if (b.length > MODEL_IMAGE_BYTES) return `The screenshot is ${(b.length / 1048576).toFixed(1)} MB; 2 MB at most.`;
  let type = '', width = 0, height = 0;
  if (b.length > 24 && u32(b, 0) === 0x89504e47 && u32(b, 4) === 0x0d0a1a0a && ascii(b, 12, 4) === 'IHDR') {
    type = 'image/png'; width = u32(b, 16); height = u32(b, 20);
  } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    type = 'image/jpeg';
    // walk the markers to the first frame header (SOF0 to SOF15, not DHT, JPG or DAC)
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { height = u16(b, i + 5); width = u16(b, i + 7); break; }
      i += 2 + u16(b, i + 2);
    }
  } else if (b.length > 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    type = 'image/webp';
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') { width = (b[26] | (b[27] << 8)) & 0x3fff; height = (b[28] | (b[29] << 8)) & 0x3fff; }
    else if (chunk === 'VP8L') { width = 1 + (b[21] | ((b[22] & 0x3f) << 8)); height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)); }
    else if (chunk === 'VP8X') { width = 1 + le24(b, 24); height = 1 + le24(b, 27); }
  }
  if (!type) return 'Choose a PNG, JPEG, or WebP screenshot.';
  if (!(width >= 1 && width <= 10000 && height >= 1 && height <= 10000)) return "Couldn't read the screenshot's size.";
  return { type, ext: EXT[type], width, height };
}

const reply = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** headers for the service role: a secret key goes as the apikey alone; a legacy service_role JWT also as the bearer */
const serviceHeaders = key => ({ apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) });
async function refusal(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text).message || text; } catch(e) { return text || res.statusText; }
}

/**
 * POST { key, example: { book_id, title, notes, setup_keys }, image: base64 } → { id, path, type, width, height, bytes }.
 * @param {Request} req @param {{ env: (name: string) => string | undefined, fetch?: typeof fetch }} deps
 */
export async function handle(req, { env, fetch: send = fetch }) {
  if (req.method !== 'POST') return reply(405, { message: 'POST only' });
  const url = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) return reply(500, { message: 'The function has no service role key.' });
  let body;
  try { body = await req.json(); } catch(e) { return reply(400, { message: 'Not JSON.' }); }
  const { key, example, image } = body || {};
  if (typeof key !== 'string' || !key) return reply(401, { code: '28000', message: 'not a Claude key' });
  if (!example || typeof example !== 'object') return reply(400, { message: 'No example.' });
  if (typeof image !== 'string' || image.length > Math.ceil(MODEL_IMAGE_BYTES / 3) * 4 + 4) return reply(400, { message: 'The screenshot is missing, or over 2 MB.' });
  let bytes;
  try { bytes = Uint8Array.from(atob(image), c => c.charCodeAt(0)); } catch(e) { return reply(400, { message: 'The image is not base64.' }); }
  const info = imageInfo(bytes);
  if (typeof info === 'string') return reply(400, { message: info });

  const headers = serviceHeaders(service);
  const fields = { book_id: example.book_id, title: example.title, notes: example.notes ?? '', setup_keys: example.setup_keys ?? [] };
  const added = await send(`${url}/rest/v1/rpc/claude_model_example_add`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_key: key, p_example: { ...fields, ext: info.ext, width: info.width, height: info.height, bytes: bytes.length } }),
  });
  if (!added.ok) {
    const message = await refusal(added);
    return reply(/not a Claude key/i.test(message) ? 401 : added.status, { message });
  }
  const row = await added.json();
  const up = await send(`${url}/storage/v1/object/${MODEL_BUCKET}/${row.path}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': info.type, 'x-upsert': 'false' }, body: bytes,
  });
  if (!up.ok) {
    const message = await refusal(up);
    await send(`${url}/rest/v1/model_examples?user_id=eq.${row.user_id}&id=eq.${row.id}`, { method: 'DELETE', headers }).catch(() => {});
    return reply(502, { message: `Storage refused the screenshot (${up.status}): ${message}` });
  }
  return reply(200, { id: row.id, path: row.path, type: info.type, width: info.width, height: info.height, bytes: bytes.length });
}

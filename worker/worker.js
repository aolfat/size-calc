// size-calc sync worker: one encrypted blob per id in Cloudflare KV.
// The app encrypts with a passphrase-derived AES key before uploading,
// so this worker only ever sees ciphertext. Deploy: see README.md here.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const id = url.pathname.slice(1);
    if (!/^[a-f0-9]{64}$/.test(id)) return json({ error: 'bad id' }, 400);

    if (req.method === 'PUT') {
      const blob = await req.text();
      if (blob.length > 200000) return json({ error: 'too big' }, 413);
      // app format: base64(iv).base64(ciphertext) — reject anything else
      if (!/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(blob)) return json({ error: 'bad blob' }, 400);
      const t = Date.now();
      // TTL refreshes on every write; a blob untouched for ~13 months evaporates
      await env.SYNC.put(id, JSON.stringify({ t, blob }), { expirationTtl: 60 * 60 * 24 * 400 });
      return json({ t });
    }

    if (req.method === 'GET') {
      const rec = await env.SYNC.get(id);
      if (!rec) return json({ error: 'not found' }, 404);
      if (url.searchParams.get('meta')) return json({ t: JSON.parse(rec).t }); // cheap poll: timestamp only
      return new Response(rec, { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    return json({ error: 'method' }, 405);
  }
};

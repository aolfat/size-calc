// size-calc Schwab worker: holds the app key and secret, swaps OAuth codes and refresh tokens for access tokens,
// and relays Trader API calls, which browsers can't make to api.schwabapi.com directly. It stores nothing:
// tokens pass through to the app, which keeps them on the device. Deploy: see README.md here.
const SCHWAB = 'https://api.schwabapi.com';

// only the app's own pages may call this from a browser
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Location',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const missing = ['SCHWAB_APP_KEY', 'SCHWAB_APP_SECRET', 'SCHWAB_CALLBACK_URL'].filter(k => !env[k]);
    if (missing.length) return new Response('worker not configured, missing ' + missing.join(', '), { status: 500 });

    // a top-level navigation from the app's login button: straight on to Schwab's own login page
    if (req.method === 'GET' && url.pathname === '/login') {
      const auth = new URL(SCHWAB + '/v1/oauth/authorize');
      auth.searchParams.set('client_id', env.SCHWAB_APP_KEY);
      auth.searchParams.set('redirect_uri', env.SCHWAB_CALLBACK_URL);
      const state = url.searchParams.get('state');
      if (state && /^[A-Za-z0-9_-]{1,128}$/.test(state)) auth.searchParams.set('state', state);
      return Response.redirect(auth.toString(), 302);
    }

    const cors = corsHeaders(req, env);
    if (!cors) return new Response('origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // code or refresh token in, tokens out; the secret never leaves this worker
    if (req.method === 'POST' && (url.pathname === '/token' || url.pathname === '/refresh')) {
      const j = await req.json().catch(() => ({}));
      const form = url.pathname === '/token'
        ? { grant_type: 'authorization_code', code: String(j.code || ''), redirect_uri: env.SCHWAB_CALLBACK_URL }
        : { grant_type: 'refresh_token', refresh_token: String(j.refresh_token || '') };
      const res = await fetch(SCHWAB + '/v1/oauth/token', {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + btoa(env.SCHWAB_APP_KEY + ':' + env.SCHWAB_APP_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok
        ? json({ access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in }, 200, cors)
        : json({ error: body.error || 'token_error', error_description: body.error_description || body.message || '' }, res.status, cors);
    }

    // Trader API relay: the app's bearer token passes through untouched
    if (url.pathname.startsWith('/trader/v1/') && ['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
      const auth = req.headers.get('Authorization') || '';
      if (!/^Bearer \S+$/.test(auth)) return json({ message: 'missing bearer token' }, 401, cors);
      const hasBody = req.method === 'POST' || req.method === 'PUT';
      const res = await fetch(SCHWAB + url.pathname + url.search, {
        method: req.method,
        headers: { 'Authorization': auth, 'Accept': 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
        body: hasBody ? await req.text() : undefined,
      });
      const out = new Headers(cors);
      out.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
      const location = res.headers.get('Location');
      if (location) out.set('Location', location); // a new order's id
      return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
    }

    return json({ message: 'not found' }, 404, cors);
  }
};

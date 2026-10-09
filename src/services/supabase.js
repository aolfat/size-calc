// Supabase: the project address and public key, the client (its library loads only when needed), and Google sign-in.
// The publishable key is public by design: row-level security on every table is what keeps users apart.
import { state } from '../state.js';
import { store } from '../lib/store.js';

export const SUPABASE_URL = 'https://dhohfavttsxwutanvcuj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_EEi7-I4tYXabRcpSWZpNJw_tqwEZXwQ';
// where the library keeps the session in this browser (its default name, derived from the project ref)
export const SESSION_KEY = 'sb-dhohfavttsxwutanvcuj-auth-token';

/** a session saved on this device, checked without loading the library */
export function hasStoredSession() { return !!store.get(SESSION_KEY); }

/** the one client, created on first use; tests put a fake in state.supabase */
export async function supabaseClient() {
  if (state.supabase) return state.supabase;
  if (!state.supabaseLoading) {
    state.supabaseLoading = import('../../vendor/supabase.js').then(m => m.createClient(SUPABASE_URL, SUPABASE_KEY, {
      // the app finishes Google's return itself (finishGoogleReturn), so Schwab's ?code callback is never touched
      auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true },
    })).catch(e => { state.supabaseLoading = null; throw e; });
  }
  state.supabase = await state.supabaseLoading;
  return state.supabase;
}

/** Google sends you back to the app's address with this marker, so each sign-in only handles its own return */
export function isGoogleReturn(href) {
  try { return new URL(href).searchParams.get('login') === 'google'; } catch(e) { return false; }
}

/** the app's own address, without any query or hash */
export function appUrl(href) {
  const u = new URL(href);
  return u.origin + u.pathname;
}

/** start Google sign-in: the browser leaves for Google and comes back to the app */
export async function signInWithGoogle(href) {
  const client = await supabaseClient();
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl(href) + '?login=google' } });
  if (error) throw error;
}

/** finish Google's return: swap the code for a session. Returns the session, or throws with Google's or Supabase's reason. */
export async function finishGoogleReturn(href) {
  const url = new URL(href);
  const problem = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (problem) throw new Error(problem);
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Google sent no sign-in code.');
  const client = await supabaseClient();
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error) throw error;
  return data.session;
}

/** the signed-in session on this device, or null */
export async function currentSession() {
  if (!state.supabase && !hasStoredSession()) return null;
  const client = await supabaseClient();
  const { data } = await client.auth.getSession();
  return data.session || null;
}

export async function signOutSupabase() {
  const client = await supabaseClient();
  // local scope: signing out here leaves your other devices signed in. Offline, the local session is dropped anyway
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
}

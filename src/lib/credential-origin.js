// @ts-check
// Credentials need HTTPS (or local development). github.io is allowed by request, though every Pages site under the
// account shares this origin's storage: keep scripts off the others (aolfat.github.io/resume has none), or move hosts.
export const CREDENTIAL_ORIGIN_MESSAGE = 'Use an HTTPS app address for sign-in and API keys. This address cannot safely store credentials.';

/** @param {string | undefined} href */
export function credentialOriginAllowed(href = globalThis.location?.href) {
  if (href === undefined) return true; // non-browser callers, including the test harness
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch(e) { return false; }
}

/** @param {string | undefined} href */
export function assertCredentialOrigin(href = globalThis.location?.href) {
  if (!credentialOriginAllowed(href)) throw new Error(CREDENTIAL_ORIGIN_MESSAGE);
}

/** true when another site has this page in a frame; a same-origin parent (or none) is fine */
export function framedCrossOrigin(win = globalThis) {
  if (!win.top || win.top === win.self) return false;
  try { return win.top.location.origin !== win.location.origin; } catch(e) { return true; } // reading a cross-origin parent throws
}

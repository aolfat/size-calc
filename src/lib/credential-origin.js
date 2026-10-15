// @ts-check
// Credentials belong on a dedicated HTTPS host. GitHub Pages repository paths share browser storage.
export const CREDENTIAL_ORIGIN_MESSAGE = 'Use a dedicated HTTPS app address for sign-in and API keys. This address cannot safely store credentials.';

/** @param {string | undefined} href */
export function credentialOriginAllowed(href = globalThis.location?.href) {
  if (href === undefined) return true; // non-browser callers, including the test harness
  try {
    const u = new URL(href);
    if (u.hostname === 'github.io' || u.hostname.endsWith('.github.io')) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch(e) { return false; }
}

/** @param {string | undefined} href */
export function assertCredentialOrigin(href = globalThis.location?.href) {
  if (!credentialOriginAllowed(href)) throw new Error(CREDENTIAL_ORIGIN_MESSAGE);
}

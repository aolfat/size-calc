// @ts-check
// Safe localStorage: sandboxed previews can block it, so every call is guarded.
// Every write funnels through set(), which tells the write listener (the cloud module's pending tracker) about real changes.

/** @type {((k: string) => void) | null} */
let writeListener = null;

/** Register the one listener told about value-changing writes (the cloud module uses it to mark account keys pending). */
/** @param {(k: string) => void} fn */
export function onStoreWrite(fn) { writeListener = fn; }

export const store = {
  /** @param {string} k @returns {string | null} */
  get(k) { try { return localStorage.getItem(k); } catch(e) { return null; } },
  /** @param {string} k @param {unknown} v */
  set(k, v) {
    const s = String(v);
    const old = this.get(k);
    try { localStorage.setItem(k, s); } catch(e) {}
    // no-op rewrites (init, auto-loads) must not count as fresh edits
    if (old !== s && writeListener) writeListener(k);
  },
  /** @param {string} k */
  del(k) { try { localStorage.removeItem(k); } catch(e) {} }
};

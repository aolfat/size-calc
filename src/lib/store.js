// Safe localStorage: sandboxed previews can block it, so every call is guarded.
// Every write funnels through set(), which tells the write listener (sync's dirty tracker) about real changes.

let writeListener = null;

/** Register the one listener told about value-changing writes (sync uses it to mark keys dirty). */
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

// @ts-check
// Journal spike, pure: masks account numbers in a Schwab history export and summarizes what each read returned,
// so the file can be shared to build the importer against real data. No network, no storage.

const ACCOUNT_KEY = /^(accountNumber|accountId|hashValue|accountHash)$/i;

/** '••6789' for an account number, '••' when it's too short to keep any digits. @param {unknown} v */
export function maskAccount(v) {
  const s = String(v ?? '');
  return s.length > 4 ? '••' + s.slice(-4) : '••';
}

/**
 * A deep copy with every account number or hash masked, wherever it sits.
 * @param {any} v
 * @returns {any}
 */
export function scrubAccounts(v) {
  if (Array.isArray(v)) return v.map(scrubAccounts);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = ACCOUNT_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') ? maskAccount(x) : scrubAccounts(x);
    return out;
  }
  return v;
}

/**
 * How much a read returned and the time span it covers: the answer to "how far back does Schwab go".
 * @param {any[]} rows @param {string[]} timeKeys the first key present on a row is its time
 */
export function spanOf(rows, timeKeys) {
  let first = '', last = '';
  for (const r of rows) {
    const t = timeKeys.map(k => r && r[k]).find(Boolean);
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return { count: rows.length, first, last };
}

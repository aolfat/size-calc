// @ts-check
// A small key-value store in IndexedDB, for what's too big for localStorage (the market breadth's daily closes: every
// US stock's close for a day, tens of MB over two years). Where IndexedDB isn't there or refuses (the tests, some private
// windows), the values live in memory for the page's life, so callers never have to care.
const DB = 'size-calc', STORE = 'kv';
/** @type {Map<string, any>} */
const memory = new Map();
/** @type {Promise<IDBDatabase | null> | null} */
let opening = null;

/** @returns {Promise<IDBDatabase | null>} */
function open() {
  if (opening) return opening;
  opening = new Promise(resolve => {
    try {
      const idb = globalThis.indexedDB;
      if (!idb) { resolve(null); return; }
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch(e) { resolve(null); }
  });
  return opening;
}

/**
 * @template T
 * @param {IDBTransactionMode} mode @param {(s: IDBObjectStore) => IDBRequest<T>} fn @returns {Promise<T | undefined>}
 */
async function run(mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch(e) { resolve(undefined); }
  });
}

/** a value, or undefined @param {string} key */
export async function idbGet(key) {
  if (!(await open())) return memory.get(key);
  return run('readonly', s => s.get(key));
}

/** @param {string} key @param {any} value */
export async function idbSet(key, value) {
  if (!(await open())) { memory.set(key, value); return; }
  await run('readwrite', s => s.put(value, key));
}

/** every [key, value] whose key starts with `prefix` @param {string} prefix @returns {Promise<[string, any][]>} */
export async function idbEntries(prefix) {
  if (!(await open())) return [...memory].filter(([k]) => k.startsWith(prefix));
  const range = IDBKeyRange.bound(prefix, prefix + '￿');
  const [keys, values] = await Promise.all([run('readonly', s => s.getAllKeys(range)), run('readonly', s => s.getAll(range))]);
  return (keys || []).map((k, i) => [String(k), (values || [])[i]]);
}

/** delete every key starting with `prefix` (sign out) @param {string} prefix */
export async function idbClear(prefix) {
  if (!(await open())) { for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k); return; }
  await run('readwrite', s => s.delete(IDBKeyRange.bound(prefix, prefix + '￿')));
}

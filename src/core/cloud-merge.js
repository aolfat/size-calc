// @ts-check
// Cloud merge rules, pure: a device's first sign-in against what the account already holds, and which server rows
// a pull still has to look at. No storage, no network.

/** how far back each pull re-reads: a save stamped before the newest row seen but committed after it still shows */
export const PULL_OVERLAP_MS = 60000;

/**
 * First sign-in on a device. If the account has no settings yet, this device fills it. Otherwise the account's
 * settings and key win, and a setting only this device has is uploaded. A device last bound to another account
 * (foreign) holds that account's data: nothing is uploaded, the account's settings and key win, and the rest is
 * cleared (clear lists the settings to delete; a key of '' means delete it too).
 * @param {{ settings: Record<string, string>, key: string }} local
 * @param {{ settings: Record<string, string>, key: string }} cloud
 * @param {{ foreign?: boolean }} [opts]
 */
export function mergeFirstSignIn(local, cloud, { foreign = false } = {}) {
  if (foreign) {
    const clear = Object.keys(local.settings).filter(k => !(k in cloud.settings));
    return { seeded: false, foreign, settings: { ...cloud.settings }, clear, key: cloud.key || '', upload: { settings: {}, key: null } };
  }
  const seeded = Object.keys(cloud.settings).length === 0;
  const settings = seeded ? { ...local.settings } : { ...local.settings, ...cloud.settings };
  /** @type {Record<string, string>} */
  const uploadSettings = {};
  for (const [k, v] of Object.entries(local.settings)) if (seeded || !(k in cloud.settings)) uploadSettings[k] = v;
  const key = cloud.key || local.key || '';
  const uploadKey = !cloud.key && local.key ? local.key : null;
  /** @type {string[]} */
  const clear = [];
  return { seeded, foreign, settings, clear, key, upload: { settings: uploadSettings, key: uploadKey } };
}

/** The latest updated_at across rows, or the given fallback. @param {{ updated_at?: string }[]} rows @param {string} since */
export function latestUpdate(rows, since) {
  let best = since;
  for (const r of rows) if (r.updated_at && (!best || Date.parse(r.updated_at) > Date.parse(best))) best = r.updated_at;
  return best;
}

/** where a pull starts reading: PULL_OVERLAP_MS before the newest stamp seen, or '' for everything. @param {string} [since] */
export function pullFrom(since) {
  const t = Date.parse(since || '');
  return Number.isFinite(t) ? new Date(t - PULL_OVERLAP_MS).toISOString() : '';
}

/**
 * Rows a pull hasn't seen yet: a row read again in the overlap still carries the stamp recorded for its key.
 * @template {{ key: string, updated_at?: string }} R
 * @param {R[]} rows @param {Record<string, string>} stamps
 */
export function unseenRows(rows, stamps) { return rows.filter(r => !r.updated_at || stamps[r.key] !== r.updated_at); }

/**
 * Pull bookkeeping after reading rows: the newest stamp (where the next pull starts) and each key's last stamp.
 * @param {{ key: string, updated_at?: string }[]} rows
 * @param {{ settings?: string, keys?: Record<string, string> }} seen
 */
export function seenAfter(rows, seen) {
  /** @type {Record<string, string>} */
  const keys = { ...(seen.keys || {}) };
  for (const r of rows) if (r.updated_at) keys[r.key] = r.updated_at;
  return { settings: latestUpdate(rows, seen.settings || ''), keys };
}

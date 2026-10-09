// @ts-check
// Cloud merge rules, pure: a device's first sign-in against what the account already holds, and applying changed
// position rows from the server around edits this device hasn't sent yet. No storage, no network.

/** @typedef {{ id: string, data: any, deleted_at?: string | null, updated_at?: string }} PositionRow */

/**
 * JSON with object keys sorted, so the same card compares equal however it was stored (Postgres jsonb reorders keys).
 * @param {any} v
 * @returns {string}
 */
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(x => stableJson(x === undefined ? null : x)).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * First sign-in on a device. If the account has no settings yet, this device fills it. Otherwise the account's
 * settings and key win, and positions from both are combined, with deletes on either side respected.
 * @param {{ settings: Record<string, string>, key: string, positions: Record<string, any>, tombstones: Record<string, number> }} local
 * @param {{ settings: Record<string, string>, key: string, positions: PositionRow[] }} cloud
 */
export function mergeFirstSignIn(local, cloud) {
  const seeded = Object.keys(cloud.settings).length === 0;
  const settings = seeded ? { ...local.settings } : { ...local.settings, ...cloud.settings };
  /** @type {Record<string, string>} */
  const uploadSettings = {};
  for (const [k, v] of Object.entries(local.settings)) if (seeded || !(k in cloud.settings)) uploadSettings[k] = v;

  const key = cloud.key || local.key || '';
  const uploadKey = !cloud.key && local.key ? local.key : null;

  const cloudLive = new Map(cloud.positions.filter(r => !r.deleted_at).map(r => [r.id, r.data]));
  const cloudDeleted = new Set(cloud.positions.filter(r => r.deleted_at).map(r => r.id));
  const tombstoned = new Set(Object.keys(local.tombstones || {}));
  /** @type {Record<string, any>} */
  const positions = {};
  /** @type {Record<string, any>} */
  const uploadPositions = {};
  for (const [id, data] of Object.entries(local.positions)) {
    if (tombstoned.has(id) || cloudDeleted.has(id)) continue;
    positions[id] = data;
    if (!cloudLive.has(id)) uploadPositions[id] = data;
  }
  /** @type {string[]} */
  const deletes = [];
  for (const [id, data] of cloudLive) {
    if (tombstoned.has(id)) { deletes.push(id); continue; }
    positions[id] = data; // the same position on both: the account's copy wins, like settings
  }
  return { seeded, settings, key, positions, upload: { settings: uploadSettings, key: uploadKey, positions: uploadPositions, deletes } };
}

/**
 * Changed position rows from the server, applied to this device. A position edited here since the last sync
 * (its stableJson differs from what was last synced) keeps the local version until it's sent.
 * @param {Record<string, any>} local positions on this device
 * @param {Record<string, string>} synced id → stableJson as last synced
 * @param {PositionRow[]} rows
 */
export function applyPositionRows(local, synced, rows) {
  const next = { ...local };
  const nextSynced = { ...synced };
  let changed = false;
  for (const row of rows) {
    const editedHere = row.id in local ? stableJson(local[row.id]) !== synced[row.id] : row.id in synced;
    if (editedHere) continue;
    if (row.deleted_at) {
      if (row.id in next) { delete next[row.id]; changed = true; }
      delete nextSynced[row.id];
    } else {
      const json = stableJson(row.data);
      if (!(row.id in next) || stableJson(next[row.id]) !== json) { next[row.id] = row.data; changed = true; }
      nextSynced[row.id] = json;
    }
  }
  return { positions: next, synced: nextSynced, changed };
}

/**
 * What this device needs to send for positions: new or edited ones, and ones deleted here since the last sync.
 * @param {Record<string, any>} local
 * @param {Record<string, string>} synced
 */
export function positionChanges(local, synced) {
  /** @type {Record<string, any>} */
  const upserts = {};
  for (const [id, data] of Object.entries(local)) if (stableJson(data) !== synced[id]) upserts[id] = data;
  const deletes = Object.keys(synced).filter(id => !(id in local));
  return { upserts, deletes };
}

/** The latest updated_at across rows, or the given fallback. @param {{ updated_at?: string }[]} rows @param {string} since */
export function latestUpdate(rows, since) {
  let best = since;
  for (const r of rows) if (r.updated_at && (!best || Date.parse(r.updated_at) > Date.parse(best))) best = r.updated_at;
  return best;
}

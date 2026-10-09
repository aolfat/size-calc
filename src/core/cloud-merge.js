// @ts-check
// Cloud merge rules, pure: a device's first sign-in against what the account already holds, and the newest
// server timestamp seen. No storage, no network.

/**
 * First sign-in on a device. If the account has no settings yet, this device fills it. Otherwise the account's
 * settings and key win, and a setting only this device has is uploaded.
 * @param {{ settings: Record<string, string>, key: string }} local
 * @param {{ settings: Record<string, string>, key: string }} cloud
 */
export function mergeFirstSignIn(local, cloud) {
  const seeded = Object.keys(cloud.settings).length === 0;
  const settings = seeded ? { ...local.settings } : { ...local.settings, ...cloud.settings };
  /** @type {Record<string, string>} */
  const uploadSettings = {};
  for (const [k, v] of Object.entries(local.settings)) if (seeded || !(k in cloud.settings)) uploadSettings[k] = v;
  const key = cloud.key || local.key || '';
  const uploadKey = !cloud.key && local.key ? local.key : null;
  return { seeded, settings, key, upload: { settings: uploadSettings, key: uploadKey } };
}

/** The latest updated_at across rows, or the given fallback. @param {{ updated_at?: string }[]} rows @param {string} since */
export function latestUpdate(rows, since) {
  let best = since;
  for (const r of rows) if (r.updated_at && (!best || Date.parse(r.updated_at) > Date.parse(best))) best = r.updated_at;
  return best;
}

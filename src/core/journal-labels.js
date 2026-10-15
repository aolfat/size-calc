// @ts-check
// Journal review, pure (docs/journal-step-3.md): the label defaults, your library on top of them (your own items,
// renamed / hidden / merged defaults), setup keys (a level plus an optional action, or a pattern), and whether a trade
// is reviewed: market, sector, a setup, a tactic, both grades and a note.

/** @typedef {'market' | 'sector' | 'level' | 'action' | 'pattern' | 'tactic' | 'tag' | 'mistake'} ItemKind */
/** @typedef {{ key: string, kind: ItemKind, name: string, own: boolean, hidden: boolean }} Item */
/** @typedef {{ id: string, kind: ItemKind, name: string, default_key?: string | null, hidden?: boolean, merged_into?: string | null }} LibraryRow */
/** @typedef {{ kind: string, value: string, set_by?: string }} Label */

/** the defaults everyone gets, by kind: [key, name] */
export const DEFAULTS = /** @type {Record<ItemKind, [string, string][]>} */ ({
  market: [['bullish', 'Bullish'], ['neutral', 'Neutral'], ['bearish', 'Bearish'], ['choppy', 'Choppy']],
  sector: [['strong', 'Strong'], ['weak', 'Weak'], ['neutral', 'Neutral'], ['na', 'N/A']],
  level: [['sma50', '50 SMA'], ['sma100', '100 SMA'], ['sma200', '200 SMA'], ['ema8', '8 EMA'], ['ema21', '21 EMA'], ['support', 'Support'], ['resistance', 'Resistance'], ['avwap_ath', 'AVWAP from ATH'], ['avwap_atl', 'AVWAP from ATL'], ['avwap_earnings', 'AVWAP from earnings']],
  action: [['bounce', 'bounce'], ['undercut', 'undercut and rally'], ['rejection', 'rejection']],
  pattern: [['base_breakout', 'Base breakout'], ['flag_breakout', 'Pennant or flag breakout'], ['earnings_gap', 'Earnings gap']],
  tactic: [['six20', '6/20 (Gil Morales)'], ['pivot15', '15-minute pivot'], ['pivot30', '30-minute pivot']],
  tag: [['option_flow', 'Option flow']],
  mistake: [['chased', 'Chased the entry'], ['oversized', 'Oversized'], ['moved_stop', 'Moved the stop'], ['revenge', 'Revenge trade'], ['exited_early', 'Exited early'], ['skipped_stop', "Didn't take the stop"]],
});

export const GRADES = ['A++', 'A', 'B', 'C', 'D', 'F'];
export const PLAN_FOLLOWED = /** @type {[string, string][]} */ ([['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]);
/** labels a trade has one of; the rest take any number */
export const SINGLE = new Set(['sector', 'tactic']);
/** what a trade needs to count as reviewed, in the order the review says what's missing */
export const REQUIRED = ['market', 'sector', 'setup', 'tactic', 'setup grade', 'plan followed', 'note'];

/** a default's key as the library stores it ('sma50'), or your own ('mine:<uuid>'). @param {LibraryRow} row */
const ownKey = row => `mine:${row.id}`;

/**
 * The library: the defaults with your changes (a row with a default_key renames or hides it), your own items, and
 * merges (an item merged into another resolves to it). resolve() follows merges; nameOf() names any key, a setup's too.
 * @param {LibraryRow[]} rows
 */
export function buildLibrary(rows = []) {
  /** @type {Map<string, LibraryRow>} */
  const changed = new Map(rows.filter(r => r.default_key).map(r => [`${r.kind}:${r.default_key}`, r]));
  /** @type {Record<string, Item[]>} */
  const byKind = {};
  /** @type {Map<string, Item>} */
  const all = new Map();
  /** @type {Map<string, string>} */
  const merged = new Map();
  for (const [kind, list] of /** @type {[ItemKind, [string, string][]][]} */ (Object.entries(DEFAULTS))) {
    byKind[kind] = [];
    for (const [key, name] of list) {
      const c = changed.get(`${kind}:${key}`);
      const item = { key, kind, name: c?.name || name, own: false, hidden: !!c?.hidden };
      byKind[kind].push(item);
      all.set(`${kind}:${key}`, item);
      if (c?.merged_into) merged.set(`${kind}:${key}`, c.merged_into);
    }
  }
  for (const r of rows) {
    if (r.default_key || !byKind[r.kind]) continue;
    const item = { key: ownKey(r), kind: r.kind, name: r.name, own: true, hidden: !!r.hidden };
    byKind[r.kind].push(item);
    all.set(`${r.kind}:${item.key}`, item);
    if (r.merged_into) merged.set(`${r.kind}:${item.key}`, r.merged_into);
  }
  /** an item key through any merges (a cycle stops where it started). @param {string} kind @param {string} key */
  const resolve = (kind, key) => {
    const seen = new Set();
    while (merged.has(`${kind}:${key}`) && !seen.has(key)) { seen.add(key); key = /** @type {string} */ (merged.get(`${kind}:${key}`)); }
    return key;
  };
  /** the item for a kind and key, merges followed. @param {string} kind @param {string} key */
  const item = (kind, key) => all.get(`${kind}:${resolve(kind, key)}`) || null;
  /**
   * a label's words: 'Strong', '50 SMA bounce', 'Base breakout', or the key itself when it's unknown.
   * @param {string} kind @param {string} value
   */
  const nameOf = (kind, value) => {
    if (kind === 'setup') {
      const s = parseSetup(value);
      if (s.pattern) return item('pattern', s.pattern)?.name || s.pattern;
      const level = item('level', s.level)?.name || s.level;
      return s.action ? `${level} ${item('action', s.action)?.name || s.action}` : level;
    }
    return item(kind, value)?.name || value;
  };
  /** the choices to offer for a kind: not hidden, not merged away. @param {ItemKind} kind */
  const choices = kind => (byKind[kind] || []).filter(i => !i.hidden && !merged.has(`${kind}:${i.key}`));
  return { byKind, resolve, item, nameOf, choices, merged };
}

/** a setup's key: 'sma50+bounce', 'sma50', or 'pattern:base_breakout'. @param {{ level?: string, action?: string, pattern?: string }} s */
export const setupKey = s => s.pattern ? `pattern:${s.pattern}` : s.action ? `${s.level}+${s.action}` : String(s.level || '');

/** @param {string} key */
export function parseSetup(key) {
  if (key.startsWith('pattern:')) return { pattern: key.slice(8), level: '', action: '' };
  const [level, action = ''] = key.split('+');
  return { pattern: '', level, action };
}

/**
 * Where a trade's review stands: its market (this trade's own, else the day's), what's missing, and whether it's
 * reviewed. labels: the trade's label rows; review: its trade_reviews fields; dayMarket: the day's market.
 * @param {{ setup_grade?: string | null, plan_followed?: string | null, note?: string | null, market?: string | null } | null | undefined} review
 * @param {Label[]} labels @param {string | null | undefined} dayMarket
 */
export function reviewState(review, labels, dayMarket) {
  const has = (/** @type {string} */ kind) => labels.some(l => l.kind === kind);
  const market = review?.market || dayMarket || null;
  /** @type {[string, boolean][]} */
  const checks = [
    ['market', !!market], ['sector', has('sector')], ['setup', has('setup')], ['tactic', has('tactic')],
    ['setup grade', !!review?.setup_grade], ['plan followed', !!review?.plan_followed], ['note', !!review?.note?.trim()],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { market, marketOwn: !!review?.market, missing, reviewed: !missing.length, started: missing.length < REQUIRED.length };
}

/** 'missing sector, note' in words: the first few, then how many more. @param {string[]} missing */
export function missingWords(missing) {
  return missing.length > 4 ? `${missing.slice(0, 3).join(', ')} and ${missing.length - 3} more` : missing.join(', ');
}

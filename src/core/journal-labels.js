// @ts-check
// Journal review, pure (docs/journal-step-3.md): the label defaults, your library on top of them (your own items,
// renamed / hidden / merged defaults), My setups (each an action at one or more levels, or a pattern, saved once and
// picked from then on), and whether a trade is reviewed: market, sector, a setup, a tactic, both grades and a note.

/** @typedef {'market' | 'sector' | 'setup' | 'level' | 'action' | 'pattern' | 'tactic' | 'tag' | 'mistake'} ItemKind */
/** @typedef {{ action?: string, levels?: string[], pattern?: string }} SetupParts  an action at its levels, or a pattern */
/** @typedef {{ key: string, kind: ItemKind, name: string, own: boolean, hidden: boolean }} Item */
/** @typedef {{ id: string, kind: ItemKind, name: string, default_key?: string | null, hidden?: boolean, merged_into?: string | null, settings?: any }} LibraryRow */
/** @typedef {{ kind: string, value: string, set_by?: string }} Label */

/** the defaults everyone gets, by kind: [key, name] */
export const DEFAULTS = /** @type {Record<ItemKind, [string, string][]>} */ ({
  market: [['bullish', 'Bullish'], ['neutral', 'Neutral'], ['bearish', 'Bearish'], ['choppy', 'Choppy']],
  sector: [['strong', 'Strong'], ['weak', 'Weak'], ['neutral', 'Neutral'], ['na', 'N/A']],
  setup: [['ema8_bounce', '8 EMA bounce'], ['ema21_bounce', '21 EMA bounce'], ['sma50_bounce', '50 SMA bounce'], ['ema21_unr', '21 EMA undercut & rally'], ['sma50_unr', '50 SMA undercut & rally'], ['ema21_rejection', '21 EMA rejection'], ['base_breakout', 'Base breakout'], ['flag_breakout', 'Flag breakout'], ['earnings_gap', 'Earnings gap']],
  level: [['sma50', '50 SMA'], ['sma100', '100 SMA'], ['sma200', '200 SMA'], ['ema8', '8 EMA'], ['ema21', '21 EMA'], ['support', 'Support'], ['resistance', 'Resistance'], ['avwap_ath', 'AVWAP from ATH'], ['avwap_atl', 'AVWAP from ATL'], ['avwap_earnings', 'AVWAP from earnings']],
  action: [['bounce', 'bounce'], ['undercut', 'undercut & rally'], ['rejection', 'rejection']],
  pattern: [['base_breakout', 'Base breakout'], ['flag_breakout', 'Pennant or flag breakout'], ['earnings_gap', 'Earnings gap']],
  tactic: [['six20', '6/20 (Gil Morales)'], ['pivot15', '15-minute pivot'], ['pivot30', '30-minute pivot']],
  tag: [['option_flow', 'Option flow']],
  mistake: [['chased', 'Chased the entry'], ['oversized', 'Oversized'], ['moved_stop', 'Moved the stop'], ['revenge', 'Revenge trade'], ['exited_early', 'Exited early'], ['skipped_stop', "Didn't take the stop"]],
});

/** what the starting setups are made of */
export const DEFAULT_SETUP_PARTS = /** @type {Record<string, SetupParts>} */ ({
  ema8_bounce: { action: 'bounce', levels: ['ema8'] }, ema21_bounce: { action: 'bounce', levels: ['ema21'] }, sma50_bounce: { action: 'bounce', levels: ['sma50'] },
  ema21_unr: { action: 'undercut', levels: ['ema21'] }, sma50_unr: { action: 'undercut', levels: ['sma50'] }, ema21_rejection: { action: 'rejection', levels: ['ema21'] },
  base_breakout: { pattern: 'base_breakout' }, flag_breakout: { pattern: 'flag_breakout' }, earnings_gap: { pattern: 'earnings_gap' },
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
    const item = { key: ownKey(r), kind: r.kind, name: r.name, own: true, hidden: !!r.hidden, settings: r.settings || {} };
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
   * a label's words: 'Strong', '21 EMA bounce', 'Base breakout', or the key itself when it's unknown.
   * @param {string} kind @param {string} value
   */
  const nameOf = (kind, value) => {
    if (kind === 'setup' && item('setup', value)) return /** @type {Item} */ (item('setup', value)).name;
    if (kind === 'setup') { // a setup written as its parts ('sma50+bounce', 'pattern:base_breakout')
      const s = parseSetup(value);
      if (s.pattern) return item('pattern', s.pattern)?.name || s.pattern;
      const level = item('level', s.level)?.name || s.level;
      return s.action ? `${level} ${item('action', s.action)?.name || s.action}` : level;
    }
    return item(kind, value)?.name || value;
  };
  /** the choices to offer for a kind: not hidden, not merged away. @param {ItemKind} kind */
  const choices = kind => (byKind[kind] || []).filter(i => !i.hidden && !merged.has(`${kind}:${i.key}`));
  /** what a setup is made of: { action, levels } or { pattern }, merges followed. @param {string} key */
  const parts = key => {
    const k = resolve('setup', key);
    const own = /** @type {any} */ (all.get(`setup:${k}`));
    const p = own?.own ? own.settings : DEFAULT_SETUP_PARTS[k];
    if (p) return p.pattern ? { pattern: p.pattern } : { action: p.action || '', levels: [...(p.levels || [])] };
    const s = parseSetup(k);
    return s.pattern ? { pattern: s.pattern } : { action: s.action, levels: s.level ? [s.level] : [] };
  };
  /** a setup's parts in words: 'Bounce at 21 EMA + Support', or the pattern's name. @param {SetupParts} p */
  const partsWords = p => p.pattern ? nameOf('pattern', p.pattern)
    : `${(nameOf('action', p.action || '') || '').replace(/^./, c => c.toUpperCase())} at ${(p.levels || []).map(l => nameOf('level', l)).join(' + ')}`;
  return { byKind, resolve, item, nameOf, choices, merged, parts, partsWords };
}

/**
 * The name a new setup gets until you type one: the pattern's, or 'levels action' ('50 SMA + Support undercut & rally').
 * @param {ReturnType<typeof buildLibrary>} lib @param {SetupParts} p
 */
export function setupName(lib, p) {
  if (p.pattern) return lib.nameOf('pattern', p.pattern);
  if (!p.action || !p.levels?.length) return '';
  return `${p.levels.map(l => lib.nameOf('level', l)).join(' + ')} ${lib.nameOf('action', p.action)}`;
}

/** two setups made of the same things (levels in any order). @param {SetupParts} a @param {SetupParts} b */
export const sameParts = (a, b) => a.pattern || b.pattern ? a.pattern === b.pattern
  : a.action === b.action && [...(a.levels || [])].sort().join('|') === [...(b.levels || [])].sort().join('|');

/**
 * My setups to offer, most used first (then the list's own order): labels is every trade's labels.
 * @param {ReturnType<typeof buildLibrary>} lib @param {Record<string, Label[]>} labels
 */
export function setupsByUse(lib, labels) {
  /** @type {Map<string, number>} */
  const used = new Map();
  for (const list of Object.values(labels || {})) for (const l of list) if (l.kind === 'setup') { const k = lib.resolve('setup', l.value); used.set(k, (used.get(k) || 0) + 1); }
  return lib.choices('setup').map((i, n) => ({ i, n, u: used.get(i.key) || 0 })).sort((a, b) => b.u - a.u || a.n - b.n).map(x => x.i);
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

/**
 * Whether one of My setups fits what's picked so far in + New setup: the same pattern; or the same action (when one is
 * picked) at every level picked (it may sit on more). Nothing picked fits everything.
 * @param {ReturnType<typeof buildLibrary>} lib @param {string} key @param {{ action?: string, levels?: string[], pattern?: string }} draft
 */
export function setupFits(lib, key, draft) {
  const p = lib.parts(key);
  if (draft.pattern) return p.pattern === draft.pattern;
  if (p.pattern) return !draft.action && !(draft.levels || []).length;
  if (draft.action && p.action !== draft.action) return false;
  return (draft.levels || []).every(l => (p.levels || []).includes(l));
}

// ---------- links on a tag (Option flow: Unusual Whales, Bullflow) ----------

const KNOWN_SITES = /** @type {[RegExp, string][]} */ ([[/(^|\.)unusualwhales\.com$/, 'Unusual Whales'], [/(^|\.)bullflow\.io$/, 'Bullflow']]);
export const MAX_LINKS = 10;

/** a pasted link, cleaned: https only, at most 500 characters; '' when it isn't one. @param {string} raw */
export function cleanLink(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 500) return '';
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.href : '';
  } catch(e) { return ''; }
}

/** what a link's chip says: the site's name for the flow sites, else its host. @param {string} url */
export function linkLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known = KNOWN_SITES.find(([re]) => re.test(host));
    return known ? known[1] : host;
  } catch(e) { return url; }
}

// @ts-check
// Journal review, pure (docs/journal-step-3.md): the label defaults, your library on top of them (your own items,
// renamed / hidden / merged defaults), My setups (each an action at one or more levels, or a pattern, saved once and
// picked from then on; each reads by the trade's side: a bounce on a short is a rejection), whether a trade is reviewed (market, sector, a setup, a tactic, both grades and an exit note), and the
// review deck's queue (the pass each trade needs: opening while it's open, the plan, grade and exit note once it closes; newest
// first, from the day you chose to start reviewing).
import { nyParts } from './journal-stats.js';

/** @typedef {'market' | 'sector' | 'setup' | 'level' | 'action' | 'pattern' | 'tactic' | 'tag' | 'mistake'} ItemKind */
/** @typedef {{ action?: string, levels?: string[], pattern?: string }} SetupParts  an action at its levels, or a pattern */
/** @typedef {{ key: string, kind: ItemKind, name: string, short: string, own: boolean, hidden: boolean, follows?: boolean, settings?: any }} Item  short: its words on a short ('' when the same) */
/** @typedef {'long' | 'short' | 'both'} SideWords  which words to use: a long's, a short's, or both ('bounce / rejection') */
/** @typedef {{ id: string, kind: ItemKind, name: string, default_key?: string | null, hidden?: boolean, merged_into?: string | null, settings?: any }} LibraryRow */
/** @typedef {{ kind: string, value: string, set_by?: string }} Label */

/** the defaults everyone gets, by kind: [key, name] */
export const DEFAULTS = /** @type {Record<ItemKind, [string, string][]>} */ ({
  market: [['bullish', 'Bullish'], ['neutral', 'Neutral'], ['bearish', 'Bearish'], ['choppy', 'Choppy']],
  sector: [['strong', 'Strong'], ['weak', 'Weak'], ['neutral', 'Neutral'], ['na', 'N/A']],
  setup: [['ema8_bounce', '8 EMA bounce'], ['ema21_bounce', '21 EMA bounce'], ['sma50_bounce', '50 SMA bounce'], ['ema9w_bounce', '9 WK EMA bounce'], ['ema21_unr', '21 EMA undercut & rally'], ['sma50_unr', '50 SMA undercut & rally'], ['ema21_rejection', '21 EMA rejection'], ['base_breakout', 'Base breakout'], ['flag_breakout', 'Pennant or flag breakout'], ['earnings_gap', 'Earnings gap']],
  level: [['sma50', '50 SMA'], ['sma100', '100 SMA'], ['sma200', '200 SMA'], ['ema8', '8 EMA'], ['ema21', '21 EMA'], ['ema9w', '9 WK EMA'], ['support', 'Support'], ['resistance', 'Resistance'], ['avwap_ath', 'AVWAP from ATH'], ['avwap_atl', 'AVWAP from ATL'], ['avwap_earnings', 'AVWAP from earnings']],
  action: [['bounce', 'bounce'], ['undercut', 'undercut & rally'], ['rejection', 'rejection']],
  pattern: [['base_breakout', 'Base breakout'], ['flag_breakout', 'Pennant or flag breakout'], ['earnings_gap', 'Earnings gap']],
  tactic: [['six20', '6/20 (Gil Morales)'], ['pivot15', '15-minute pivot'], ['pivot30', '30-minute pivot']],
  tag: [['option_flow', 'Option flow']],
  mistake: [['chased', 'Chased the entry'], ['oversized', 'Oversized'], ['moved_stop', 'Moved the stop'], ['revenge', 'Revenge trade'], ['exited_early', 'Exited early'], ['skipped_stop', "Didn't take the stop"]],
});

/**
 * What a default reads on a short (its name is the long side's). A default not here reads the same both ways; your own
 * items and renamed defaults keep theirs in settings.short.
 */
export const DEFAULT_SHORT = /** @type {Record<string, string>} */ ({
  'action:bounce': 'rejection', 'action:undercut': 'reclaim & fail',
  // a long off support is a short at resistance, a breakout through resistance a breakdown through support
  'level:support': 'Resistance', 'level:resistance': 'Support',
  'pattern:base_breakout': 'Base breakdown', 'pattern:flag_breakout': 'Pennant or flag breakdown',
});
/** names a starting setup had before it was named for its parts: a row that still says one was never typed, so it follows them */
const FORMER_NAMES = /** @type {Record<string, string[]>} */ ({ 'setup:flag_breakout': ['Flag breakout', 'Flag breakdown'] });
/** defaults that are another one seen from the short side, merged into it for everyone: a rejection is a bounce on a short */
export const BUILT_IN_MERGES = new Map([['action:rejection', 'bounce'], ['setup:ema21_rejection', 'ema21_bounce']]);

/**
 * Both sides' words in one: the words they share, then each one's rest ('9 EMA bounce / rejection'); one when they're the same.
 * @param {string} long @param {string} [short]
 */
export function bothWords(long, short) {
  if (!short || short === long) return long;
  const a = long.split(' '), b = short.split(' ');
  let n = 0;
  while (n < a.length - 1 && n < b.length - 1 && a[n].toLowerCase() === b[n].toLowerCase()) n++;
  return [...a.slice(0, n), `${a.slice(n).join(' ')} / ${b.slice(n).join(' ')}`].join(' ');
}
/** an item's words for a side; no side is the long one. @param {string} name @param {string} short @param {SideWords} [side] */
const sided = (name, short, side) => !short || !side || side === 'long' ? name : side === 'short' ? short : bothWords(name, short);
/** the words a trade's setups read in: its side, both for a neutral one. @param {{ bias?: string }} t @returns {SideWords} */
export const tradeSide = t => t.bias === 'short' ? 'short' : t.bias === 'long' || !t.bias ? 'long' : 'both';

/** what the starting setups are made of */
export const DEFAULT_SETUP_PARTS = /** @type {Record<string, SetupParts>} */ ({
  ema8_bounce: { action: 'bounce', levels: ['ema8'] }, ema21_bounce: { action: 'bounce', levels: ['ema21'] }, sma50_bounce: { action: 'bounce', levels: ['sma50'] }, ema9w_bounce: { action: 'bounce', levels: ['ema9w'] },
  ema21_unr: { action: 'undercut', levels: ['ema21'] }, sma50_unr: { action: 'undercut', levels: ['sma50'] }, ema21_rejection: { action: 'rejection', levels: ['ema21'] },
  base_breakout: { pattern: 'base_breakout' }, flag_breakout: { pattern: 'flag_breakout' }, earnings_gap: { pattern: 'earnings_gap' },
});

export const GRADES = ['A', 'B', 'C', 'D', 'F'];
/** a kept grade as the app shows it: A to F; an A++ saved before the grades were cut to five is an A. @param {unknown} g */
export const gradeOf = g => g === 'A++' ? 'A' : GRADES.includes(/** @type {string} */ (g)) ? /** @type {string} */ (g) : null;
export const PLAN_FOLLOWED = /** @type {[string, string][]} */ ([['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]);
/** labels a trade has one of; the rest take any number */
export const SINGLE = new Set(['sector']);
/** what a trade needs to count as reviewed, in the order the review says what's missing */
export const REQUIRED = ['market', 'sector', 'setup', 'tactic', 'setup grade', 'plan followed', 'exit note'];

/** every default's own words, 'level:ema8' → '8 EMA' */
const DEFAULT_NAMES = new Map(Object.entries(DEFAULTS).flatMap(([kind, list]) => list.map(([key, name]) => [`${kind}:${key}`, name])));
/** a default's own words for a side, '\0' for anything else (so a name made of it never matches). @param {'long' | 'short'} side */
const defaultWords = side => (/** @type {string} */ kind, /** @type {string} */ key) => {
  const n = DEFAULT_NAMES.get(`${kind}:${key}`);
  return n === undefined ? '\0' : side === 'short' && DEFAULT_SHORT[`${kind}:${key}`] || n;
};
/** a short word kept in settings ('' clears a default's), else the default's own. @param {any} settings @param {string} id */
const shortOf = (settings, id) => typeof settings?.short === 'string' ? settings.short.trim() : DEFAULT_SHORT[id] || '';
/**
 * An action or pattern of yours with no short word set: a breakout's is a breakdown ('Breakout' → 'Breakdown',
 * 'Flat base breakout' → 'Flat base breakdown'); anything else reads the same both ways.
 * @param {string} name
 */
export const guessShort = name => /break ?out/i.test(name) ? name.replace(/(break ?)(out)/gi, (_, b, o) => b + (o === 'OUT' ? 'DOWN' : o[0] === 'O' ? 'Down' : 'down')) : '';
/** an action's word inside a setup's name: lower case like the defaults' ('Resistance breakout'), an acronym kept. @param {string} w */
const lowerFirst = w => /^[A-Z][a-z]/.test(w) ? w[0].toLowerCase() + w.slice(1) : w;
/**
 * A moving average's place among the levels: by length in days (a weekly one's weeks × 5, so 9 WK EMA sits between 21 EMA
 * and 50 SMA), an EMA before the SMA of the same length; null for any other level.
 * @param {string} name
 */
const maOrder = name => {
  const m = /^(\d+)\s*(?:(wk|w|week|weekly)\s*)?(EMA|SMA)$/i.exec(name.trim());
  return m ? +m[1] * (m[2] ? 5 : 1) * 2 + (m[3].toUpperCase() === 'SMA' ? 1 : 0) : null;
};

/**
 * A setup's parts in a setup's name: the pattern's, or 'levels action'; '' when it isn't whole.
 * @param {SetupParts} p @param {(kind: string, key: string) => string} name
 */
const partsName = (p, name) => p.pattern ? name('pattern', p.pattern)
  : p.action && p.levels?.length ? `${p.levels.map(l => name('level', l)).join(' + ')} ${lowerFirst(name('action', p.action))}` : '';

/** a default's key as the library stores it ('sma50'), or your own ('mine:<uuid>'). @param {LibraryRow} row */
const ownKey = row => `mine:${row.id}`;

/**
 * The library: the defaults with your changes (a row with a default_key renames or hides it), your own items, and
 * merges (an item merged into another resolves to it; BUILT_IN_MERGES for everyone). resolve() follows merges; nameOf()
 * names any key, a setup's too, in a side's words.
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
      const item = { key, kind, name: c?.name || name, short: shortOf(c?.settings, `${kind}:${key}`), own: false, hidden: !!c?.hidden, settings: c?.settings || {} };
      byKind[kind].push(item);
      all.set(`${kind}:${key}`, item);
      const into = c?.merged_into || BUILT_IN_MERGES.get(`${kind}:${key}`);
      if (into) merged.set(`${kind}:${key}`, into);
    }
  }
  for (const r of rows) {
    if (r.default_key || !byKind[r.kind]) continue;
    const guess = typeof r.settings?.short !== 'string' && (r.kind === 'action' || r.kind === 'pattern') ? guessShort(r.name) : '';
    const item = { key: ownKey(r), kind: r.kind, name: r.name, short: shortOf(r.settings, '') || guess, own: true, hidden: !!r.hidden, settings: r.settings || {} };
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
   * a label's words: 'Strong', '21 EMA bounce', 'Base breakout', or the key itself when it's unknown; side picks a long's
   * words (the default), a short's ('21 EMA rejection') or both ('21 EMA bounce / rejection').
   * @param {string} kind @param {string} value @param {SideWords} [side] @returns {string}
   */
  const nameOf = (kind, value, side) => {
    const it = item(kind, value);
    if (it) return sided(it.name, it.short, side);
    if (kind === 'setup') { // a setup written as its parts ('sma50+bounce', 'pattern:base_breakout')
      if (side === 'both') return bothWords(nameOf(kind, value, 'long'), nameOf(kind, value, 'short'));
      const s = parseSetup(value);
      if (s.pattern) return nameOf('pattern', s.pattern, side);
      const level = nameOf('level', s.level, side);
      return s.action ? `${level} ${lowerFirst(nameOf('action', s.action, side))}` : level;
    }
    return value;
  };
  /**
   * the choices to offer for a kind: not hidden, not merged away; levels with the moving averages first by length
   * (4 EMA, 9 EMA, 21 EMA, 50 SMA, 100 SMA, 200 SMA), then the rest in the list's order. @param {ItemKind} kind
   */
  const choices = kind => {
    const list = (byKind[kind] || []).filter(i => !i.hidden && !merged.has(`${kind}:${i.key}`));
    if (kind !== 'level') return list;
    return list.map((i, n) => ({ i, n, m: maOrder(i.name) ?? Infinity })).sort((a, b) => (a.m - b.m) || a.n - b.n).map(x => x.i);
  };
  /** what a setup is made of: { action, levels } or { pattern }, merges followed (its own and its parts'). @param {string} key */
  const parts = key => {
    const p = rawParts(key);
    return p.pattern ? { pattern: resolve('pattern', p.pattern) } : { action: p.action ? resolve('action', p.action) : '', levels: [...new Set((p.levels || []).map(l => resolve('level', l)))] };
  };
  /** @param {string} key @returns {SetupParts} */
  const rawParts = key => {
    const k = resolve('setup', key);
    const own = /** @type {any} */ (all.get(`setup:${k}`));
    // yours keeps its parts; a default keeps its own unless you edited it (its row's settings)
    const edited = own?.settings?.pattern || own?.settings?.action ? own.settings : null;
    const p = own?.own ? own.settings : edited || DEFAULT_SETUP_PARTS[k];
    if (p) return p.pattern ? { pattern: p.pattern } : { action: p.action || '', levels: [...(p.levels || [])] };
    const s = parseSetup(k);
    return s.pattern ? { pattern: s.pattern } : { action: s.action, levels: s.level ? [s.level] : [] };
  };
  /** a setup's parts in words: 'Bounce at 21 EMA + Support', or the pattern's name. @param {SetupParts} p @param {SideWords} [side] */
  const partsWords = (p, side) => p.pattern ? nameOf('pattern', p.pattern, side)
    : `${(nameOf('action', p.action || '', side) || '').replace(/^./, (/** @type {string} */ c) => c.toUpperCase())} at ${(p.levels || []).map(l => nameOf('level', l, side)).join(' + ')}`;
  const words = (/** @type {SideWords} */ side) => (/** @type {string} */ kind, /** @type {string} */ key) => nameOf(kind, key, side);
  // a setup named for its parts, either side's words, the defaults' or yours ('8 EMA bounce', '8 EMA rejection'), in any
  // case, was never typed: it follows them renamed ('9 EMA bounce') and reads by side. So does one still under a name the
  // starting setups had before (FORMER_NAMES). A typed one keeps its name and its own short one.
  for (const i of byKind.setup) {
    const p = parts(i.key), raw = rawParts(i.key), long = partsName(p, words('long'));
    const said = [raw, p].flatMap(x => [partsName(x, defaultWords('long')), partsName(x, defaultWords('short'))]);
    const untyped = [...said, long, partsName(p, words('short')), ...(i.own ? [] : FORMER_NAMES[`setup:${i.key}`] || [])].map(n => n.toLowerCase());
    i.follows = !!long && untyped.includes(i.name.toLowerCase());
    if (i.follows) { i.name = long; i.short = partsName(p, words('short')); }
    else if (typeof i.settings?.short !== 'string' && i.name !== DEFAULT_NAMES.get(`setup:${i.key}`)) i.short = '';
  }
  return { byKind, resolve, item, nameOf, choices, merged, parts, partsWords };
}

/**
 * The name a new setup gets until you type one: the pattern's, or 'levels action' ('50 SMA + Support undercut & rally').
 * @param {ReturnType<typeof buildLibrary>} lib @param {SetupParts} p @param {SideWords} [side]
 */
export const setupName = (lib, p, side) => partsName(p, (kind, key) => lib.nameOf(kind, key, side));

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

/**
 * What a setup adds up under, the action first and the level second: its kind (the action, 'action:bounce' 'Bounce', or
 * for a pattern the pattern, 'pat:base_breakout') and its levels ('level:ema21' '21 EMA'), merges followed. A setup made
 * of neither (an old level-only value) has no kind. So every bounce adds up as Bounce, whatever it bounced off; the names
 * are in side's words (a short's bounce is 'Rejection').
 * @param {ReturnType<typeof buildLibrary>} lib @param {string} key @param {SideWords} [side]
 * @returns {{ kind: { key: string, name: string, action: boolean } | null, levels: { key: string, name: string }[] }}
 */
export function setupGroups(lib, key, side) {
  const p = lib.parts(key);
  if (p.pattern) return { kind: { key: `pat:${p.pattern}`, name: lib.nameOf('pattern', p.pattern, side), action: false }, levels: [] };
  const a = p.action || '';
  return {
    kind: a ? { key: `action:${a}`, name: lib.nameOf('action', a, side).replace(/^./, (/** @type {string} */ c) => c.toUpperCase()), action: true } : null,
    levels: (p.levels || []).map(l => ({ key: `level:${l}`, name: lib.nameOf('level', l, side) })),
  };
}

/**
 * An action or pattern that is another one's short side: its name is that one's short word ('Pennant or flag breakdown'
 * beside the flag's breakout), so it can merge into it. The first offered, or null.
 * @param {ReturnType<typeof buildLibrary>} lib @param {ItemKind} kind @param {string} key
 */
export function shortTwin(lib, kind, key) {
  const it = lib.item(kind, key);
  if (!it) return null;
  const name = it.name.trim().toLowerCase();
  return name ? lib.choices(kind).find(i => i.key !== it.key && i.short.trim().toLowerCase() === name) || null : null;
}

/**
 * Another of My setups made of the same things as this one (now that a side reads it, a bounce and a rejection at the same
 * level are one setup): the first offered, or null.
 * @param {ReturnType<typeof buildLibrary>} lib @param {string} key
 */
export function setupTwin(lib, key) {
  const k = lib.resolve('setup', key), p = lib.parts(k);
  return lib.choices('setup').find(i => i.key !== k && sameParts(lib.parts(i.key), p)) || null;
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
 * reviewed. labels: the trade's label rows; review: its trade_reviews fields (note is the exit note; the entry note is
 * optional, so it never counts); dayMarket: the day's market.
 * @param {{ setup_grade?: string | null, plan_followed?: string | null, note?: string | null, market?: string | null } | null | undefined} review
 * @param {Label[]} labels @param {string | null | undefined} dayMarket
 */
export function reviewState(review, labels, dayMarket) {
  const has = (/** @type {string} */ kind) => labels.some(l => l.kind === kind);
  const market = review?.market || dayMarket || null;
  /** @type {[string, boolean][]} */
  const checks = [
    ['market', !!market], ['sector', has('sector')], ['setup', has('setup')], ['tactic', has('tactic')],
    ['setup grade', !!review?.setup_grade], ['plan followed', !!review?.plan_followed], ['exit note', !!review?.note?.trim()],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { market, marketOwn: !!review?.market, missing, reviewed: !missing.length, started: missing.length < REQUIRED.length };
}

/** what a trade still open needs before it leaves the review deck: the labels; the plan, grade and exit note wait for the close */
export const OPENING_PASS = ['market', 'sector', 'setup', 'tactic'];

/**
 * The pass a trade needs in the review deck, or null for none. Open: 'opening' until the opening fields are in. Closed
 * and not reviewed: 'closing' when only the plan, grade and exit note are left, else 'full'. Deleted and before-history trades none.
 * @param {{ status?: string, deleted?: boolean }} t @param {{ missing: string[], reviewed: boolean }} st
 * @returns {'opening' | 'closing' | 'full' | null}
 */
export function reviewPass(t, st) {
  if (t.status === 'history' || t.deleted) return null;
  const openingDone = !st.missing.some(m => OPENING_PASS.includes(m));
  if (t.status === 'open') return openingDone ? null : 'opening';
  if (st.reviewed) return null;
  return openingDone ? 'closing' : 'full';
}

/** a "review from" day as kept: 'YYYY-MM-DD', or '' for every day. @param {unknown} v */
export const reviewFromDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : '';

/** whether a trade opened on or after the review-from day (New York), or there's no such day. @param {{ openedAt?: string | null }} t @param {string} from */
export const fromReviewDay = (t, from) => !from || (!!t.openedAt && nyParts(t.openedAt).day >= from);

/**
 * The review deck's queue: every trade that needs a pass and opened on or after `from` (a New York day, '' for all),
 * newest first (by open time, then key). No other filters.
 * @template {{ key: string, openedAt?: string | null, status?: string, deleted?: boolean }} T
 * @param {T[]} trades @param {(t: T) => { missing: string[], reviewed: boolean }} stateOf @param {string} [from]
 */
export function deckQueue(trades, stateOf, from = '') {
  return trades.filter(t => fromReviewDay(t, from) && reviewPass(t, stateOf(t)))
    .sort((a, b) => (a.openedAt || '') < (b.openedAt || '') ? 1 : (a.openedAt || '') > (b.openedAt || '') ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
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

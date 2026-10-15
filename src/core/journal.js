// @ts-check
// Journal trades, pure: kept fills grouped into trades (flat back to flat, first in first out, scale-ins, partial exits,
// flips, ×100 for options), each with P&L, hold time, its initial stop and R. Trades are computed every time from the kept
// fills; what's stored is only which trades you said are one (Supabase's trades table: a row's fill ids), and a merged
// trade or spread is worked out from its parts the same way (docs/journal-step-2.md). Schwab's orders carry no fees, so
// P&L here is before fees.
import { parseSchwabOption, schwabTime } from './positions.js';

const EPS = 1e-9;
const DAY = 86400000;
/** a stop entered this long before the first fill still counts as the trade's: a trigger's stop is entered with its entry */
export const STOP_LEAD_MS = 5 * 60000;

/** @param {string} assetType */
export const multiplierOf = assetType => assetType === 'OPTION' ? 100 : 1;

/**
 * @typedef {{ id: string, orderId: string, account?: string, time: string, symbol: string, label: string, assetType: string,
 *   instruction: string, side: 'buy' | 'sell', qty: number, price: number }} Fill
 * @typedef {{ orderId: string, account: string, symbol: string, instruction: string, stopPrice: number, entered: string, status: string }} StopOrder
 * @typedef {{ key: string, account: string, symbol: string, label: string, assetType: string, multiplier: number,
 *   direction: 'long' | 'short', openedAt: string, closedAt: string | null, entryQty: number, openQty: number,
 *   avgEntry: number, avgExit: number | null, pnl: number, exits: number, fillIds: string[], holdMs: number | null,
 *   status: 'open' | 'win' | 'loss' | 'breakeven', stop: number | null, stopOrderId: string, risk: number | null,
 *   rBasis: 'stop' | 'premium' | 'spread' | null, r: number | null, orderId: string,
 *   kind: 'single' | 'merged' | 'spread', id: string, savedIds: string[], parts: string[],
 *   bias: 'long' | 'short' | 'neutral', net: 'debit' | 'credit' | null, structure: string }} Trade
 * direction = bought or sold first (the P&L and stop math); bias = the bet on the stock, what the Side shows: calls
 * bought and puts sold are long; a one-type spread goes by strikes, bought below what's sold = long (call debit, put
 * credit, a put diagonal selling shorter-dated puts above a longer-dated one), above = short, one strike over two
 * expirations (a time spread) = neutral. net = a spread's debit or credit; structure = 'call debit', 'put diagonal', 'time spread'.
 * kind: single = grouped flat to flat on its own; merged = trades on one symbol you said are one; spread = option
 * contracts on one underlying you said are one. id / savedIds = the saved rows behind it, parts = the trades it's made of.
 * orderId = the order that opened it.
 * @typedef {{ id: string, account: string, fill_ids: string[], created_at?: string }} SavedTrade
 */

/**
 * a trade being built: its open lots, first in first out
 * @param {Fill} fill @param {string} account @param {'long' | 'short'} direction
 */
function startTrade(fill, account, direction) {
  return {
    key: `${account}|${fill.symbol}|${direction}|${fill.time}`,
    account, symbol: fill.symbol, label: fill.label || fill.symbol, assetType: fill.assetType, multiplier: multiplierOf(fill.assetType),
    direction, openedAt: fill.time, closedAt: /** @type {string | null} */ (null), entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0,
    orderId: String(fill.orderId || ''), pnl: 0, exits: 0, fillIds: [], lots: /** @type {{ qty: number, price: number }[]} */ ([]),
  };
}

/** @param {ReturnType<typeof startTrade>} t @returns {Trade} */
function finish(t) {
  const openQty = t.lots.reduce((/** @type {number} */ n, l) => n + l.qty, 0);
  const closed = openQty <= EPS;
  const pnl = Math.round(t.pnl * 100) / 100;
  return {
    key: t.key, account: t.account, symbol: t.symbol, label: t.label, assetType: t.assetType, multiplier: t.multiplier,
    direction: t.direction, openedAt: t.openedAt, closedAt: closed ? t.closedAt : null,
    entryQty: t.entryQty, openQty: closed ? 0 : openQty,
    avgEntry: t.entryQty ? t.entryNotional / t.entryQty : 0,
    avgExit: t.exitQty ? t.exitNotional / t.exitQty : null,
    pnl, exits: t.exits, fillIds: t.fillIds,
    holdMs: closed && t.closedAt ? Date.parse(t.closedAt) - Date.parse(t.openedAt) : null,
    status: !closed ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven',
    stop: null, stopOrderId: '', risk: null, rBasis: null, r: null,
    orderId: t.orderId, kind: 'single', id: '', savedIds: [], parts: [],
    bias: legBias(t), net: null, structure: '',
  };
}

/** a stock or one option's bet on the stock: a put bought is short. @param {{ symbol: string, assetType: string, direction: 'long' | 'short' }} t @returns {'long' | 'short'} */
function legBias(t) {
  const put = t.assetType === 'OPTION' && parseSchwabOption(t.symbol)?.type === 'P';
  return put ? (t.direction === 'long' ? 'short' : 'long') : t.direction;
}

/**
 * Fills → trades, per account and symbol (an option's symbol is its contract), in time order. A fill that takes the
 * position through zero closes the trade and opens the next one in the other direction with what's left (a flip).
 * @param {Fill[]} fills
 * @returns {Trade[]}
 */
export function buildTrades(fills) {
  /** @type {Map<string, Fill[]>} */
  const groups = new Map();
  for (const f of fills) {
    if (!f.symbol || !(f.qty > 0) || !(f.price > 0) || !f.time) continue;
    const k = `${f.account || ''}|${f.symbol}`;
    if (!groups.has(k)) groups.set(k, []);
    /** @type {Fill[]} */ (groups.get(k)).push(f);
  }
  /** @type {Trade[]} */
  const trades = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
    /** @type {any} */
    let t = null;
    for (const f of list) {
      const account = f.account || '';
      let qty = f.qty;
      const buying = f.side === 'buy';
      if (!t) t = startTrade(f, account, buying ? 'long' : 'short');
      const adds = (t.direction === 'long') === buying;
      t.fillIds.push(f.id);
      if (adds) {
        t.lots.push({ qty, price: f.price });
        t.entryQty += qty;
        t.entryNotional += qty * f.price;
        continue;
      }
      // reducing: match the oldest lots first
      t.exits++;
      const sign = t.direction === 'long' ? 1 : -1;
      while (qty > EPS && t.lots.length) {
        const lot = t.lots[0];
        const take = Math.min(lot.qty, qty);
        t.pnl += (f.price - lot.price) * take * sign * t.multiplier;
        t.exitQty += take;
        t.exitNotional += take * f.price;
        lot.qty -= take;
        qty -= take;
        if (lot.qty <= EPS) t.lots.shift();
      }
      if (!t.lots.length) {
        t.closedAt = f.time;
        trades.push(finish(t));
        t = null;
        if (qty > EPS) { // a flip: what's left opens the other way
          t = startTrade(f, account, buying ? 'long' : 'short');
          t.fillIds.push(f.id);
          t.lots.push({ qty, price: f.price });
          t.entryQty += qty;
          t.entryNotional += qty * f.price;
        }
      }
    }
    if (t) trades.push(finish(t));
  }
  return trades;
}

const CLOSES = { long: /^(SELL|SELL_TO_CLOSE)$/, short: /^(BUY|BUY_TO_COVER|BUY_TO_CLOSE)$/ };

/**
 * Every stop order in the kept orders, children of triggers and one-cancels-other pairs included, whatever happened to it
 * (a stop that was replaced or canceled still says where you first put it). A child without its own entered time takes
 * its parent's: the stop of a trigger goes in with its entry.
 * @param {{ kind: string, account?: string, data: any }[]} records
 * @returns {StopOrder[]}
 */
export function stopOrdersFrom(records) {
  /** @type {StopOrder[]} */
  const out = [];
  const walk = (/** @type {any} */ o, /** @type {string} */ account, /** @type {string} */ parentEntered) => {
    if (!o || typeof o !== 'object') return;
    const enteredRaw = o.enteredTime || parentEntered;
    const stopPrice = Number(o.stopPrice);
    if (/^(STOP|STOP_LIMIT|TRAILING_STOP|TRAILING_STOP_LIMIT)$/.test(o.orderType || '') && stopPrice > 0) {
      const leg = (o.orderLegCollection || [])[0] || {};
      const ms = schwabTime(enteredRaw);
      out.push({
        orderId: String(o.orderId ?? ''), account, symbol: leg.instrument?.symbol || '', instruction: leg.instruction || '',
        stopPrice, entered: Number.isFinite(ms) ? new Date(ms).toISOString() : '', status: o.status || '',
      });
    }
    (o.childOrderStrategies || []).forEach((/** @type {any} */ c) => walk(c, account, enteredRaw));
  };
  for (const r of records) if (r.kind === 'order') walk(r.data, r.account || '', '');
  return out;
}

/**
 * The trade's initial stop and R. The stop is the first stop order that closes this position, entered from just before
 * the first fill until the trade closed, on the loss side of the entry (a stop above a long's entry protects profit, it
 * isn't the risk). R = P&L ÷ risk, risk = |entry − stop| × quantity × multiplier. A long option with no stop risks its
 * premium. Open trades get their stop and risk, but no R yet.
 * @param {Trade} trade @param {StopOrder[]} stops
 * @returns {Trade}
 */
export function withRisk(trade, stops) {
  const opened = Date.parse(trade.openedAt);
  const until = trade.closedAt ? Date.parse(trade.closedAt) : Infinity;
  const lossSide = (/** @type {number} */ p) => trade.direction === 'long' ? p < trade.avgEntry : p > trade.avgEntry;
  const first = stops
    .filter(s => s.account === trade.account && s.symbol === trade.symbol && CLOSES[trade.direction].test(s.instruction) && lossSide(s.stopPrice))
    .filter(s => { const t = Date.parse(s.entered); return t >= opened - STOP_LEAD_MS && t <= until; })
    .sort((a, b) => (a.entered < b.entered ? -1 : a.entered > b.entered ? 1 : 0))[0];
  let risk = null, rBasis = /** @type {Trade['rBasis']} */ (null);
  if (first) {
    risk = Math.abs(trade.avgEntry - first.stopPrice) * trade.entryQty * trade.multiplier;
    rBasis = 'stop';
  } else if (trade.assetType === 'OPTION' && trade.direction === 'long') {
    risk = trade.avgEntry * trade.entryQty * trade.multiplier;
    rBasis = 'premium';
  }
  const r = risk && risk > EPS && trade.status !== 'open' ? Math.round((trade.pnl / risk) * 100) / 100 : null;
  return { ...trade, stop: first ? first.stopPrice : null, stopOrderId: first ? first.orderId : '', risk: risk ? Math.round(risk * 100) / 100 : null, rBasis, r };
}

// ---------- merged trades and spreads ----------

/** a stock's symbol, or an option's root. @param {{ symbol: string, assetType: string }} t */
const underlyingOf = t => t.assetType === 'OPTION' ? (parseSchwabOption(t.symbol)?.root || t.symbol) : t.symbol;
const round8 = (/** @type {number} */ v) => Math.round(v * 1e8) / 1e8;
const round2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
const gcd = (/** @type {number} */ a, /** @type {number} */ b) => { while (b) [a, b] = [b, a % b]; return a; };

/**
 * Why these trades can't be one, or '' when they can: same account and underlying, and either one symbol on one side
 * (a re-entry, a scale back in) or option contracts (a spread). Shares with options aren't supported yet.
 * @param {{ account: string, symbol: string, assetType: string, direction: string }[]} trades
 */
export function mergeProblem(trades) {
  if (trades.length < 2) return 'Pick two or more trades.';
  if (new Set(trades.map(t => t.account)).size > 1) return 'Those trades are in different accounts.';
  if (new Set(trades.map(underlyingOf)).size > 1) return 'Pick trades on the same symbol.';
  const options = trades.filter(t => t.assetType === 'OPTION').length;
  if (options && options < trades.length) return "Shares and options can't be one trade yet.";
  if (new Set(trades.map(t => t.symbol)).size === 1 && new Set(trades.map(t => t.direction)).size > 1) return 'Pick trades on the same side.';
  return '';
}

/**
 * Several contracts in a few words: 'AAPL 12/18/26 245/250C' for one expiry and type, 'AAPL 12/18/26 245P/250C' for
 * one expiry, otherwise each label.
 * @param {{ symbol: string, label: string }[]} parts
 */
export function comboLabel(parts) {
  const symbols = [...new Set(parts.map(p => p.symbol))];
  const opts = symbols.map(s => parseSchwabOption(s));
  const first = opts[0];
  if (!first || opts.some(o => !o || o.root !== first.root || o.exp !== first.exp)) return [...new Set(parts.map(p => p.label))].join(' / ');
  const legs = /** @type {NonNullable<typeof first>[]} */ (opts).sort((a, b) => a.strike - b.strike);
  const [y, mo, d] = first.exp.split('-');
  const oneType = legs.every(o => o.type === first.type);
  return `${first.root} ${+mo}/${+d}/${y.slice(2)} ${legs.map(o => `${o.strike}${oneType ? '' : o.type}`).join('/')}${oneType ? first.type : ''}`;
}

/** @param {Trade[]} parts */
const timeSpan = parts => {
  const closed = parts.every(p => p.status !== 'open');
  const closedAt = closed ? parts.map(p => /** @type {string} */ (p.closedAt)).sort().slice(-1)[0] : null;
  return { openedAt: parts[0].openedAt, closedAt, holdMs: closedAt ? Date.parse(closedAt) - Date.parse(parts[0].openedAt) : null };
};
/** @param {number} pnl @param {boolean} open @returns {Trade['status']} */
const statusOf = (pnl, open) => open ? 'open' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

/**
 * One symbol, one side: the parts' fills as one trade. Entry and exit are weighted by quantity, and the stop and R are
 * found again over the whole span (the first stop on the loss side of the combined entry).
 * @param {Trade[]} parts @param {Omit<Trade, keyof ReturnType<typeof timeSpan>>} base @param {StopOrder[]} stops
 * @returns {Trade}
 */
function mergedTrade(parts, base, stops) {
  const entryQty = parts.reduce((n, p) => n + p.entryQty, 0);
  const exited = parts.map(p => p.entryQty - p.openQty);
  const exitQty = exited.reduce((n, q) => n + q, 0);
  const span = timeSpan(parts);
  return withRisk({
    ...base, ...span, label: parts[0].label, symbol: parts[0].symbol, assetType: parts[0].assetType, multiplier: parts[0].multiplier,
    direction: parts[0].direction, entryQty, openQty: parts.reduce((n, p) => n + p.openQty, 0),
    avgEntry: round8(parts.reduce((n, p) => n + p.avgEntry * p.entryQty, 0) / entryQty),
    avgExit: exitQty > EPS ? round8(parts.reduce((n, p, i) => n + (p.avgExit || 0) * exited[i], 0) / exitQty) : null,
    status: statusOf(base.pnl, !span.closedAt), kind: 'merged', bias: parts[0].bias, net: null, structure: '',
  }, stops);
}

/**
 * Option contracts on one underlying as one position, counted in spreads (the greatest common size of its legs): paid
 * to open is a debit (long), received is a credit (short). Entry and exit are net per spread; risk is the debit, or for
 * a two-leg vertical credit spread its width less the credit (the calculator's defined risk).
 * @param {Trade[]} parts @param {Omit<Trade, keyof ReturnType<typeof timeSpan>>} base
 * @returns {Trade}
 */
function spreadTrade(parts, base) {
  const sign = (/** @type {Trade} */ p) => p.direction === 'long' ? 1 : -1;
  const openNet = parts.reduce((n, p) => n + sign(p) * p.avgEntry * p.entryQty * p.multiplier, 0);
  const exitNet = parts.reduce((n, p) => n + sign(p) * (p.avgExit || 0) * (p.entryQty - p.openQty) * p.multiplier, 0);
  /** @type {Map<string, { entry: number, open: number }>} */
  const legs = new Map();
  for (const p of parts) {
    const l = legs.get(p.symbol) || { entry: 0, open: 0 };
    l.entry += p.entryQty; l.open += p.openQty;
    legs.set(p.symbol, l);
  }
  const sizes = [...legs.values()].map(l => l.entry);
  const units = sizes.every(Number.isInteger) ? sizes.reduce(gcd) : Math.min(...sizes);
  const debit = openNet >= 0;
  const per = (/** @type {number} */ net) => round8((debit ? net : -net) / (units * 100));
  const span = timeSpan(parts);
  let risk = debit ? openNet : null;
  const opts = [...legs.keys()].map(s => parseSchwabOption(s));
  if (!debit && opts.length === 2 && opts[0] && opts[1] && opts[0].type === opts[1].type && opts[0].exp === opts[1].exp && sizes[0] === sizes[1]) {
    risk = Math.abs(opts[0].strike - opts[1].strike) * units * 100 + openNet;
  }
  risk = risk && risk > EPS ? round2(risk) : null;
  // the bet. One type, bought and sold: by strikes, puts and calls alike: bought below what's sold (size-weighted, so
  // puts sold again and again count together) is long, above is short, the same strike is a time spread (neutral). On a
  // vertical this is the debit / credit rule: call debit and put credit long, put debit and call credit short.
  // Otherwise (mixed types, or every leg bought) the legs' own biases add up: an iron condor is neutral.
  const strikeOf = (/** @type {Trade} */ p) => parseSchwabOption(p.symbol)?.strike || 0;
  const avgStrike = (/** @type {Trade[]} */ ps) => { const q = ps.reduce((n, p) => n + p.entryQty, 0); return q ? ps.reduce((n, p) => n + strikeOf(p) * p.entryQty, 0) / q : null; };
  const types = new Set(opts.map(o => o?.type)), exps = new Set(opts.map(o => o?.exp));
  const bought = avgStrike(parts.filter(p => p.direction === 'long')), sold = avgStrike(parts.filter(p => p.direction === 'short'));
  let structure = '', bias = /** @type {Trade['bias']} */ ('neutral');
  if (types.size === 1 && bought !== null && sold !== null) {
    const type = opts[0]?.type === 'C' ? 'call' : 'put';
    bias = Math.abs(bought - sold) < EPS ? 'neutral' : bought < sold ? 'long' : 'short';
    structure = exps.size === 1 ? `${type} ${debit ? 'debit' : 'credit'}` : new Set(opts.map(o => o?.strike)).size === 1 ? 'time spread' : `${type} diagonal`;
  } else {
    const lean = parts.reduce((n, p) => n + (p.bias === 'long' ? 1 : -1) * p.entryQty, 0);
    bias = lean > EPS ? 'long' : lean < -EPS ? 'short' : 'neutral';
  }
  return {
    ...base, ...span, label: comboLabel(parts), symbol: underlyingOf(parts[0]), assetType: 'OPTION', multiplier: 100,
    direction: /** @type {Trade['direction']} */ (debit ? 'long' : 'short'), entryQty: units,
    openQty: span.closedAt ? 0 : units * Math.max(...[...legs.values()].map(l => l.open / l.entry)),
    avgEntry: per(openNet), avgExit: parts.some(p => p.exits) ? per(exitNet) : null,
    status: statusOf(base.pnl, !span.closedAt), kind: 'spread', bias, net: debit ? 'debit' : 'credit', structure,
    risk, rBasis: /** @type {Trade['rBasis']} */ (risk ? 'spread' : null), r: risk && span.closedAt ? round2(base.pnl / risk) : null,
  };
}

/**
 * Saved merges applied to the trades: a saved row claims every trade holding one of its fills (so a merge that took in
 * an open trade keeps the fills that land later), rows that share a trade make one trade, and the oldest row names
 * it. A row left with one trade, or whose trades can't be one (mergeProblem), changes nothing. Separate = delete
 * every row in savedIds.
 * @param {Trade[]} trades @param {SavedTrade[]} rows @param {StopOrder[]} [stops]
 * @returns {Trade[]}
 */
export function applyMerges(trades, rows, stops = []) {
  /** @type {Map<string, number>} */
  const byFill = new Map();
  trades.forEach((t, i) => t.fillIds.forEach(id => byFill.set(`${t.account}|${id}`, i)));
  const parent = trades.map((_, i) => i);
  const find = (/** @type {number} */ i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const touched = rows.map(r => [...new Set((r.fill_ids || []).map(id => byFill.get(`${r.account}|${id}`)).filter(i => i !== undefined))]);
  touched.forEach(list => list.slice(1).forEach(i => { parent[find(/** @type {number} */ (i))] = find(/** @type {number} */ (list[0])); }));
  /** @type {Map<number, { parts: Trade[], rows: SavedTrade[] }>} */
  const groups = new Map();
  trades.forEach((t, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { parts: [], rows: [] });
    /** @type {{ parts: Trade[] }} */ (groups.get(root)).parts.push(t);
  });
  rows.forEach((r, k) => { if (touched[k].length) /** @type {{ rows: SavedTrade[] }} */ (groups.get(find(/** @type {number} */ (touched[k][0])))).rows.push(r); });
  /** @type {Trade[]} */
  const out = [];
  for (const { parts, rows: saved } of groups.values()) {
    if (parts.length < 2 || mergeProblem(parts)) { out.push(...parts); continue; }
    parts.sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0));
    saved.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const id = saved[0].id;
    const pnl = round2(parts.reduce((n, p) => n + p.pnl, 0));
    const base = {
      key: `trade:${id}`, account: parts[0].account, pnl, exits: parts.reduce((n, p) => n + p.exits, 0),
      fillIds: parts.flatMap(p => p.fillIds), orderId: parts[0].orderId, id, savedIds: saved.map(r => r.id), parts: parts.map(p => p.key),
      stop: null, stopOrderId: '', risk: null, rBasis: null, r: null,
    };
    const oneSymbol = new Set(parts.map(p => p.symbol)).size === 1;
    out.push(oneSymbol ? mergedTrade(parts, /** @type {any} */ (base), stops) : spreadTrade(parts, /** @type {any} */ (base)));
  }
  return out;
}

/**
 * Legs that went in as one Schwab order (a spread order fills each contract under one order id) and aren't one trade
 * yet: each a suggestion to merge them.
 * @param {Trade[]} trades
 * @returns {{ keys: string[], label: string }[]}
 */
export function spreadSuggestions(trades) {
  /** @type {Map<string, Trade[]>} */
  const byOrder = new Map();
  for (const t of trades) {
    if (t.kind !== 'single' || !t.orderId) continue;
    const k = `${t.account}|${t.orderId}`;
    if (!byOrder.has(k)) byOrder.set(k, []);
    /** @type {Trade[]} */ (byOrder.get(k)).push(t);
  }
  return [...byOrder.values()]
    .filter(list => new Set(list.map(t => t.symbol)).size > 1 && !mergeProblem(list))
    .map(list => ({ keys: list.map(t => t.key).sort(), label: comboLabel(list) }));
}

/**
 * The journal's trades from its kept records: fills grouped, each given its stop and R, your saved merges applied,
 * newest first (by when it closed, or opened if it's still open).
 * @param {Fill[]} fills @param {{ kind: string, account?: string, data: any }[]} records @param {SavedTrade[]} [saved]
 */
export function journalTrades(fills, records, saved = []) {
  const stops = stopOrdersFrom(records);
  return applyMerges(buildTrades(fills).map(t => withRisk(t, stops)), saved, stops)
    .sort((a, b) => { const ka = a.closedAt || a.openedAt, kb = b.closedAt || b.openedAt; return ka < kb ? 1 : ka > kb ? -1 : 0; });
}

/** closed trades in numbers: count, wins, losses, win rate, P&L, average R (over trades that have one). @param {Trade[]} trades */
export function tradesSummary(trades) {
  const closed = trades.filter(t => t.status !== 'open');
  const wins = closed.filter(t => t.status === 'win').length;
  const losses = closed.filter(t => t.status === 'loss').length;
  const rs = closed.map(t => t.r).filter(r => r !== null);
  return {
    closed: closed.length, open: trades.length - closed.length, wins, losses,
    winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : null,
    pnl: Math.round(closed.reduce((n, t) => n + t.pnl, 0) * 100) / 100,
    avgR: rs.length ? Math.round((rs.reduce((n, r) => n + /** @type {number} */ (r), 0) / rs.length) * 100) / 100 : null,
    withR: rs.length,
  };
}

/** '45m', '3h 10m', '2d 4h'. @param {number | null} ms */
export function holdWords(ms) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (ms < DAY) return `${Math.floor(m / 60)}h ${m % 60}m`;
  const d = Math.floor(ms / DAY);
  return `${d}d ${Math.floor((ms - d * DAY) / 3600000)}h`;
}


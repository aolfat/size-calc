// @ts-check
// Order plans, pure (docs/schwab.md, docs/journal.md): what the Trade at Schwab sheet saves with an order (the setups and
// entry tactics picked, the risk against the Schwab account's value, how the stop was set), matched to the journal trade
// its fills open, the labels it puts on that trade, and the plan in words.
import { fmt$, nyDateStr } from './format.js';

/**
 * @typedef {{ at: string, order_id: string, qty: number | null }} PlanEdit
 * @typedef {{ qty: number | null, entry_type: string | null, entry: number | null, stop: number | null, planned_risk: number | null,
 *   fill_risk: number | null, max_loss: number | null, account_size: number | null, account_source: string | null, risk_pct: number | null,
 *   schwab_value: number | null, schwab_value_at: string | null, stop_source: string | null, stop_strategy: string | null,
 *   stop_amount: number | null, stop_level: number | null, stop_level_name: string | null, ext_hours: boolean, atr5: number | null,
 *   stop_planned: number | null, orb_minutes: number | null, edits: PlanEdit[] }} PlanNumbers
 * @typedef {{ id: string, account: string, symbol: string, side: 'long' | 'short', order_ids: string[], sent_at: string,
 *   setups: string[], tactics: string[], plan: PlanNumbers, trade_key: string | null }} OrderPlan
 * @typedef {{ key: string, account: string, symbol: string, direction: string, status: string, openedAt: string,
 *   entryOrderIds: string[], deleted?: boolean, risk?: number | null }} PlanTrade
 */

/** the most setups or tactics one order keeps, and the most order ids (each Change limit adds one) */
export const MAX_PLAN_PICKS = 10;
export const MAX_PLAN_ORDERS = 50;
/** a market entry whose answer was lost fills at once if it went through at all; a limit or stop entry may wait the day */
export const NO_ID_MARKET_MS = 30 * 60000;
/** a trade opened this long before the send still counts: the device's clock and Schwab's can disagree */
const CLOCK_SLACK_MS = 60000;

const ENTRY_TYPES = ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'];
const STOP_SOURCES = ['auto', 'custom', 'orb'];
const STOP_STRATEGIES = ['none', 'atr', 'percent'];

const num = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const oneOf = (/** @type {string[]} */ list, /** @type {unknown} */ v) => typeof v === 'string' && list.includes(v) ? v : null;
const when = (/** @type {unknown} */ v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
/** distinct non-empty texts, at most max; ids may come back as numbers (orNumber) */
function texts(/** @type {unknown} */ list, /** @type {number} */ max, /** @type {number} */ len, orNumber = false) {
  /** @type {string[]} */
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = orNumber && typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (s && s.length <= len && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** @param {any} p @returns {PlanNumbers} */
function cleanNumbers(p) {
  const o = p && typeof p === 'object' ? p : {};
  return {
    qty: num(o.qty), entry_type: oneOf(ENTRY_TYPES, o.entry_type), entry: num(o.entry), stop: num(o.stop),
    planned_risk: num(o.planned_risk), fill_risk: num(o.fill_risk), max_loss: num(o.max_loss),
    account_size: num(o.account_size), account_source: oneOf(['schwab', 'typed'], o.account_source), risk_pct: num(o.risk_pct),
    schwab_value: num(o.schwab_value), schwab_value_at: when(o.schwab_value_at),
    stop_source: oneOf(STOP_SOURCES, o.stop_source), stop_strategy: oneOf(STOP_STRATEGIES, o.stop_strategy), stop_amount: num(o.stop_amount),
    stop_level: num(o.stop_level), stop_level_name: oneOf(['LOD', 'HOD'], o.stop_level_name), ext_hours: o.ext_hours === true,
    atr5: num(o.atr5), stop_planned: num(o.stop_planned), orb_minutes: num(o.orb_minutes),
    edits: (Array.isArray(o.edits) ? o.edits : []).slice(0, 20).map((/** @type {any} */ e) => ({ at: when(e?.at) || '', order_id: texts([e?.order_id], 1, 40, true)[0] || '', qty: num(e?.qty) })),
  };
}

/** a saved row as the app uses it, or null when it can't be one @param {any} r @returns {OrderPlan | null} */
export function cleanPlanRow(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return null;
  const account = typeof r.account === 'string' && /^[0-9]{1,4}$/.test(r.account) ? r.account : '';
  const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
  const side = r.side === 'long' || r.side === 'short' ? r.side : null;
  const sent = when(r.sent_at);
  if (!account || !symbol || !side || !sent) return null;
  return {
    id: r.id, account, symbol, side, order_ids: texts(r.order_ids, MAX_PLAN_ORDERS, 40, true), sent_at: sent,
    setups: texts(r.setups, MAX_PLAN_PICKS, 120), tactics: texts(r.tactics, MAX_PLAN_PICKS, 120),
    plan: cleanNumbers(r.plan), trade_key: typeof r.trade_key === 'string' && r.trade_key ? r.trade_key : null,
  };
}

const bySent = (/** @type {OrderPlan} */ a, /** @type {OrderPlan} */ b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : 0);

/** a trade opened after a lost answer's send: within 30 minutes for a market entry, that New York day for one that can wait */
function afterSend(/** @type {PlanTrade} */ t, /** @type {OrderPlan} */ p) {
  const sent = Date.parse(p.sent_at), opened = Date.parse(t.openedAt);
  if (!(opened >= sent - CLOCK_SLACK_MS)) return false;
  return p.plan.entry_type === 'MARKET' ? opened - sent <= NO_ID_MARKET_MS : nyDateStr(new Date(opened)) === nyDateStr(new Date(sent));
}

/**
 * Each trade's plans, oldest first, in the trades' order. A plan goes with the trades its orders opened (any id it has had:
 * Change limit adds the new one), on its account and side, so a reversal's plan goes with the side it was sent for. A plan
 * Schwab gave no id keeps the trade it was given once (trade_key); before that it takes the first trade on its account,
 * symbol and side opened after the send (afterSend) that no other plan has, earliest plan first.
 * @param {PlanTrade[]} trades @param {OrderPlan[]} plans @returns {Map<string, OrderPlan[]>}
 */
export function matchPlans(trades, plans) {
  const live = trades.filter(t => t.status !== 'history' && !t.deleted);
  /** @type {Map<string, OrderPlan[]>} */
  const found = new Map();
  const add = (/** @type {PlanTrade} */ t, /** @type {OrderPlan} */ p) => { const list = found.get(t.key) || []; if (!list.includes(p)) list.push(p); found.set(t.key, list); };
  const fits = (/** @type {PlanTrade} */ t, /** @type {OrderPlan} */ p) => t.account === p.account && t.direction === p.side;
  const sorted = [...plans].sort(bySent);
  for (const p of sorted) {
    if (p.order_ids.length) for (const t of live) if (fits(t, p) && (t.entryOrderIds || []).some(id => p.order_ids.includes(String(id)))) add(t, p);
  }
  const lost = sorted.filter(p => !p.order_ids.length);
  for (const p of lost) { const t = p.trade_key ? live.find(x => x.key === p.trade_key) : null; if (t) add(t, p); }
  const taken = new Set(found.keys());
  for (const p of lost) {
    if (p.trade_key) continue;
    const t = live.filter(x => !taken.has(x.key) && fits(x, p) && x.symbol === p.symbol && afterSend(x, p))
      .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0))[0];
    if (t) { add(t, p); taken.add(t.key); }
  }
  return new Map(live.filter(t => found.has(t.key)).map(t => [t.key, /** @type {OrderPlan[]} */ (found.get(t.key)).sort(bySent)]));
}

/**
 * The labels a trade's plans put on it: the setups and the tactics of the first plan that has any, for a kind the trade has
 * none of yet (yours win). @param {OrderPlan[]} plans @param {{ kind: string, value: string }[]} labels @returns {[string, string][]}
 */
export function planLabels(plans, labels) {
  /** @type {[string, string][]} */
  const out = [];
  for (const [kind, field] of /** @type {[string, 'setups' | 'tactics'][]} */ ([['setup', 'setups'], ['tactic', 'tactics']])) {
    if (labels.some(l => l.kind === kind)) continue;
    const from = plans.find(p => p[field].length);
    if (from) for (const v of from[field]) out.push([kind, v]);
  }
  return out;
}

/** the planned risk as a percent of the Schwab account's value when the order went (pct null without one) @param {OrderPlan} p */
export function planRisk(p) {
  const risk = p.plan.planned_risk, value = p.plan.schwab_value;
  return { risk, value, pct: risk !== null && value !== null && value > 0 ? risk / value * 100 : null };
}

const pct = (/** @type {number} */ v) => `${v.toFixed(2)}%`;
const wholeDollars = (/** @type {number} */ v) => '$' + Math.round(v).toLocaleString('en-US');

/** how the stop was set: 'LOD − 0.5× ATR(5m)', 'HOD + 0.1%', 'Custom stop', '15m range low' @param {OrderPlan} p */
export function stopWords(p) {
  const n = p.plan, long = p.side === 'long';
  if (n.stop_source === 'orb') return `${n.orb_minutes ?? '?'}m range ${long ? 'low' : 'high'}`;
  if (n.stop_source === 'custom') return 'Custom stop';
  const level = n.stop_level_name || (long ? 'LOD' : 'HOD');
  if (n.stop_strategy === 'atr') return `${level} ${long ? '−' : '+'} ${n.stop_amount ?? '?'}× ATR(5m)`;
  if (n.stop_strategy === 'percent') return `${level} ${long ? '−' : '+'} ${n.stop_amount ?? '?'}%`;
  return level;
}

/** one order's plan: '0.48% of Schwab ••6789 ($250.00 of $52,100) · 100 sh · stop LOD − 0.5× ATR(5m) at $97.50 (LOD $97.71, ATR(5m) $0.42)' @param {OrderPlan} p */
function planLine(p) {
  const n = p.plan, r = planRisk(p);
  const risk = r.pct !== null && r.value !== null && r.risk !== null ? `${pct(r.pct)} of Schwab ••${p.account} (${fmt$(r.risk)} of ${wholeDollars(r.value)})`
    : `${r.risk !== null ? fmt$(r.risk) : '?'} planned, no Schwab account value`;
  const level = n.stop_level !== null && n.stop_level !== n.stop ? `${n.stop_level_name || (p.side === 'long' ? 'LOD' : 'HOD')} ${fmt$(n.stop_level)}` : '';
  const details = [level, n.ext_hours ? 'ext hours' : '', n.atr5 !== null ? `ATR(5m) ${fmt$(n.atr5)}` : ''].filter(Boolean);
  const stop = `stop ${stopWords(p)}${n.stop !== null ? ` at ${fmt$(n.stop)}` : ''}${details.length ? ` (${details.join(', ')})` : ''}`;
  const edited = n.edits.length && n.edits[n.edits.length - 1].qty !== null ? ` · edited to ${n.edits[n.edits.length - 1].qty} sh` : '';
  return `${risk}${n.qty !== null ? ` · ${n.qty} sh` : ''} · ${stop}${edited}`;
}

/**
 * A trade's plans in words, one line per order (adds say so), then the actual risk against the first plan's Schwab value
 * (with the planned total when there's more than one order). @param {OrderPlan[]} plans @param {PlanTrade} t @returns {string[]}
 */
export function planLines(plans, t) {
  const lines = plans.map((p, i) => (i ? 'Add: ' : '') + planLine(p));
  const value = plans.map(p => p.plan.schwab_value).find(v => v !== null && v > 0) ?? null;
  const actual = value !== null && t.risk !== null && t.risk !== undefined && t.risk > 0 ? `actual risk ${pct(t.risk / value * 100)} (${fmt$(t.risk)})` : '';
  if (plans.length > 1) {
    const total = plans.reduce((s, p) => s + (p.plan.planned_risk || 0), 0);
    lines.push([value !== null ? `Planned ${pct(total / value * 100)} (${fmt$(total)})` : `Planned ${fmt$(total)}`, actual].filter(Boolean).join(' · '));
  } else if (actual) lines.push(actual.replace(/^a/, 'A'));
  return lines;
}

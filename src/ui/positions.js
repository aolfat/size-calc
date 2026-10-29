// Positions: the selected Schwab account's holdings, read live every 30s while the tab is open, with stops from its working stop orders,
// option legs folded into the spreads they make (each spread's legs a tap away, the spread closed or trimmed as one order in spread-close.js),
// buttons into a position's chart and targets (position-chart.js), an option's return simulator (position-sim.js) and the stop, breakeven-stop and close reviews (position-trade.js),
// optional P/L and R columns picked from Columns (kept on this device; R reads the Journal's trades for each position's first stop), the account value hidden on request,
// a card per position on phones (P/L, R and a bar from the stop past your cost to the price; a tap opens its figures and buttons),
// and every order still working in the account.
import { mq, PHONE_MQ } from '../lib/media.js';
import { store } from '../lib/store.js';
import { inZone } from '../lib/zone.js';
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillsFrom } from '../core/journal-records.js';
import { originalSize } from '../core/journal.js';
import { INSTRUCTION_WORDS, atBreakeven, editable, fmtPositionPrice, orderTypeWord, positionR, positionRows, rUnit, schwabTime, spreadR, workingOrders, workingPrice } from '../core/positions.js';
import { loadSavedRecords, loadSavedTrades, loadTradeReviews } from '../services/journal.js';
import { schwabAccount, schwabConnected, schwabPositions, schwabRecentOrders } from '../services/schwab.js';
import { applyAccountValue } from './account-size.js';
import { showToast } from './feedback.js';
import { journalTradeList } from './journal.js';
import { onCaptureChange } from './schwab-capture.js';
import { renderPositionChart } from './position-chart.js';

const POLL_MS = 30000;
const money = v => (v < 0 ? '−' : '') + fmt$(Math.abs(v));
const count = q => (q < 0 ? '−' : '') + Math.abs(q).toLocaleString('en-US');
const words = s => String(s || '').toLowerCase().replace(/_/g, ' ');
const DURATION_WORDS = { DAY: 'Today', GOOD_TILL_CANCEL: 'Until canceled', FILL_OR_KILL: 'Fill or kill', IMMEDIATE_OR_CANCEL: 'Immediate or cancel' };
const STATUS_WORDS = { AWAITING_PARENT_ORDER: 'waiting on entry', PENDING_ACTIVATION: 'pending', AWAITING_RELEASE_TIME: 'waiting on release' };
const signed = (v, text) => `<span class="${v >= 0 ? 'pos-locked' : 'pos-loss'}">${v >= 0 ? '+' : '−'}${text}</span>`;
const pnlCell = v => v === null ? '—' : signed(v, fmt$(Math.abs(v)));
const pctCell = v => v === null ? '—' : signed(v, Math.abs(v).toFixed(2) + '%');
const rWords = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;
// the optional columns, in table order after Market value: [key, header, row or totals → cell]
const EXTRA_COLS = [
  ['pnl', 'P/L', r => pnlCell(r.pnl)],
  ['pnlPct', 'P/L %', r => pctCell(r.pnlPct)],
  ['r', 'R', r => 'legs' in r ? spreadRCell(r) : 'symbol' in r ? rCell(r) : ''],
  ['day', 'Today', r => pnlCell(r.day)],
  ['dayPct', 'Today %', r => pctCell(r.dayPct)],
];
const shownCols = () => EXTRA_COLS.filter(([key]) => state.posCols.includes(key));

/** the Columns button: shows or hides the column picker */
export function togglePosColumnsMenu() {
  state.posColsOpen = !state.posColsOpen;
  renderPositionsTable();
}

/** a column chip: adds or drops that column */
export function togglePosColumn(key) {
  if (!EXTRA_COLS.some(([k]) => k === key)) return;
  const on = state.posCols.includes(key);
  state.posCols = EXTRA_COLS.map(([k]) => k).filter(k => k === key ? !on : state.posCols.includes(k));
  store.set('positions_cols', JSON.stringify(state.posCols));
  readPositionJournal();
  renderPositionsTable();
}

// ---------- the R column: open P/L over the Journal trade's first risk ----------

/** the Journal's trades for the R column: read once when the column is on and you're signed in (the Journal tab reads them too) */
function positionTrades() {
  if (!state.journalRecords) return null;
  // built again only when the records, your stops, your merges or the fee choice change, not on every 30s read
  const memo = state.posRTrades, fees = store.get('journal_fees');
  if (memo && memo.records === state.journalRecords && memo.reviews === state.tradeReviews && memo.saved === state.journalSaved && memo.fees === fees) return memo.trades;
  const trades = journalTradeList();
  state.posRTrades = { records: state.journalRecords, reviews: state.tradeReviews, saved: state.journalSaved, fees, trades };
  return trades;
}

const rShown = () => state.posCols.includes('r');

/** 1R in a position's own price for the chart's targets, counted like the R column (the Journal trade's first stop when it's read) */
export function positionRUnit(row) {
  return rUnit(row, positionTrades(), state.positions?.last4 || '');
}

/** what 1R counts from, in a few words: 'the first stop $35.50', 'the stop $35.50', 'the premium' */
export function rUnitWords(unit, row) {
  const px = v => fmtPositionPrice(v, row.tradeAs);
  if (unit.basis === 'premium') return 'the premium';
  if (unit.source === 'journal') return unit.basis === 'stop' ? `the first stop ${px(unit.stop)}` : 'your Journal risk';
  return `the stop ${px(unit.stop)}`;
}

/** the records, your stops and merges, when the R column (or the phone cards' R), an open chart's targets or a close's original size need them and nothing has read them yet */
function readPositionJournal(force = false, need = false) {
  if (!(rShown() || state.posChart || need || mq(PHONE_MQ)) || !state.session || state.journalLoading) return;
  if (state.posJournalBusy) return state.posJournalBusy;
  if (!force && (state.journalRecords || state.posJournalError)) return;
  state.posJournalBusy = Promise.allSettled([loadSavedRecords(), loadTradeReviews(), loadSavedTrades()]).then(([records, reviews, saved]) => {
    if (records.status === 'fulfilled') { state.journalRecords = records.value; state.posJournalError = ''; }
    else state.posJournalError = String(records.reason?.message || records.reason);
    if (reviews.status === 'fulfilled') { state.tradeReviews = reviews.value; state.tradeReviewsError = ''; }
    if (saved.status === 'fulfilled') { state.journalSaved = saved.value; state.journalSavedError = ''; }
  }).finally(() => {
    state.posJournalBusy = false;
    if (state.positionsView) { renderPositionsTable(); renderPositionChart(); }
  });
  return state.posJournalBusy;
}

/** a close ticket waits for the Journal's records (signed in, not read yet), so its percents of the original start right */
export async function readPositionJournalForClose() { await readPositionJournal(false, true); }

/** every fill the kept records and this read's orders hold: an order in both is taken from the read, the newer of the two */
function positionFills() {
  const p = state.positions, records = state.journalRecords || [];
  const memo = state.posFills;
  if (memo && memo.records === records && memo.orders === p.orders) return memo.fills;
  const live = new Set(p.orders.map(o => String(o?.orderId ?? '')));
  const fills = fillsFrom([
    ...records.filter(r => !(r.kind === 'order' && live.has(String(r.record_id)))),
    ...p.orders.map(o => ({ kind: 'order', record_id: String(o?.orderId ?? ''), account: p.last4, data: o })),
  ]);
  state.posFills = { records, orders: p.orders, fills };
  return fills;
}

/**
 * A position's original size for the close ticket's percents: the most it held at once since it was last flat (originalSize),
 * from the Journal's kept records when signed in and the orders this read got. qty null with why when the fills don't add up
 * to what Schwab holds.
 * @returns {{ qty: number | null, why: string }}
 */
export function positionOriginal(row, now = Date.now()) {
  const p = state.positions;
  if (!p || !row) return { qty: null, why: '' };
  const o = originalSize(positionFills(), { account: p.last4, symbol: row.symbol, qty: row.qty }, now);
  if (o.qty !== null) return { qty: o.qty, why: '' };
  const where = !state.session ? "Schwab's last 59 days of orders (sign in for the Journal's older ones)"
    : state.posJournalError || !state.journalRecords ? "Schwab's last 59 days of orders (the Journal didn't load)"
    : "the Journal and Schwab's orders";
  const unit = row.tradeAs === 'OPTION' ? 'contracts' : 'shares';
  return { qty: null, why: o.found ? `The fills in ${where} leave ${o.found.toLocaleString('en-US')} ${unit} open, not the ${Math.abs(row.qty).toLocaleString('en-US')} held.` : `No fills in ${where} open this position.` };
}

// an import landed while Positions is open: its trades (a trim, a scale-in) change what R counts from
onCaptureChange(saved => { if (saved && state.positionsView && !state.journalView) readPositionJournal(true); });

function rCell(row) {
  if (state.session && !state.journalRecords && (state.posJournalBusy || state.journalLoading)) return '<span class="pos-sub">…</span>';
  const p = positionR(row, positionTrades(), state.positions?.last4 || '');
  if (p.r === null) return `<span title="${esc(p.why)}">—</span>`;
  const px = v => fmtPositionPrice(v, row.tradeAs);
  const from = p.source === 'journal'
    ? (p.basis === 'premium' ? 'premium' : p.basis === 'stop' ? `first stop ${px(p.stop)}` : 'journal risk')
    : p.source === 'premium' ? 'premium' : `stop now ${px(p.stop)}`;
  const behind = p.journalQty !== null ? ` The Journal shows ${p.journalQty.toLocaleString('en-US')} open, Schwab ${Math.abs(row.qty).toLocaleString('en-US')}: import to catch up.` : '';
  const title = p.source === 'journal'
    ? `Open P/L over the trade's risk at entry, ${fmt$(p.risk)} (${p.basis === 'premium' ? 'the premium paid' : `stop ${px(p.stop)}`}), from your Journal.`
    : `Open P/L over the risk to ${p.source === 'premium' ? 'zero (the premium)' : `the nearest stop now, ${px(p.stop)}`}, ${fmt$(p.risk)}. ${state.session ? 'Not matched to an open Journal trade.' : 'Sign in to count from the Journal trade\'s first stop.'}${behind}`;
  const trims = p.withTrims !== null ? `<span class="pos-sub">${rWords(p.withTrims)} with trims</span>` : '';
  return `<span title="${esc(title)}">${signed(p.r, Math.abs(p.r).toFixed(2) + 'R')}<span class="pos-sub">${esc(from)}</span>${trims}</span>`;
}

function spreadRCell(s) {
  const { r, why } = spreadR(s);
  if (r === null) return `<span title="${esc(why)}">—</span>`;
  const basis = s.riskBasis === 'width' ? 'width less credit' : 'debit paid';
  return `<span title="${esc(`Open P/L over the spread's max loss, ${fmt$(s.maxLoss)} (the ${basis}).`)}">${signed(r, Math.abs(r).toFixed(2) + 'R')}<span class="pos-sub">${basis}</span></span>`;
}

/** a spread's Legs button: shows or hides its legs under it */
export function togglePosLegs(key) {
  const open = state.posLegsOpen.includes(key);
  state.posLegsOpen = open ? state.posLegsOpen.filter(k => k !== key) : [...state.posLegsOpen, key];
  renderPositionsTable();
}

/** Hide / Show beside the account value */
export function togglePosHideValue() {
  state.posHideValue = !state.posHideValue;
  store.set('positions_hide_value', state.posHideValue ? '1' : '0');
  renderPositionsTable();
}

/**
 * read the account now; asked = a tap on Refresh (or r), which confirms when it lands; the 30s timer stays quiet.
 * Resolves once the newest read is in: a read overtaken by a later one waits for that one, so whoever awaits this
 * (a review about to plan or send) sees state.positions as Schwab shows it now. positionsBusy holds the read in flight.
 */
export function refreshPositions(asked = false) {
  stopPositions();
  if (asked) state.posJournalError = ''; // a tap on Refresh tries the Journal's read again too
  const id = ++state.positionsRequest;
  const acct = schwabConnected() ? schwabAccount() : null;
  if (!acct) { state.positions = null; state.positionsBusy = false; renderPositions(); return Promise.resolve(); }
  const read = readPositions(id, acct, asked);
  state.positionsBusy = read;
  renderPositions();
  return read;
}

// the read that overtook this one, while it is still out; once it is done, state.positions is already its answer
const newest = () => state.positionsBusy || undefined;

async function readPositions(id, acct, asked) {
  try {
    // stops are extra: positions still show when the orders read fails
    const [account, orders] = await Promise.all([schwabPositions(acct.hash), schwabRecentOrders(Date.now(), acct.hash).catch(() => null)]);
    if (id !== state.positionsRequest) return newest();
    state.positions = { ...positionRows(account, orders || []), orders: orders || [], hash: acct.hash, last4: acct.last4, asOf: Date.now(), stopsMissing: !orders };
    state.positionsError = '';
    applyAccountValue(account, acct.hash); // the first read of the day sets the account size
    if (asked) showToast(`Positions refreshed at ${inZone(state.positions.asOf)}.`);
  } catch(e) {
    if (id !== state.positionsRequest) return newest();
    state.positionsError = e instanceof TypeError ? 'Could not reach the Schwab worker. Check its URL in Settings.' : e.message;
    if (!schwabConnected()) state.positions = null; // the login ended
  } finally {
    if (id === state.positionsRequest) { state.positionsBusy = false; renderPositions(); schedulePositions(); }
  }
}

export function schedulePositions() {
  stopPositions();
  if (state.positionsView && !document.hidden && schwabConnected()) state.positionsTimer = setTimeout(() => refreshPositions(), POLL_MS);
}

export function stopPositions() {
  clearTimeout(state.positionsTimer);
  state.positionsTimer = null;
}

export function positionsVisibilityChanged() {
  if (state.positionsView && !document.hidden) refreshPositions(); else stopPositions();
}

/** a login, logout or account switch: the old account's table goes, and the tab reloads if it's open */
export function positionsAccountChanged() {
  state.positions = null;
  state.posChart = null;
  state.positionsError = '';
  if (state.positionsView) { refreshPositions(); return; }
  state.positionsRequest++;
  state.positionsBusy = false;
  renderPositions();
}

function riskCell(r) {
  if (r.risk === null) return '—';
  const held = Math.abs(r.qty);
  const partial = r.covered < held ? `<span class="pos-sub pos-partial">covers ${r.covered.toLocaleString('en-US')} of ${held.toLocaleString('en-US')}</span>` : '';
  if (Math.abs(r.risk) < 0.005) return `<span class="pos-locked">$0.00</span><span class="pos-sub">at breakeven</span>${partial}`;
  return r.risk > 0
    ? `<span class="pos-loss">−${fmt$(r.risk)}</span><span class="pos-sub">${r.riskPct.toFixed(2)}% of acct</span>${partial}`
    : `<span class="pos-locked">+${fmt$(-r.risk)} locked</span>${partial}`;
}

// Chart (and Simulate for options), Stop, BE stop and Close sit under the symbol, in the pinned column, so phones see them without scrolling
function tradeButtons(r) {
  if (!r.tradeAs) return '';
  // every share already has a stop at or past breakeven: nothing to move, and moving it would loosen it
  const atBe = atBreakeven(r) ? (r.stopOrders.every(s => s.stop === r.be) ? 'stop at breakeven' : `stop${r.stops > 1 ? 's' : ''} past breakeven`) : '';
  const arg = esc(r.symbol);
  const charted = !!state.posChart && state.posChart.symbol === r.symbol;
  const chart = `<button class="pos-act${charted ? ' active' : ''}" aria-pressed="${charted}" data-action="togglePositionChart" data-arg="${arg}" title="${r.tradeAs === 'OPTION' ? 'The contract\'s 5-minute chart' : 'Daily chart'} with your cost, stops and targets: set a profit target on it">Chart</button>`
    + (r.option ? `<button class="pos-act" data-action="simPosition" data-arg="${arg}" title="Simulate returns over time from your average cost (Black-Scholes)">Simulate</button>` : '');
  const stop = `<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="stop" title="Set a stop at a price you pick">Stop</button>`;
  return `<span class="pos-acts many">${chart}${stop}${atBe ? `<span class="pos-locked">${atBe}</span>` :`<button class="pos-act" data-action="openPositionTrade" data-arg="${arg}" data-arg2="breakeven" title="Move the stop to your average cost">BE stop</button>`}<button class="pos-act pos-act-close" data-action="openPositionTrade" data-arg="${arg}" data-arg2="close" title="Close all or part, at market or a limit">Close</button></span>`;
}

function positionRow(r, leg = false) {
  return `<tr${leg ? ' class="pos-leg"' : ''}>
    <td><b>${esc(r.label)}</b>${tradeButtons(r)}</td>
    <td>${count(r.qty)}</td>
    <td>${r.avg > 0 ? fmt$(r.avg) : '—'}</td>
    <td>${fmt$(r.price)}</td>
    <td>${money(r.value)}</td>
    ${shownCols().map(([, , cell]) => `<td>${cell(r)}</td>`).join('')}
    <td>${r.pctAcct.toFixed(2)}%</td>
    <td>${r.stop === null ? '—' : fmt$(r.stop) + (r.stops > 1 ? `<span class="pos-sub">+${r.stops - 1} more</span>` : '')}</td>
    <td>${riskCell(r)}</td>
  </tr>`;
}

/** a spread as one position: net cost and mark per spread, P/L added up, its max loss where the stop risk goes */
function spreadButtons(s) {
  const open = state.posLegsOpen.includes(s.key);
  return `<button class="pos-act${open ? ' active' : ''}" data-action="togglePosLegs" data-arg="${esc(s.key)}" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} the legs, each with its own chart, simulator and orders">Legs</button>`
    + `<button class="pos-act pos-act-close" data-action="openSpreadClose" data-arg="${esc(s.key)}" title="Close all or part of the spread as one order, at a net limit or market">Close</button>`;
}

function spreadRow(s) {
  const open = state.posLegsOpen.includes(s.key);
  const how = s.by === 'order' ? 'Opened together in one order.' : 'The only bought and sold contracts on this underlying, so they read as one spread.';
  const legs = spreadButtons(s);
  const risk = s.maxLoss === null ? '—' : `<span class="pos-loss">−${fmt$(s.maxLoss)}</span><span class="pos-sub">max loss · ${s.maxLossPct.toFixed(2)}% of acct</span>`;
  return `<tr class="pos-spread">
    <td><b>${esc(s.label)}</b><span class="journal-tag journal-tag-quiet" title="${esc(how)}">${esc(s.structure)}</span><span class="pos-sub">${esc(s.legWords)}</span><span class="pos-acts">${legs}</span></td>
    <td>${count(s.qty)}</td>
    <td>${s.avg > 0 ? fmt$(s.avg) : '—'}<span class="pos-sub">${s.kind}</span></td>
    <td>${fmt$(s.price)}</td>
    <td>${money(s.value)}</td>
    ${shownCols().map(([, , cell]) => `<td>${cell(s)}</td>`).join('')}
    <td>${s.pctAcct.toFixed(2)}%</td>
    <td>—</td>
    <td>${risk}</td>
  </tr>${open ? s.legs.map(l => positionRow(l, true)).join('') : ''}`;
}

/** the table's rows: each spread once, where its first leg sits, and every other position on its own */
function tableRows(p) {
  const spreads = p.spreads || [];
  const bySymbol = new Map(spreads.flatMap(s => s.legs.map(l => [l.symbol, s])));
  return p.rows.flatMap(r => {
    const s = bySymbol.get(r.symbol);
    if (!s) return [{ row: r }];
    return s.legs[0].symbol === r.symbol ? [{ spread: s }] : [];
  });
}

// ---------- phones: a card per position instead of the sideways table ----------

const pct1 = v => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)}%`;
const tone = v => v === null || Math.abs(v) < 0.005 ? '' : v > 0 ? 'pos-locked' : 'pos-loss';
const signed$ = v => Math.abs(v) < 0.005 ? '$0.00' : `${v > 0 ? '+' : '−'}${fmt$(Math.abs(v))}`;

/** 'GOOGL 6/20/26 335C' → the root, then '335C 6/20/26' quieter beside it, so the strike survives the ellipsis */
function cardName(label) {
  const [root, ...rest] = String(label).split(' ');
  const detail = rest.length === 2 && /^\d+\/\d+\/\d+$/.test(rest[0]) ? `${rest[1]} ${rest[0]}` : rest.join(' ');
  return `<b>${esc(root)}</b>${detail ? ` <span class="pc-detail">${esc(detail)}</span>` : ''}`;
}

/**
 * the stop ladder: the stop, your cost and the price on one line, the stretch from cost to price tinted by the P/L.
 * A long option with no stop starts at zero, its premium being the risk
 */
function ladder({ stop, cost, price, floor, pnl }) {
  const pts = [stop, cost, price, floor].filter(v => v !== null && Number.isFinite(v));
  let lo = Math.min(...pts), hi = Math.max(...pts);
  const span = hi - lo;
  const pad = span * 0.12;
  if (span < 1e-9) { lo -= 1; hi += 1; } else { hi += pad; if (lo !== floor) lo -= pad; }
  const at = v => ((v - lo) / (hi - lo) * 100).toFixed(1) + '%';
  const cls = tone(pnl);
  const fill = cost !== null && cls ? `<span class="pc-fill ${cls}" style="left:${at(Math.min(cost, price))};right:calc(100% - ${at(Math.max(cost, price))})"></span>` : '';
  return `<div class="pc-ladder" aria-hidden="true"><span class="pc-track"></span>${fill}`
    + (stop !== null ? `<span class="pc-tick pc-stop" style="left:${at(stop)}"></span>` : '')
    + (cost !== null ? `<span class="pc-tick pc-cost" style="left:${at(cost)}"></span>` : '')
    + `<span class="pc-dot ${cls}" style="left:${at(price)}"></span></div>`;
}

/** the line under the ladder: where the stop is, or that there isn't one */
function stopNote(r) {
  const px = v => fmtPositionPrice(v, r.tradeAs);
  if (r.stop === null) return r.option && r.qty > 0 ? '<span class="pc-note">No stop · max loss is premium</span>' : '<span class="pc-note pos-partial">No stop</span>';
  const held = Math.abs(r.qty);
  const covers = r.covered < held ? ` · <span class="pos-partial">covers ${r.covered.toLocaleString('en-US')} of ${held.toLocaleString('en-US')}</span>` : '';
  if (atBreakeven(r)) return `<span class="pc-note pos-locked">${r.stopOrders.every(x => x.stop === r.be) ? 'At breakeven' : `Stop${r.stops > 1 ? 's' : ''} past breakeven${r.risk !== null && r.risk < -0.005 ? ` · +${fmt$(-r.risk)} locked` : ''}`}</span>`;
  return `<span class="pc-note">Stop ${px(r.stop)}${r.stops > 1 ? ` · +${r.stops - 1} more` : ''}${covers}</span>`;
}

/** R on the card: the R column's, once the Journal is in when signed in */
function cardR(r) {
  if (state.session && !state.journalRecords && (state.posJournalBusy || state.journalLoading)) return null;
  return positionR(r, positionTrades(), state.positions?.last4 || '').r;
}

function cardRisk(r) {
  if (r.risk === null) return '—';
  if (Math.abs(r.risk) < 0.005) return '<span class="pos-locked">$0.00</span>';
  return r.risk > 0 ? `<span class="pos-loss">−${fmt$(r.risk)}</span>` : `<span class="pos-locked">+${fmt$(-r.risk)} locked</span>`;
}

/** the part a tap toggles: the name, P/L, cost → price, the ladder and the stop line */
function cardTop(key, open, { name, pnl, sub, figures, bar, note }) {
  return `<div class="pc-top" data-action="togglePosCard" data-arg="${esc(key)}" role="button" tabindex="0" aria-expanded="${open}">
    <div class="pc-row"><span class="pc-name">${name}</span><span class="pc-pnl ${tone(pnl)}">${pnl === null ? '—' : signed$(pnl)}</span></div>
    <div class="pc-row pc-sub"><span>${sub}</span><span class="${tone(pnl)}">${figures}</span></div>
    ${bar}${note}
  </div>`;
}

const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;

/** a position's phone card; a spread's legs are cards too */
export function positionCard(r, leg = false) {
  const open = state.posCardsOpen.includes(r.symbol);
  const px = v => fmtPositionPrice(v, r.tradeAs);
  const unit = r.option ? 'ct' : 'sh';
  const R = r.pnl === null ? null : cardR(r);
  const figures = [r.pnlPct === null ? '' : pct1(r.pnlPct), R === null ? '' : rWords(R)].filter(Boolean).join(' · ');
  const top = cardTop(r.symbol, open, {
    name: cardName(r.label), pnl: r.pnl,
    sub: `${r.avg > 0 ? `${px(r.avg)} → ` : ''}<b>${px(r.price)}</b> · ${count(r.qty)} ${unit}`,
    figures,
    bar: ladder({ stop: r.stop, cost: r.avg > 0 ? r.avg : null, price: r.price, floor: r.option && r.qty > 0 && r.stop === null ? 0 : null, pnl: r.pnl }),
    note: stopNote(r),
  });
  const more = open ? `<div class="pc-more"><dl class="pc-stats">${stat('Mkt val', money(r.value))}${stat('Stop', r.stop === null ? '—' : px(r.stop))}${stat('Risk @ stop', cardRisk(r))}</dl>${tradeButtons(r)}</div>` : '';
  return `<article class="pc${open ? ' pc-open' : ''}${leg ? ' pc-leg' : ''}">${top}${more}</article>`;
}

function spreadCard(s) {
  const open = state.posCardsOpen.includes(s.key);
  const { r } = spreadR(s);
  const units = Math.abs(s.qty) === 1 ? 'spread' : 'spreads';
  const figures = [s.pnlPct === null ? '' : pct1(s.pnlPct), r === null ? '' : rWords(r)].filter(Boolean).join(' · ');
  const note = `<span class="pc-note">${esc(s.structure.charAt(0).toUpperCase() + s.structure.slice(1))}${s.maxLoss === null ? '' : ` · max loss ${fmt$(s.maxLoss)}`}</span>`;
  const top = cardTop(s.key, open, {
    name: cardName(s.label), pnl: s.pnl,
    sub: `${s.avg > 0 ? `${fmt$(s.avg)} → ` : ''}<b>${fmt$(s.price)}</b> · ${count(s.qty)} ${units}`,
    figures,
    // a debit spread is worth zero at worst; a credit's mark runs the other way, so no bar
    bar: s.kind === 'debit' && s.avg > 0 ? ladder({ stop: null, cost: s.avg, price: s.price, floor: 0, pnl: s.pnl }) : '',
    note,
  });
  const more = open ? `<div class="pc-more"><dl class="pc-stats">${stat('Mkt val', money(s.value))}${stat('Max loss', s.maxLoss === null ? '—' : `<span class="pos-loss">−${fmt$(s.maxLoss)}</span>`)}${stat('Legs', esc(s.legWords))}</dl><span class="pos-acts">${spreadButtons(s)}</span></div>` : '';
  const legs = state.posLegsOpen.includes(s.key) ? s.legs.map(l => positionCard(l, true)).join('') : '';
  return `<article class="pc${open ? ' pc-open' : ''}">${top}${more}</article>${legs}`;
}

/** a tap on a phone card: opens or closes its figures and buttons */
export function togglePosCard(key) {
  const open = state.posCardsOpen.includes(key);
  state.posCardsOpen = open ? state.posCardsOpen.filter(k => k !== key) : [...state.posCardsOpen, key];
  renderPositionsTable();
}

/** the account in three tiles over the cards: its value, what's in positions, the open P/L */
function cardTiles(p) {
  const tile = (label, value, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
  const account = state.posHideValue ? 'Hidden' : '$' + Math.round(p.value).toLocaleString('en-US');
  return `<dl class="pc-tiles">${tile('Account', account)}${tile('Invested', money(p.total))}${tile('Open P/L', p.pnl === null ? '—' : signed$(p.pnl), tone(p.pnl))}</dl>`;
}

const CARD_LEGEND = '<div class="pc-legend" aria-hidden="true"><span><i class="pc-key pc-stop"></i>Stop</span><span><i class="pc-key pc-cost"></i>Cost</span><span><i class="pc-key pc-price"></i>Price</span></div>';

/** a phone turned sideways (or a window resized) swaps cards and table */
let phoneWatched = false;
function watchPhone() {
  if (phoneWatched || !window.matchMedia) return;
  phoneWatched = true;
  window.matchMedia(PHONE_MQ).addEventListener?.('change', () => { if (state.positionsView) { readPositionJournal(); renderPositionsTable(); } });
}

export function renderPositions() {
  readPositionJournal();
  renderPositionsTable();
  renderPositionChart(); // its lines, sizes and target checks follow each read
}

function renderPositionsTable() {
  const el = document.getElementById('positionsSection');
  const p = state.positions;
  const items = p ? tableRows(p) : [];
  document.getElementById('posCount').textContent = items.length ? String(items.length) : '';
  const refresh = `<button class="btn" data-action="refreshPositions"${state.positionsBusy ? ' disabled' : ''} title="Read positions from Schwab now (r)">${state.positionsBusy ? '<span class="spinner" style="width:12px;height:12px;"></span> Refreshing…' : '↻ Refresh'}</button>`;
  if (!p) {
    el.innerHTML = !schwabConnected()
      ? `<div class="card empty-card"><div class="setup-title">Connect Schwab to see your positions</div><p>${state.positionsError ? esc(state.positionsError) : 'Positions come live from your Schwab account. Log in under Settings, Schwab trading.'}</p><button class="btn primary" data-action="openSheet" data-arg="settings">Open settings</button></div>`
      : `<div class="card empty-card"><div class="setup-title">${state.positionsBusy ? '<span class="spinner" style="vertical-align:middle;margin-right:8px;"></span>Loading positions…' : 'Positions'}</div>${state.positionsError ? `<p class="shares-error" role="status">${esc(state.positionsError)}</p>` : ''}${refresh}</div>`;
    return;
  }
  // a 30s refresh must not jump a phone's sideways scroll back
  const scrolled = [...el.querySelectorAll('.positions-wrap')].map(w => w.scrollLeft);
  const asOf = inZone(p.asOf);
  watchPhone();
  const phone = mq(PHONE_MQ);
  const cols = shownCols();
  // phones show the account value in a tile over the cards
  const value = state.posHideValue ? 'Account value hidden' : phone ? `Cash ${money(p.cash)}` : `Account value ${fmt$(p.value)} · cash ${money(p.cash)}`;
  const hide = `<button class="pos-link" data-action="togglePosHideValue" aria-pressed="${state.posHideValue}" title="${state.posHideValue ? 'Show' : 'Hide'} the account value and cash">${state.posHideValue ? 'Show' : 'Hide'}</button>`;
  const picker = state.posColsOpen ? `<div class="chip-row pos-cols" role="group" aria-label="Optional columns">${EXTRA_COLS.map(([key, label]) => {
    const on = state.posCols.includes(key);
    return `<button class="filter-btn${on ? ' active' : ''}" data-action="togglePosColumn" data-arg="${key}" aria-pressed="${on}">${label}</button>`;
  }).join('')}</div>` : '';
  el.innerHTML = `<div class="card positions-card">
    <div class="positions-head">
      <span class="section-title">Schwab ••${esc(p.last4)}</span>
      <span class="positions-meta">${value} ${hide} · as of ${asOf}</span>
      ${phone ? '' : `<button class="btn pos-cols-btn" data-action="togglePosColumnsMenu" aria-expanded="${state.posColsOpen}" title="Add or remove columns: P/L, R and today's P/L">Columns</button>`}
      ${refresh}
    </div>
    ${phone ? '' : picker}
    ${state.positionsError ? `<p class="shares-error" role="status">Refresh failed: ${esc(state.positionsError)} Showing ${asOf}.</p>` : ''}
    ${p.stopsMissing ? '<p class="hint">Stops unavailable: Schwab did not return this account\'s orders.</p>' : ''}
    ${p.rows.length && phone ? `${cardTiles(p)}${CARD_LEGEND}<div class="pc-list">${items.map(i => i.spread ? spreadCard(i.spread) : positionCard(i.row)).join('')}</div>
    <p class="hint">Stop is the nearest working stop order that closes the position, from the last 59 days of orders. R is open P/L over the risk at entry: the Journal trade's first stop (or a long option's premium), else the nearest stop now. Tap a card for its figures and buttons.</p>`
    : p.rows.length ? `<div class="positions-wrap"><table class="positions-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Qty</th><th scope="col">Avg cost</th><th scope="col">Price</th><th scope="col">Market value</th>${cols.map(([, label]) => `<th scope="col">${label}</th>`).join('')}<th scope="col">% of acct</th><th scope="col">Stop</th><th scope="col">Risk @ stop</th></tr></thead>
      <tbody>${items.map(i => i.spread ? spreadRow(i.spread) : positionRow(i.row)).join('')}</tbody>
      <tfoot><tr><th scope="row">Total</th><td></td><td></td><td></td><td>${money(p.total)}</td>${cols.map(([, , cell]) => `<td>${cell(p)}</td>`).join('')}<td>${p.totalPct.toFixed(2)}%</td><td></td><td>${p.risk > 0 ? `<span class="pos-loss">−${fmt$(p.risk)}</span><span class="pos-sub">${p.riskPct.toFixed(2)}% of acct</span>` : '—'}</td></tr></tfoot>
    </table></div>
    <p class="hint">Stop is the nearest working stop order that closes the position, from the last 59 days of orders. Risk @ stop is the loss if it fills, measured from your average cost; a spread's is its max loss.${rShown() ? ' R is open P/L over the risk at entry: the Journal trade\'s first stop (or a long option\'s premium), else the nearest stop now.' : ''}</p>` : '<p class="hint">No open positions in this account.</p>'}
  </div>
  ${ordersCard(p)}`;
  el.querySelectorAll('.positions-wrap').forEach((w, i) => { w.scrollLeft = scrolled[i] || 0; });
}

const orderPx = (o, v) => fmtPositionPrice(v, o.assetType === 'OPTION' ? 'OPTION' : null);

/** the price cell: a stop limit's limit and a trailing stop's current stop go underneath */
function orderPrice(o) {
  const under = o.trail && o.stop !== null ? `now ${orderPx(o, o.stop)}` : !o.trail && o.stop !== null && o.price !== null ? `${orderPx(o, o.price)} limit` : '';
  return esc(workingPrice(o)) + (under ? `<span class="pos-sub">${esc(under)}</span>` : '');
}

const orderWords = o => o.legs > 1 ? `${o.legs}-leg ${orderTypeWord(o.orderType)}` : `${INSTRUCTION_WORDS[o.instruction] || words(o.instruction)} ${orderTypeWord(o.orderType)}`;

/** when it went in: the time today, else the date */
function placed(entered) {
  const t = schwabTime(entered);
  if (Number.isNaN(t)) return '—';
  const day = ms => inZone(ms, { month: 'numeric', day: 'numeric' });
  return day(t) === day(Date.now()) ? inZone(t, { hour: 'numeric', minute: '2-digit' }) : day(t);
}

function orderRow(o, list) {
  const partner = o.oco !== null ? list.find(x => x.oco === o.oco && x !== o) : null;
  const note = partner ? `one cancels the other with the ${orderTypeWord(partner.orderType)} ${workingPrice(partner)}`
    : o.parent ? `after the ${INSTRUCTION_WORDS[o.parent] || words(o.parent)} fills` : '';
  const what = orderWords(o);
  const left = o.qty - o.filled;
  const lasts = (DURATION_WORDS[o.duration] || words(o.duration) || '—') + (o.session && o.session !== 'NORMAL' ? '<span class="pos-sub">extended hours</span>' : '');
  // an order waiting on its entry goes with that entry, so only the entry gets the buttons
  const acts = o.orderId !== null && o.status !== 'AWAITING_PARENT_ORDER'
    ? `<span class="pos-acts">${editable(o) ? `<button class="pos-act" data-action="openOrderEdit" data-arg="${esc(o.orderId)}" title="Change the price, size or how long it lasts">Edit</button>` : ''}<button class="pos-act" data-action="openOrderCancel" data-arg="${esc(o.orderId)}" title="Review cancelling this order">Cancel</button></span>` : '';
  return `<tr${o.oco !== null ? ' class="pos-oco"' : ''}>
    <td><b>${esc(o.label)}</b>${acts}</td>
    <td class="pos-order">${esc(what.charAt(0).toUpperCase() + what.slice(1))}${note ? `<span class="pos-sub">${esc(note)}</span>` : ''}</td>
    <td>${orderPrice(o)}</td>
    <td>${o.filled > 0 ? `${left.toLocaleString('en-US')}<span class="pos-sub">of ${o.qty.toLocaleString('en-US')}, ${o.filled.toLocaleString('en-US')} filled</span>` : o.qty.toLocaleString('en-US')}</td>
    <td>${lasts}</td>
    <td>${esc(STATUS_WORDS[o.status] || words(o.status))}</td>
    <td>${placed(o.entered)}</td>
  </tr>`;
}

/** every order still working in the account, entries included; a pair's legs sit together and name each other */
function ordersCard(p) {
  const head = n => `<div class="positions-head"><span class="section-title">Working orders</span>${n === null ? '' : `<span class="positions-meta">${n ? n.toLocaleString('en-US') : 'None'}</span>`}</div>`;
  if (p.stopsMissing) return `<div class="card positions-card orders-card">${head(null)}<p class="hint">Orders unavailable: Schwab did not return this account's orders.</p></div>`;
  const list = workingOrders(p.orders);
  return `<div class="card positions-card orders-card">${head(list.length)}
    ${list.length ? `<div class="positions-wrap"><table class="positions-table orders-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">Order</th><th scope="col">Price</th><th scope="col">Qty</th><th scope="col">Lasts</th><th scope="col">Status</th><th scope="col">Placed</th></tr></thead>
      <tbody>${list.map(o => orderRow(o, list)).join('')}</tbody>
    </table></div>` : ''}
    <p class="hint">${list.length ? 'From the last 59 days of orders: one placed before that doesn\'t show here.' : 'Nothing working in the last 59 days of orders.'}</p>
  </div>`;
}

// Option entries at Schwab: Trade at Schwab on a chain contract buys calls or puts to open at a limit (the mid, the ask, the bid or your price), sized by the card, with a stop on the option.
// The review is the shares one's sheet (#tradeSheet) and ticket slot (state.tradeTicket, marked option), so the setup and tactic
// picks and the plan kept with the order (ui/order-plan.js) come with it. The ticket freezes when it opens: the contract count the
// card sized, the option stop the loss model puts at your underlying stop, and the limit picked. Place reads the contract's quote
// again and re-checks the frozen order against it, then sends it once to the account it was reviewed for; nothing retries it.
import { state } from '../state.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { inRegularHours, onOptionStep, optionEntryOrder, optionLimitError, optionQuoteStep, optionStopTick, optionTicketError, quoteLimit } from '../core/orders.js';
import { fmtPositionPrice, positionLabel, schwabOptionSymbol } from '../core/positions.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabAccounts, schwabConnected, schwabStopDuration, schwabWarm } from '../services/schwab.js';
import { showError } from './feedback.js';
import { planContext, startTradePlan, tradePlanHtml } from './order-plan.js';
import { readLegQuotes, showSheetQuote, watchSheetQuote } from './sheet-quote.js';
import { openSheet } from './sheets.js';
import { limitWaiting, mask, refreshTradeStatus, sendReviewed } from './trade.js';

/** a market this wide (ask − bid over the mid) is called out, as the chain does */
export const WIDE_SPREAD_PCT = 10;
const ENTRIES = ['mid', 'ask', 'bid', 'limit'];
const REPEAT_MS = 120000;
const px = v => v > 0 ? fmtPositionPrice(v, 'OPTION') : '—';
/** options on SPY, QQQ, IWM and a few other ETFs trade to 16:15; most stop at 16:00 */
const LATE_CLOSE = 16 * 60 + 15;

/**
 * Why a chain contract can't go to Schwab from here, or '' when it can: Schwab connected, risk sizing, a stock or ETF
 * underlying, and a standard 100-share contract on that root (an adjusted one delivers something else).
 * @param {any} c the contract's detail (state.detailReg)
 */
export function optionTradeBlock(c) {
  if (!schwabConnected()) return 'Connect Schwab in Settings to trade from here.';
  if (!c) return 'Tap the contract in the chain again, then Trade at Schwab.';
  if (c.allocation) return 'Trading from the chain sizes by risk. Switch the sizing method to Risk.';
  const q = state.quoteData;
  if (!q || (q.type && q.type !== 'stock' && q.type !== 'etf')) return 'Only options on stocks and ETFs trade from here.';
  if (c.opt.contract_size !== 100 || c.opt.root_symbol !== q.symbol) return 'Only standard 100-share contracts trade from here. This one is adjusted or not on the usual root.';
  if (!schwabOptionSymbol(c.opt.symbol)) return 'This contract has no symbol Schwab takes.';
  return '';
}

/** the detail's Trade at Schwab button: shown while connected and sizing by risk, greyed out with why when it can't go */
export function optionTradeButton(c) {
  if (!schwabConnected() || state.sizingMode !== 'risk' || c.allocation) return '';
  const why = optionTradeBlock(c) || (c.contracts < 1 ? 'Your max loss buys less than one contract at this stop.' : '');
  return `<button class="btn trade-btn option-trade-btn" data-action="openOptionTrade" data-arg="${esc(c.opt.symbol)}" title="${esc(why || 'Review a limit buy with a stop on the option, then send it to Schwab')}"${why ? ' disabled' : ''}>Trade at Schwab</button>`;
}

/** where a limit at the quote sits, from that quote: { price, step } (the step the class trades in there) */
function limitAt(entryAt, q, typed = 0) {
  if (entryAt !== 'limit') return quoteLimit(entryAt, q, { buy: true, option: true });
  const step = optionQuoteStep(typed, q.bid, q.ask);
  return { price: typed > 0 ? onOptionStep(typed, step) : 0, step };
}

/**
 * The frozen terms of a bought option against quote q: what goes to Schwab, its risk, and what to look at first. flags name
 * the warnings, so a re-check before sending can tell a new one from one already reviewed.
 */
function optionTicketFor(p, q, now) {
  const { qty, stop, limitPrice: limit } = p;
  const error = optionTicketError({ qty, bid: q.bid, ask: q.ask, stop });
  const limitError = error ? '' : optionLimitError({ limit, stop });
  const mid = (q.bid + q.ask) / 2, spreadPct = mid > 0 ? (q.ask - q.bid) / mid * 100 : 0;
  const t = {
    ...p, option: true, isLong: true, entryType: 'LIMIT', entry: limit, limitError,
    bid: q.bid || 0, ask: q.ask || 0, last: q.last || 0, spreadPct,
    // a limit buys at its price or better, so its risk is at the limit; the plan is what the card sized from
    fillRisk: qty * (limit - stop) * 100,
    error, order: null, warnings: [], flags: [], sent: false, orderId: '', result: null, entryStatus: '', filled: 0, planId: '',
  };
  if (error || limitError) return t;
  t.order = optionEntryOrder({ symbol: p.symbol, qty, limit, stop, stopDuration: p.stopDuration });
  const warn = (flag, text) => { t.flags.push(flag); t.warnings.push(text); };
  if (!inRegularHours(now, p.etf ? LATE_CLOSE : undefined)) warn('hours', 'Outside regular hours. Options trade 9:30 to 16:00, so the limit waits for the next open.');
  else if (!inRegularHours(now)) warn('late', 'After 16:00. Options on SPY, QQQ, IWM and a few other ETFs trade until 16:15; on the rest the limit waits for the next open.');
  if (spreadPct > WIDE_SPREAD_PCT) warn('wide', `Wide market: ${px(q.bid)} × ${px(q.ask)} is ${spreadPct.toFixed(0)}% of the mid. A fill and a stop-out can both cost more than they look.`);
  if (t.fillRisk > p.plannedRisk * 1.1 + 0.01) warn('risk', `At the limit ${px(limit)}, risk is ${fmt$(t.fillRisk)}, over your ${fmt$(p.plannedRisk)} plan.`);
  if (p.customEntry) warn('planned', `Sized for your planned ${p.underlying} entry ${fmt$(p.entryU)}. This limit buys now, at today's price.`);
  const last = state.tradeLast;
  if (last && last.symbol === p.symbol && now - last.at < REPEAT_MS) warn('repeat', `You sent a ${p.label} order ${Math.round((now - last.at) / 1000)}s ago. This places another one.`);
  return t;
}

/** the contract's quote now from Tradier, or null when it didn't answer with one */
async function contractQuote(occ) {
  try { return (await readLegQuotes([occ]))[occ] || null; } catch(e) { return null; }
}

/** the live quote the sheet shows, when it has a fresh one for this ticket */
function liveQuote(t) {
  const q = state.sheetQuote;
  return q && q.sheet === 'trade' && q.at > 0 && !q.failed && q.legs[0]?.symbol === t.occ ? { last: q.last, bid: q.bid, ask: q.ask } : null;
}

/** the review for a chain contract: the card's count and stop, the limit at the mid of a fresh quote */
export async function openOptionTrade(occ) {
  if (state.tradeBusy) return;
  const c = state.detailReg[occ];
  if (!schwabConnected()) { showError('Connect Schwab in Settings first.'); openSheet('settings'); return; }
  const why = optionTradeBlock(c);
  if (why) { showError(why); return; }
  const underlying = state.quoteData.symbol;
  state.tradeBusy = true;
  let q = null;
  try { q = await contractQuote(occ); } finally { state.tradeBusy = false; }
  // the card it was sized on must still be the one showing: a new ticker or a new chain read while the quote was out
  if (state.quoteData?.symbol !== underlying || state.detailReg[occ] !== c) { showError('The ticker or the chain changed. Check the contract, then try again.'); return; }
  if (!q) { showError('Could not read the contract\'s quote from Tradier, so there is nothing to review yet. Try again.'); return; }
  const symbol = schwabOptionSymbol(occ), acct = schwabAccount();
  const { price, step } = limitAt('mid', q);
  state.tradeTicket = optionTicketFor({
    occ, symbol, label: positionLabel({ assetType: 'OPTION', symbol }), underlying, etf: state.quoteData.type === 'etf', isCall: c.isCall,
    qty: c.contracts, stop: c.atStop > 0 ? optionStopTick(c.atStop, true) : 0, atStop: c.atStop, underStop: c.stop, model: c.model,
    planPrem: c.entryPrem, plannedRisk: c.contracts * c.lossPerContract, customEntry: !!c.customEntry, entryU: c.entryU,
    entryAt: 'mid', limitPrice: price, step, stopDuration: schwabStopDuration(), hash: acct ? acct.hash : '',
    setups: [], tactics: [], setupGrade: '', setupOrder: null, picksTouched: false, prefilled: false, planCtx: planContext(c.isCall, c.stop),
  }, q, Date.now());
  state.tradeSetupQuery = '';
  startTradePlan(state.tradeTicket);
  renderOptionTradeSheet();
  openSheet('trade');
  if (state.tradeTicket.hash) schwabWarm(state.tradeTicket.hash, { post: true }); // the login, the connection and the browser's permission to post, while you review
  // a buy fills at the ask
  watchSheetQuote({ sheet: 'trade', el: 'tradeQuote', legs: [{ symbol: occ, n: 1 }], first: q, fills: () => 'ask' });
}

const openTicket = () => { const t = state.tradeTicket; return t && t.option && !t.sent && !state.tradeBusy ? t : null; };
const reviewed = t => ({ bid: t.bid, ask: t.ask, last: t.last });

/** Mid | Ask | Bid | Limit: a quote pick takes the live quote as it is now (the ticket moves to it); Limit starts where the last one was */
export function setOptionEntry(at) {
  const t = openTicket();
  if (!t || !ENTRIES.includes(at)) return;
  const q = at === 'limit' ? reviewed(t) : liveQuote(t) || reviewed(t);
  const { price, step } = limitAt(at, q, t.limitPrice);
  state.tradeTicket = optionTicketFor({ ...t, entryAt: at, limitPrice: price, step }, q, Date.now());
  renderOptionTradeSheet();
}

/** typing the limit: re-plans and redraws only the details and Place, so the cursor stays put */
export function setOptionLimit(value) {
  const t = openTicket();
  if (!t || t.entryAt !== 'limit') return;
  const { price, step } = limitAt('limit', reviewed(t), parseFloat(value) || 0);
  const next = optionTicketFor({ ...t, limitPrice: price, step }, reviewed(t), Date.now());
  state.tradeTicket = next;
  document.getElementById('tradeDetail').innerHTML = optionDetail(next);
  const place = document.getElementById('tradePlace');
  if (place) { place.disabled = !next.order; place.textContent = placeLabel(next); }
}

export function setOptionStopDuration(d) {
  const t = openTicket();
  if (!t || t.error || (d !== 'DAY' && d !== 'GOOD_TILL_CANCEL')) return;
  store.set('schwab_stop_duration', d); // the next review, shares or option, starts here
  state.tradeTicket = optionTicketFor({ ...t, stopDuration: d }, reviewed(t), Date.now());
  renderOptionTradeSheet();
}

/** why the reviewed ticket can't go as it is, from a fresh quote; '' when it still can */
function recheck(t, q) {
  const acct = schwabAccount();
  if (!acct || acct.hash !== t.hash) return { why: 'You switched Schwab accounts since this was reviewed. Nothing was sent. Open the review again.', again: null };
  if (!q) return { why: `Could not read the ${t.label} quote again, so nothing was sent. Try again.`, again: null };
  const again = optionTicketFor(t, q, Date.now());
  if (again.error) return { why: again.error + ' Nothing was sent.', again };
  if (!again.order) return { why: again.limitError + ' Nothing was sent.', again: null };
  if (JSON.stringify(again.order) !== JSON.stringify(t.order)) return { why: 'The order changed since you reviewed it. Nothing was sent. Review it, then place again.', again };
  if (again.flags.some(f => !t.flags.includes(f))) return { why: 'The quote moved since you reviewed this. Nothing was sent. Check the warnings, then place again.', again };
  return { why: '', again };
}

export async function placeOptionTrade() {
  const t = state.tradeTicket;
  if (!t || !t.option || !t.order || t.sent || state.tradeBusy) return;
  return sendReviewed(t, {
    reread: async () => { const q = await contractQuote(t.occ); if (q) showSheetQuote('trade', q); return q; },
    recheck, render: renderOptionTradeSheet,
    sentText: `Order sent: buy ${t.qty} ${t.label} at ${px(t.limitPrice)} limit, stop ${px(t.stop)}.`,
  });
}

export async function checkOptionTradeStatus() {
  const t = state.tradeTicket;
  if (!t || !t.option || !t.orderId || state.tradeBusy) return;
  return refreshTradeStatus(t, renderOptionTradeSheet);
}

/** what Place says: "Buy 3 AAPL 11/20/26 230C at $6.15" */
const placeLabel = t => `Buy ${t.qty} ${t.label}${t.limitPrice > 0 ? ' at ' + px(t.limitPrice) : ''}`;

export function renderOptionTradeSheet() {
  const t = state.tradeTicket;
  if (!t || !t.option) return;
  const acct = schwabAccounts().find(a => a.hash === t.hash) || schwabAccount();
  document.getElementById('tradeAccount').textContent = acct ? 'Account ' + mask(acct.last4) : '';
  const body = document.getElementById('tradeBody');
  if (t.error) {
    body.innerHTML = `<p class="trade-warn" role="alert">${esc(t.error)}</p><div class="trade-actions"><button class="btn" data-action="closeSheet">Close</button></div>`;
    return;
  }
  const off = t.sent ? ' disabled' : '';
  const pick = (v, label, title) => `<button class="${t.entryAt === v ? 'active' : ''}" aria-pressed="${t.entryAt === v}" data-action="setOptionEntry" data-arg="${v}" title="${title}"${off}>${label}</button>`;
  const limit = t.entryAt === 'limit'
    ? `<div class="trade-limit"><label for="tradeLimit">Limit</label><div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="tradeLimit" step="0.01" min="0" inputmode="decimal" autocomplete="off" value="${t.limitPrice > 0 ? t.limitPrice.toFixed(2) : ''}" data-input="setOptionLimit"${off} /></div></div>` : '';
  const action = t.sent
    ? (t.orderId ? `<button class="btn" data-action="checkOptionTradeStatus"${state.tradeBusy ? ' disabled' : ''}>↻ Status</button>` : '')
      + (limitWaiting(t) ? `<button class="btn" data-action="openOrderEdit" data-arg="${esc(t.orderId)}" title="Move the limit if it isn't filling">Change limit</button>` : '')
    : `<button class="btn trade-confirm" id="tradePlace" data-action="placeOptionTrade"${state.tradeBusy || !t.order ? ' disabled' : ''}>${esc(placeLabel(t))}</button>`;
  body.innerHTML = `
    <dl class="trade-legs">
      <div><dt>Contract</dt><dd><strong>${esc(t.label)}</strong><span class="shares-detail">${t.isCall ? 'Call' : 'Put'} on ${esc(t.underlying)}, 100 shares a contract</span></dd></div>
      <div><dt>Buy at</dt><dd><div class="seg entry-types" role="group" aria-label="Limit price">${pick('mid', 'Mid', 'The mid, rounded up toward a fill')}${pick('ask', 'Ask', 'The ask: likely fills now')}${pick('bid', 'Bid', 'The bid: waits for a seller')}${pick('limit', 'Limit', 'Your own price')}</div>${limit}</dd></div>
    </dl>
    <div id="tradeDetail">${optionDetail(t)}</div>
    <div class="trade-plan" id="tradePlan">${tradePlanHtml(t)}</div>
    <div class="trade-actions">
      <button class="btn" data-action="closeSheet">${t.sent ? 'Close' : 'Cancel'}</button>
      ${action}
    </div>
    <p class="trade-result${t.result && t.result.ok !== null ? (t.result.ok ? ' ok' : ' bad') : ''}" id="tradeResult" role="status">${t.result ? esc(t.result.text) : ''}</p>
    ${t.timing ? `<p class="hint trade-timing">${esc(t.timing)}</p>` : ''}`;
}

/** everything under the price pick: the entry, the stop, the risk, the warnings and the payload */
function optionDetail(t) {
  const duration = (d, label) => `<button class="${t.stopDuration === d ? 'active' : ''}" aria-pressed="${t.stopDuration === d}" data-action="setOptionStopDuration" data-arg="${d}"${t.sent ? ' disabled' : ''}>${label}</button>`;
  const fillsNow = t.ask > 0 && t.limitPrice >= t.ask;
  const onMid = Math.abs((t.bid + t.ask) / 2 - t.limitPrice) < 0.0005;
  const where = t.entryAt === 'mid' ? `The mid of ${px(t.bid)} × ${px(t.ask)}${onMid ? '' : ', rounded up toward a fill'}. `
    : t.entryAt === 'ask' ? 'At the ask, so it likely fills now. '
    : t.entryAt === 'bid' ? 'At the bid: it waits for a seller and may not fill. '
    : fillsNow ? `At or over the ask ${px(t.ask)}, so it likely fills right away, at ${px(t.limitPrice)} or better. ` : '';
  const how = `${where}It stays at this price as the quote moves. Today only: if it hasn't filled by the close, it ends and the stop never goes in.`;
  const model = t.model === 'bs' ? 'Black-Scholes' : 'delta and gamma';
  const stopWhy = `Your ${esc(t.underlying)} stop ${fmt$(t.underStop)} puts it near ${fmt$(t.atStop)} (${model}), rounded up to a $0.05 / $0.10 step. Placed once the buy fills.`;
  return `<dl class="trade-legs">
      <div><dt>Entry</dt><dd><strong>Buy to open ${t.qty} at ${px(t.limitPrice)} limit</strong><span class="shares-detail">${esc(how)}</span></dd></div>
      <div><dt>Then stop</dt><dd><strong>Sell to close ${t.qty} at ${px(t.stop)}</strong><span class="shares-detail">A stop on the option's own price. ${stopWhy}</span></dd></div>
      <div><dt>Stop lasts</dt><dd><div class="seg" role="group" aria-label="Stop lasts">${duration('DAY', 'Today')}${duration('GOOD_TILL_CANCEL', 'Until canceled')}</div></dd></div>
      <div><dt>Risk at stop</dt><dd><span class="shares-loss">${t.limitError ? '—' : fmt$(t.fillRisk)}</span><span class="shares-detail">If it fills at the limit; planned ${fmt$(t.plannedRisk)} from the ${fmt$(t.planPrem)} the card sized on</span></dd></div>
      <div><dt>Cost</dt><dd>${fmt$(t.qty * t.limitPrice * 100)}<span class="shares-detail">The most you can lose if it goes to zero past the stop</span></dd></div>
      <div><dt>Reviewed at</dt><dd>Bid ${px(t.bid)} · ask ${px(t.ask)}</dd></div>
    </dl>
    ${t.limitError ? `<p class="trade-warn" role="alert">${esc(t.limitError)}</p>` : ''}
    ${t.warnings.map(w => `<p class="trade-warn">${esc(w)}</p>`).join('')}
    <p class="hint">An option stop triggers on the option's own price, which jumps with its spread, then sells at market, so a fast move can fill well under it.</p>
    ${t.order ? `<details class="hint-details"><summary>Order sent to Schwab</summary><pre class="trade-json">${esc(JSON.stringify(t.order, null, 2))}</pre></details>` : ''}`;
}

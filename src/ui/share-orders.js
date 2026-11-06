// Share order cards: the shares answer pinned as its own card (Pin order), as many as you like, each with its own Trade at Schwab.
// A card is live: an LOD / HOD stop follows the card's own day range, and the share count follows the max loss like every pinned card.
import { state } from '../state.js';
import { effectivePrice } from '../core/extended-hours.js';
import { fmt$, marketEscape as esc } from '../core/format.js';
import { isFuturesQuote } from '../core/futures.js';
import { unitsFor } from '../core/sizing.js';
import { inZone } from '../lib/zone.js';
import { schwabConnected } from '../services/schwab.js';
import { updatePinnedBar } from './cards.js';
import { showToast, withFlash } from './feedback.js';
import { orbEntryName } from './orb.js';
import { planContext } from './order-plan.js';
import { riskDollars } from './risk.js';
import { sharesPlan } from './shares.js';
import { dayRange, rawStop, stopSourceName } from './stops.js';
import { tradierQuote } from './ticker.js';

const isStock = q => !!q && (!q.type || q.type === 'stock' || q.type === 'etf');

/** the shares answer can be pinned: risk sizing on a stock or ETF with a valid stop (futures size in contracts, and Schwab trades only shares) */
export function canPinShares() {
  const q = state.quoteData;
  return state.currentMode === 'shares' && state.sizingMode === 'risk' && isStock(q) && !isFuturesQuote(q) && sharesPlan().valid;
}

export function updatePinSharesButton() {
  const btn = document.getElementById('sharesPin');
  const q = state.quoteData;
  const show = !!q && state.currentMode === 'shares' && state.sizingMode === 'risk' && isStock(q) && !isFuturesQuote(q);
  btn.style.display = show ? '' : 'none';
  btn.disabled = !show || !canPinShares();
}

/** Pin order: the shares answer as it stands becomes a card in the pinned list, newest on top */
export function pinShares() {
  if (!canPinShares()) return;
  const q = state.quoteData;
  const plan = sharesPlan();
  const customEntry = rawStop('entryPrice') > 0;
  const level = dayLevel(q, plan.isLong);
  const cardId = 'pinned_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); // two pins in one millisecond stay two cards
  state.pinnedData[cardId] = {
    kind: 'shares', symbol: q.symbol, isLong: plan.isLong, stopLevel: plan.stop, stopName: stopSourceName(plan.isLong, true),
    customEntry, entry: customEntry ? plan.entry : 0, entryNote: customEntry ? orbEntryName() : '',
    quote: { ...q }, planCtx: planContext(plan.isLong, plan.stop), asOf: inZone(Date.now()), lastOrder: null, checking: false,
    // an LOD / HOD stop keeps its distance from that level (the stop adjustment as pinned) and moves with it; a typed or opening-range stop stays put
    stopOffset: rawStop(plan.isLong ? 'stopLong' : 'stopShort') > 0 || !(level > 0) ? null : plan.stop - level,
  };
  const div = document.createElement('div');
  div.className = 'pinned-card';
  div.id = cardId;
  document.getElementById('pinnedSection').prepend(div);
  renderShareOrderCard(cardId);
  updatePinnedBar();
  showToast(`Pinned ${plan.isLong ? 'long' : 'short'} ${q.symbol}. Load the next ticker and pin it too.`);
  return cardId;
}

/** the day's low (long) or high (short) the card's default stop sits on; with Ext on the loaded symbol, its extended range */
const dayLevel = (q, isLong) => (isLong ? dayRange(q).low : dayRange(q).high) || 0;

/** an LOD / HOD stop to the card's level now, rounded outward to the cent like the calculator's */
function followDayRange(d) {
  if (d.stopOffset === null || d.stopOffset === undefined) return;
  const level = dayLevel(d.quote, d.isLong);
  if (!(level > 0)) return;
  const price = level + d.stopOffset;
  const stop = (d.isLong ? Math.floor(price * 100 + 1e-8) : Math.ceil(price * 100 - 1e-8)) / 100;
  if (!(stop > 0)) return;
  d.stopLevel = stop;
  d.planCtx = { ...d.planCtx, stop_level: level };
}

/** the card's entry: its planned price, else the market now (the extended price when there is one) */
export const cardEntry = d => d.customEntry && d.entry > 0 ? d.entry : effectivePrice(d.quote);

/** the card's plan in sharesPlan's shape: the share count from the max loss now */
export function cardPlan(d) {
  const entry = cardEntry(d), stop = d.stopLevel, isLong = d.isLong;
  const riskPerShare = isLong ? entry - stop : stop - entry;
  const valid = Number.isFinite(stop) && stop > 0 && Number.isFinite(entry) && entry > 0 && riskPerShare > 0;
  return { isLong, stop, entry, riskPerShare, valid, shares: valid ? unitsFor(riskDollars(), riskPerShare) : 0 };
}

/** what the card shows when its stop is on the wrong side */
function planError(d) {
  const entry = cardEntry(d);
  if (!(d.stopLevel > 0)) return 'Set a stop.';
  return d.isLong ? `Stop (${fmt$(d.stopLevel)}) must be below entry (${fmt$(entry)}) for a long.` : `Stop (${fmt$(d.stopLevel)}) must be above entry (${fmt$(entry)}) for a short.`;
}

/** the card's quote again from Tradier; null when it didn't come */
export async function refreshShareOrderQuote(cardId) {
  const d = state.pinnedData[cardId];
  if (!d || d.kind !== 'shares') return null;
  const q = await tradierQuote(d.symbol, false).catch(() => null);
  if (!q || q.symbol !== d.symbol || state.pinnedData[cardId] !== d) return null;
  d.quote = q;
  d.asOf = inZone(Date.now());
  followDayRange(d);
  return q;
}

/** a typed stop on the card: fixed at that price, its source custom from here on */
export function shareOrderStopChanged(cardId, el) {
  const d = state.pinnedData[cardId];
  if (!d || d.kind !== 'shares') return;
  const v = parseFloat(el.value);
  if (v > 0 && v !== d.stopLevel) {
    d.stopLevel = v;
    d.stopOffset = null; // yours now: the day range no longer moves it
    d.stopName = 'Custom stop';
    d.planCtx = { ...d.planCtx, stop_source: 'custom', stop_strategy: null, stop_amount: null };
  }
  state.flashNext = true;
  renderShareOrderCard(cardId, { force: true });
  state.flashNext = false;
}

/** a typed entry plans the order there; blank goes back to the market */
export function shareOrderEntryChanged(cardId, el) {
  const d = state.pinnedData[cardId];
  if (!d || d.kind !== 'shares') return;
  const v = parseFloat(el.value), was = d.customEntry ? d.entry : 0;
  d.customEntry = v > 0;
  d.entry = v > 0 ? v : 0;
  if (d.entry !== was) d.entryNote = ''; // an opening-range entry typed over is your own plan now
  state.flashNext = true;
  renderShareOrderCard(cardId, { force: true });
  state.flashNext = false;
}

/** every share order card again: the trade buttons follow the Schwab login and a review in flight */
export function renderShareOrderCards() {
  for (const [id, d] of Object.entries(state.pinnedData)) if (d.kind === 'shares') renderShareOrderCard(id);
}

const tradeLabel = d => d.checking ? 'Checking quote…' : d.lastOrder ? 'Trade at Schwab again' : 'Trade at Schwab';

/**
 * Draws one card. A redraw that isn't yours (the live refresh, a login change, a review starting) waits while you're typing
 * in the card's Entry or Stop, so it can't throw your typing away; committing the box redraws it (force).
 */
export function renderShareOrderCard(cardId, { force = false } = {}) {
  const d = state.pinnedData[cardId];
  const el = document.getElementById(cardId);
  if (!d || !el) return;
  const typing = document.activeElement;
  if (!force && typing && typing !== el && el.contains(typing)) return;
  const q = d.quote || {};
  const plan = cardPlan(d);
  const acct = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('accountSize')).value) || 1;
  const sym = esc(d.symbol), arg = esc(cardId);
  const market = q.bid > 0 && q.ask > 0 ? `bid ${fmt$(q.bid)} / ask ${fmt$(q.ask)}` : `last ${fmt$(q.last || 0)}`;
  const priceText = v => v > 0 ? v.toFixed(2) : '';
  const trade = schwabConnected() && isStock(q)
    ? `<button type="button" class="btn trade-btn" data-action="openCardTrade" data-arg="${arg}"${!plan.valid || state.tradeBusy ? ' disabled' : ''} title="Review this order, then send it to Schwab">${tradeLabel(d)}</button>`
    : '';
  const o = d.lastOrder;
  const sent = o ? `<p class="share-order-sent${o.lost ? ' lost' : ''}" role="status">${o.lost ? 'No answer from Schwab' : 'Sent'} ${esc(o.time)}: ${o.isLong ? 'buy' : 'short'} ${o.qty}${o.orderId ? ', order ' + esc(o.orderId) : ''}${o.lost ? '. Check your Schwab orders before trading it again' : ''}. <button type="button" class="pos-link" data-action="openCardOrder" data-arg="${arg}">Status</button></p>` : '';
  const pos = plan.shares * plan.entry, risk = plan.shares * plan.riskPerShare;
  el.innerHTML = `
    <div class="pinned-header">
      <span class="tag ${d.isLong ? 'call' : 'put'}">${d.isLong ? 'Long' : 'Short'}</span>
      <span class="pinned-symbol">${sym} shares</span>
      <span class="pinned-meta" style="font-size:12px;color:var(--text2);margin-left:4px;font-family:var(--num);">${fmt$(effectivePrice(q))} · ${market} &nbsp;·&nbsp; ${esc(d.asOf || '')}</span>
      <button class="card-act" data-action="refreshPinned" data-arg="${arg}" title="Refresh quote" style="margin-left:auto;background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;line-height:1;">↻</button>
      <button class="card-act" data-action="removePinned" data-arg="${arg}" title="Remove this order card" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:16px;line-height:1;">×</button>
    </div>
    <div class="stat-grid">
      <div class="stat highlight"><div class="s-label">Shares to ${d.isLong ? 'buy' : 'short'}</div><div class="s-val">${plan.valid ? plan.shares : '—'}</div><div class="s-sub">${plan.valid ? fmt$(pos) + ' position · ' + (pos / acct * 100).toFixed(1) + '%' : 'for ' + fmt$(riskDollars()) + ' risk'}</div></div>
      <div class="stat"><div class="s-label">Entry</div><div class="s-val"><input type="number" class="s-val-input" value="${d.customEntry ? priceText(d.entry) : ''}" placeholder="now" step="0.01" min="0" inputmode="decimal" title="Plan an entry price; blank is the market" aria-label="${sym} entry" data-change="shareOrderEntryChanged" data-arg="${arg}" /></div><div class="s-sub">${d.customEntry ? esc(d.entryNote || 'planned') : 'market ' + fmt$(plan.entry)}</div></div>
      <div class="stat danger"><div class="s-label">Stop price</div><div class="s-val"><input type="number" class="s-val-input" value="${priceText(d.stopLevel)}" step="0.01" min="0" inputmode="decimal" title="Edit the stop, the card resizes" aria-label="${sym} stop" data-change="shareOrderStopChanged" data-arg="${arg}" style="color:var(--red);" /></div><div class="s-sub">${esc(d.stopName)}</div></div>
      <div class="stat"><div class="s-label">Risk at stop</div><div class="s-val shares-loss">${plan.valid ? fmt$(risk) : '—'}</div><div class="s-sub">${plan.valid ? (risk / acct * 100).toFixed(2) + '% of account · ' + fmt$(plan.riskPerShare) + '/sh' : ''}</div></div>
    </div>
    ${plan.valid ? '' : `<div class="shares-error" role="status">${planError(d)}</div>`}
    ${trade || sent ? `<div class="shares-actions share-order-actions">${trade}${sent}</div>` : ''}
  `;
  withFlash(el);
}

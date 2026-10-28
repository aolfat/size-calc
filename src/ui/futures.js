// Futures in the Stocks & futures ticket: a /MES ticker's quote and bars come from Schwab, and the answer counts contracts.
import { fmt$, marketEscape } from '../core/format.js';
import { FUTURES_CONTRACTS, fmtTicks, futuresBars, futuresDays, futuresSymbol, parseFuturesQuote } from '../core/futures.js';
import { store } from '../lib/store.js';
import { schwabFuturesBars, schwabFuturesDaily, schwabFuturesQuote, schwabSession } from '../services/schwab.js';

export const FUTURES_ROOTS = Object.keys(FUTURES_CONTRACTS).map(r => '/' + r);

/** why a ticker starting with / can't load, or '' when it can */
export function futuresLoadError(text) {
  if (!futuresSymbol(text)) return `Futures here: ${FUTURES_ROOTS.join(', ')}, or one month like /MESZ26.`;
  if (!schwabSession()) return 'Futures prices come from Schwab. Log in to Schwab in Settings.';
  return '';
}

/** Schwab's refusals in words that say what to fix */
function words(e) {
  if (e?.status === 404) return 'Your Schwab worker can\'t read market data yet. Redeploy it (worker/schwab/README.md).';
  if (e?.status === 401 || e?.status === 403) return 'Schwab refused the market data. Check that your Schwab app has Market Data Production, then log in to Schwab again.';
  return e?.message || 'Couldn\'t read Schwab\'s market data.';
}

/** a futures ticker's quote in the app's quote form; a failure throws with words that say what to fix */
export async function fetchFuturesQuote(symbol) {
  let body;
  try { body = await schwabFuturesQuote(symbol); } catch(e) { throw new Error(words(e)); }
  const q = parseFuturesQuote(body, symbol);
  if (!q) throw new Error(`Schwab sent no price for ${symbol}.`);
  return q;
}

/** the last 8 days of 5-minute bars, overnight included, in the chart's form ([] when Schwab has none) */
export async function fetchFuturesBars(symbol) {
  try { return futuresBars(await schwabFuturesBars(symbol)); } catch(e) { throw new Error(words(e)); }
}

/** a year of daily bars in the daily chart's form */
export async function fetchFuturesDays(symbol) {
  try { return futuresDays(await schwabFuturesDaily(symbol)); } catch(e) { throw new Error(words(e)); }
}

// round-trip fees per contract, typed per root and kept on this device (futures_fees: { MES: 1.24 })

function feesByRoot() {
  try { const m = JSON.parse(store.get('futures_fees') || '{}'); return m && typeof m === 'object' ? m : {}; } catch(e) { return {}; }
}

/** @param {string} root */
export function futuresFees(root) {
  const v = Number(feesByRoot()[root]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** @param {string} root @param {string} text */
export function setFuturesFees(root, text) {
  const v = parseFloat(text);
  const m = feesByRoot();
  if (Number.isFinite(v) && v > 0) m[root] = Math.round(v * 100) / 100; else delete m[root];
  store.set('futures_fees', JSON.stringify(m));
}

/** the quote bar's tag: Real-time or Delayed, as Schwab says */
export function futuresFeedTag(q) {
  return q.realtime === false ? '<span class="tag futures-delayed" title="Schwab sent a delayed quote: check the price before you size off it">Delayed</span>'
    : q.realtime ? '<span class="tag futures-realtime">Real-time</span>' : '';
}

/**
 * The answer card for a futures plan (core/futures.js futuresPlan through sharesPlan).
 * @param {any} q the futures quote @param {any} p the plan @param {{ isLong: boolean, stopSource: string, entryNote: string, acct: number }} o
 */
export function futuresAnswerHtml(q, p, { isLong, stopSource, entryNote, acct }) {
  const px = v => fmtTicks(v, p.tickSize);
  const fees = futuresFees(q.root);
  const notional = p.contracts * p.entry * p.pointValue;
  return `
    <div class="shares-primary">
      <div class="shares-quantity">
        <label class="shares-label" for="sharesQty">Contracts to ${isLong ? 'buy' : 'short'}</label>
        <div class="s-val"><input id="sharesQty" type="number" class="s-val-input" value="${p.contracts}" min="0" step="1" title="Type a contract count, risk $ follows" aria-describedby="sharesQtyHint" data-change="sharesQtyChanged" /></div>
        <div class="shares-detail">${marketEscape(q.contract)} · entry <strong>${px(p.entry)}</strong>${entryNote ? ' · ' + entryNote : ''}</div>
        <div class="shares-edit-hint" id="sharesQtyHint">Edit contracts to set risk</div>
      </div>
      <div class="shares-stop">
        <div class="shares-label">Stop price</div>
        <div class="s-val">${px(p.stop)}</div>
        <div class="shares-detail">${stopSource}</div>
      </div>
    </div>
    <dl class="shares-metrics">
      <div><dt>Risk at stop</dt><dd class="shares-loss">${fmt$(p.totalRisk)}<span class="shares-detail">${(p.totalRisk / acct * 100).toFixed(2)}% of account</span></dd></div>
      <div><dt>Risk per contract</dt><dd>${fmt$(p.riskPerContract)}<span class="shares-detail">${p.ticks} ticks × ${fmt$(p.tickValue)}${fees > 0 ? ' + ' + fmt$(fees) + ' fees' : ''}</span></dd></div>
      <div><dt>Notional</dt><dd>${fmt$(notional)}<span class="shares-detail">${fmt$(p.pointValue)} a point</span></dd></div>
    </dl>
    <div class="field futures-fees">
      <label for="futuresFees">Round-trip fees per contract</label>
      <div class="prefix-wrap"><span class="prefix">$</span><input type="number" id="futuresFees" value="${fees || ''}" placeholder="0" step="0.01" min="0" data-change="futuresFeesChanged" data-arg="${marketEscape(q.root)}" /></div>
    </div>
    ${p.contracts === 0 ? `<p class="futures-warn" role="status">Max loss is below one contract's ${fmt$(p.riskPerContract)} risk.</p>` : ''}
    ${q.specMismatch ? `<p class="futures-warn">Schwab's tick for /${marketEscape(q.root)} is ${q.specMismatch.tick} × ${fmt$(q.specMismatch.tickAmount)}, not ${p.tickSize} × ${fmt$(p.tickValue)}. Check before you size.</p>` : ''}
    ${q.realtime === false ? '<p class="futures-warn">Schwab sent a delayed quote. Check the price before you size off it.</p>' : ''}
    <p class="hint">Entry and stop on whole ticks, the stop rounded away from the entry · slippage can add to the loss · margin is separate</p>
  `;
}

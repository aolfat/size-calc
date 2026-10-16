// Week and month reviews (docs/journal-step-3.md, slice 6, part 1): a week's total on the calendar, or Review the month,
// opens the period's review under the grid (state.journalReviewPeriod): the headline against the period before, the best
// and worst trade, the trades saved for the weekly review, and each part of a self-assessment with its numbers
// (core/journal-week.js). The whole period, no filters. Exit efficiency and heat come from the trades' saved 5-minute bars,
// read once per trade (state.journalExcursions).
import { fmt$, marketEscape as esc } from '../core/format.js';
import { activePeriods, stepPeriod, underlyingOf } from '../core/journal-stats.js';
import { periodReview, reviewTrades } from '../core/journal-week.js';
import { excursions, unpackBars } from '../core/trade-page.js';
import { nyDay, weekdaysBetween } from '../core/bars.js';
import { parseSchwabOption } from '../core/positions.js';
import { loadTradeBars } from '../services/bars.js';
import { state } from '../state.js';
import { periodReviewContext } from './journal-review.js';
import { periodName } from './journal-stats.js';
import { journalTradeList, renderJournal } from './journal.js';

const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const validKey = (unit, key) => unit === 'month' ? /^\d{4}-\d{2}$/.test(key) : /^\d{4}-\d{2}-\d{2}$/.test(key);

/** what a trade's excursions were read from: a change (a late fill, a re-close) reads them again */
const signature = t => `${t.closedAt}|${t.entryQty}|${t.avgEntry}`;
/** the 5-minute bars a trade's excursions come from: an option contract's own, a stock's; spreads have none */
const barsSymbol = t => t.legs ? '' : t.assetType === 'OPTION' && parseSchwabOption(t.symbol) ? t.symbol.replace(/\s+/g, '') : t.symbol;

/** a trade's excursions: undefined until read, null when there are no bars for it */
function excursionOf(t) {
  const c = state.journalExcursions[t.key];
  return c && c.sig === signature(t) ? c.ex : undefined;
}

/** read the saved bars for the period's closed trades that haven't been read yet, one query per symbol */
async function loadExcursions(unit, key) {
  const { closedHere } = reviewTrades(journalTradeList(), unit, key);
  const todo = closedHere.filter(t => barsSymbol(t) && excursionOf(t) === undefined);
  for (const t of closedHere) if (!barsSymbol(t)) state.journalExcursions[t.key] = { sig: signature(t), ex: null };
  if (!todo.length) return;
  state.periodBarsBusy = true;
  renderJournal();
  const bySymbol = new Map();
  for (const t of todo) {
    const days = weekdaysBetween(nyDay(t.openedAt), nyDay(t.closedAt));
    const s = bySymbol.get(barsSymbol(t)) || { days: new Set(), trades: [] };
    days.forEach(d => s.days.add(d));
    s.trades.push(t);
    bySymbol.set(barsSymbol(t), s);
  }
  await Promise.all([...bySymbol].map(async ([symbol, { days, trades }]) => {
    let bars = [];
    try { bars = unpackBars(await loadTradeBars(symbol, [...days].sort())); } catch(e) { bars = []; }
    for (const t of trades) state.journalExcursions[t.key] = { sig: signature(t), ex: bars.length ? excursions(t, bars) : null };
  }));
  state.periodBarsBusy = false;
  if (state.journalReviewPeriod?.unit === unit && state.journalReviewPeriod?.key === key) renderJournal();
}

/** a week's total or Review the month: its review under the calendar (tapping the one open closes it) */
export function openPeriodReview(unit, key) {
  if (!['week', 'month'].includes(unit) || !validKey(unit, key)) return;
  const p = state.journalReviewPeriod;
  state.journalReviewPeriod = p && p.unit === unit && p.key === key ? null : { unit, key };
  renderJournal();
  if (state.journalReviewPeriod) {
    document.getElementById('journalPeriodReview')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    loadExcursions(unit, key);
  }
}
export function closePeriodReview() { state.journalReviewPeriod = null; renderJournal(); }
/** ‹ or ›: the nearest week or month with exits before or after */
export function stepPeriodReview(by) {
  const p = state.journalReviewPeriod;
  if (!p) return;
  const next = stepPeriod(activePeriods(journalTradeList(), p.unit), p.key, Number(by) || 0);
  if (!next) return;
  state.journalReviewPeriod = { unit: p.unit, key: next };
  // the calendar follows: a month to itself, a week to its Friday's month unless the month shown already holds it
  const fri = p.unit === 'week' ? new Date(Date.parse(`${next}T00:00:00Z`) + 4 * 864e5).toISOString().slice(0, 7) : next;
  const shown = state.journalMonth || state.journalMonthShown;
  if (p.unit === 'month' || (next.slice(0, 7) !== shown && fri !== shown)) state.journalMonth = fri;
  renderJournal();
  loadExcursions(p.unit, next);
}

const cell = (label, value, sub = '', cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</dd></div>`;

function headline(r, word) {
  const s = r.stats, p = r.prev, before = `the ${word} before`;
  const vs = (now, then, f) => then === null || then === undefined ? '' : `${f(then)} ${before}`;
  return `<dl class="js-stats jw-stats">
    ${cell('Net P&amp;L', s.trades ? signed$(s.net) : '—', p.trades ? `${signed$(p.net)} ${before}` : `${s.trades} closed`, pnlClass(s.net))}
    ${cell('Win rate', s.winRate === null ? '—' : `${s.winRate}%`, vs(s.winRate, p.winRate, x => `${x}%`))}
    ${cell('Profit factor', s.profitFactor === null ? '—' : s.profitFactor.toFixed(2), s.profitFactor === null && s.trades ? 'no losses' : vs(s.profitFactor, p.profitFactor, x => x.toFixed(2)))}
    ${cell('Average R', s.avgR === null ? '—' : signedR(s.avgR), vs(s.avgR, p.avgR, signedR))}
  </dl>`;
}

const tradeLink = (t, extra = '') => `<button class="pos-link" data-action="openTradeRow" data-arg="${esc(t.key)}">${esc(underlyingOf(t))}</button>${extra}`;

function category(c) {
  const facts = c.facts.length ? c.facts.map(f => `<li class="${f.tone === 'good' ? 'jw-good' : f.tone === 'bad' ? 'jw-bad' : ''}">${esc(f.text)}</li>`).join('')
    : '<li class="jw-none">Nothing to go on yet.</li>';
  return `<section class="jw-cat"><div class="jw-cat-name">${esc(c.name)}</div><ul class="jw-facts">${facts}</ul></section>`;
}

/** the review open under the calendar, or nothing */
export function periodReviewHtml(trades) {
  const p = state.journalReviewPeriod;
  if (!p) return '';
  const r = periodReview(trades, p.unit, p.key, { ...periodReviewContext(), excursion: excursionOf, barsPending: state.periodBarsBusy });
  const word = p.unit === 'month' ? 'month' : 'week';
  const active = activePeriods(trades, p.unit);
  const off = by => stepPeriod(active, p.key, by) ? '' : ' disabled';
  const title = p.unit === 'month' ? periodName('month', p.key) : `Week of ${periodName('week', p.key)}`;
  const best = r.best ? tradeLink(r.best, ` <span class="journal-buy">${signed$(r.best.pnl)}</span>`) : '';
  const worst = r.worst ? tradeLink(r.worst, ` <span class="journal-sell">${signed$(r.worst.pnl)}</span>`) : '';
  const lines = [
    best || worst ? `${best ? `Best: ${best}` : ''}${best && worst ? ' · ' : ''}${worst ? `Worst: ${worst}` : ''}` : '',
    r.saved.length ? `Saved for the weekly review: ${r.saved.map(t => tradeLink(t)).join(', ')}` : '',
    r.openCount ? `${r.openCount} opened this ${word} still open` : '',
  ].filter(Boolean);
  return `<div class="jw-panel" id="journalPeriodReview" role="region" aria-label="${esc(title)} review">
    <div class="jc-head jw-head">
      <button class="btn jc-nav" data-action="stepPeriodReview" data-arg="-1" aria-label="Earlier ${word} with trades"${off(-1)}>‹</button>
      <span class="jc-title">${esc(title)}</span>
      <button class="btn jc-nav" data-action="stepPeriodReview" data-arg="1" aria-label="Later ${word} with trades"${off(1)}>›</button>
      <button class="pos-link" data-action="openJournalStats" data-arg="${p.unit}" data-arg2="${p.key}">All of the ${word}'s stats</button>
      <button class="btn jw-close" data-action="closePeriodReview" aria-label="Close the review">×</button>
    </div>
    ${r.trades ? `${headline(r, word)}
      ${lines.length ? `<p class="hint jw-lines">${lines.join('<br>')}</p>` : ''}
      <div class="jw-cats">${r.categories.map(category).join('')}</div>
      <p class="hint">The whole ${word}: the side, symbol and setup filters don't apply. Results count the exits taken this ${word}, like the calendar; entries, notes and trades per day count the trades opened in it. The best move and heat come from each trade's saved 5-minute bars. Green reads well, amber is worth a look.</p>`
    : `<p class="hint">No trades this ${word}.</p>`}
  </div>`;
}

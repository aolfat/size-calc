// Journal Calendar and Stats tabs (journal step 2, slice 4; core/journal-stats.js does the numbers): the calendar is a
// month of realized P&L by day (each exit on its own day, trims included; each day with its win rate and profit factor)
// under the month's own numbers, with weekly totals; a day tapped shows the trades with an exit then, a week's total its
// review (ui/journal-week.js, Review the month the month's), This month comes back to today's. The stats cover all time (closed trades) or one day, week or month of exits, the
// same ones the calendar adds up (‹ › step through the ones with exits): the headline numbers, the equity curve with its drawdown, results by month (or by day),
// streaks and the breakdowns, each group with the same stats, thin under 10. The Journal's side, symbol and fee choices
// apply here too.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { holdWords } from '../core/journal.js';
import { activeMonths, activePeriods, breakdowns, calendarMonth, countedTrades, dailyPnl, equityCurve, groupStats, inPeriod, monthlyResults, nyParts, periodKey, periodResults, PERIODS, stepPeriod, streaks, THIN } from '../core/journal-stats.js';
import { SANS_FONT } from '../lib/media.js';
import { state } from '../state.js';

const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
/** '+$1.2k' for a calendar cell: whole dollars under $1,000, one decimal of thousands above */
export const compact$ = v => {
  const a = Math.abs(v), s = v > 0 ? '+' : v < 0 ? '−' : '';
  return a >= 1000 ? `${s}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `${s}$${Math.round(a)}`;
};
const monthName = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const shiftMonth = (m, by) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + by, 1)); return d.toISOString().slice(0, 7); };

// ---------- Calendar ----------

/** this month in New York, 'YYYY-MM' */
export const thisMonth = () => nyParts(new Date().toISOString()).day.slice(0, 7);

/** the month shown: your pick, else the newest with exits, else this one */
function shownMonth(daily) {
  return state.journalMonth || activeMonths(daily)[0] || thisMonth();
}

const pct = v => `${Math.round(v)}%`;
const statCell = (label, value, sub = '', cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</dd></div>`;

function dayCell(d) {
  if (!d) return '<td class="jc-out"></td>';
  if (!d.trades) return `<td><div class="jc-day jc-quiet"><span class="jc-num">${+d.day.slice(8)}</span></div></td>`;
  const pf = d.profitFactor === null ? '' : d.profitFactor.toFixed(2);
  const label = `${d.day}: ${signed$(d.pnl)} over ${d.trades} trade${d.trades === 1 ? '' : 's'}, ${d.winRate}% won${pf ? `, profit factor ${pf}` : ''}`;
  return `<td><button class="jc-day ${pnlClass(d.pnl)}" data-action="pickJournalDay" data-arg="${d.day}" aria-label="${esc(label)}"><span class="jc-num">${+d.day.slice(8)}</span><span class="jc-pnl">${compact$(d.pnl)}</span><span class="jc-n">${d.trades} trade${d.trades === 1 ? '' : 's'}</span><span class="jc-rate">${pct(d.winRate)}<span class="jc-wide"> won${pf ? ` · PF ${pf}` : ''}</span></span></button></td>`;
}

function weekCell(w) {
  if (!w.trades) return '<td class="jc-week"></td>';
  const open = state.journalReviewPeriod?.unit === 'week' && state.journalReviewPeriod.key === w.start;
  const label = `Week of ${periodName('day', w.start)}: ${signed$(w.pnl)} over ${w.trades} trade${w.trades === 1 ? '' : 's'}, ${w.winRate}% won. Review the week`;
  return `<td class="jc-week"><button class="jc-weekbtn${open ? ' active' : ''}" data-action="openPeriodReview" data-arg="week" data-arg2="${w.start}" aria-label="${esc(label)}" aria-expanded="${open}" title="Review the week"><span class="${pnlClass(w.pnl)}">${compact$(w.pnl)}</span><span class="jc-n">${w.trades} trade${w.trades === 1 ? '' : 's'} · ${pct(w.winRate)}</span></button></td>`;
}

/** the month's own numbers over the grid, realized like the days: P&L, win rate, profit factor, green days */
function monthStats(cal) {
  if (!cal.trades) return '<p class="hint">No exits this month.</p>';
  return `<dl class="js-stats jc-stats">
    ${statCell('Net P&amp;L', signed$(cal.pnl), `${cal.trades} trade${cal.trades === 1 ? '' : 's'}`, pnlClass(cal.pnl))}
    ${statCell('Win rate', `${cal.winRate}%`, `${cal.wins} won, ${cal.losses} lost`)}
    ${statCell('Profit factor', cal.profitFactor === null ? '—' : cal.profitFactor.toFixed(2), cal.profitFactor === null ? 'no losses' : 'gross wins ÷ gross losses')}
    ${statCell('Green days', `${cal.green} of ${cal.days}`, `${cal.red} red`)}
  </dl>`;
}

export function calendarView(trades) {
  const daily = dailyPnl(trades);
  const month = shownMonth(daily);
  state.journalMonthShown = month; // ‹ and › step from here
  const cal = calendarMonth(daily, month);
  const cells = cal.weeks.map(w => `<tr>${w.days.map(dayCell).join('')}${weekCell(w)}</tr>`).join('');
  return `<div class="jc-head">
      <button class="btn jc-nav" data-action="shiftJournalMonth" data-arg="-1" aria-label="Previous month">‹</button>
      <span class="jc-title">${esc(monthName(month))}</span>
      <button class="btn jc-nav" data-action="shiftJournalMonth" data-arg="1" aria-label="Next month">›</button>
      <button class="btn jc-today" data-action="journalThisMonth"${month === thisMonth() ? ' disabled' : ''}>This month</button>
      ${cal.trades ? `<button class="btn jc-today" data-action="openPeriodReview" data-arg="month" data-arg2="${month}" aria-expanded="${state.journalReviewPeriod?.unit === 'month' && state.journalReviewPeriod.key === month}">Review the month</button><button class="pos-link" data-action="openJournalStats" data-arg="month" data-arg2="${month}">All of the month's stats</button>` : ''}
    </div>
    ${monthStats(cal)}
    <table class="jc-grid"><thead><tr><th scope="col">Mon</th><th scope="col">Tue</th><th scope="col">Wed</th><th scope="col">Thu</th><th scope="col">Fri</th><th scope="col">Week</th></tr></thead><tbody>${cells}</tbody></table>
    <p class="hint">P&amp;L goes on the day you took it, New York time: a trim counts that day, even while the rest is still open. A trade wins a day, week or month when what it took then adds up above zero; PF is the profit factor, none without a loss (phones show the win rate). Tap a day for its trades, a week's total to review the week.</p>`;
}

/** ‹ or ›: the month before or after the one shown */
export function nextJournalMonth(by) {
  const from = state.journalMonth || state.journalMonthShown || thisMonth();
  return shiftMonth(from, Number(by) || 0);
}

// ---------- Stats ----------

const shortDay = d => new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
/** 'October 2026', 'Oct 5–9, 2026' (Monday to Friday), 'Tue, Oct 6, 2026' */
export function periodName(unit, key) {
  if (unit === 'month') return monthName(key);
  if (unit === 'week') {
    const fri = plusDays(key, 4), y = fri.slice(0, 4);
    return key.slice(0, 7) === fri.slice(0, 7) ? `${shortDay(key)}–${+fri.slice(8)}, ${y}`
      : key.slice(0, 4) === y ? `${shortDay(key)} – ${shortDay(fri)}, ${y}` : `${shortDay(key)}, ${key.slice(0, 4)} – ${shortDay(fri)}, ${y}`;
  }
  return new Date(`${key}T00:00:00Z`).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
const validKey = (unit, key) => unit === 'month' ? /^\d{4}-\d{2}$/.test(key) : /^\d{4}-\d{2}-\d{2}$/.test(key);

/** the period the stats show (state.journalPeriod: all | day | week | month) and its trades: all time's closed ones, a period's exits */
export function statsScope(trades) {
  const unit = PERIODS.includes(state.journalPeriod) ? state.journalPeriod : 'all';
  if (unit === 'all') return { unit, key: '', active: [], list: countedTrades(trades) };
  const active = activePeriods(trades, unit);
  const picked = state.journalPeriodKey;
  const key = validKey(unit, picked) ? periodKey(picked, unit) : active[0] || periodKey(nyParts(new Date().toISOString()).day, unit);
  state.journalPeriodShown = key; // ‹ and › step from here
  return { unit, key, active, list: inPeriod(trades, unit, key) };
}

function periodBar({ unit, key, active }) {
  const on = v => `class="${unit === v ? 'active' : ''}" aria-pressed="${unit === v}"`;
  const p = (v, label) => `<button ${on(v)} data-action="setJournalPeriod" data-arg="${v}">${label}</button>`;
  const off = by => stepPeriod(active, key, by) ? '' : ' disabled';
  return `<div class="jc-head js-period">
    <div class="seg" aria-label="Period">${p('all', 'All time')}${p('month', 'Month')}${p('week', 'Week')}${p('day', 'Day')}</div>
    ${unit === 'all' ? '' : `<span class="js-period-nav"><button class="btn jc-nav" data-action="stepJournalPeriod" data-arg="-1" aria-label="Earlier ${unit} with trades"${off(-1)}>‹</button>
      <span class="jc-title">${esc(periodName(unit, key))}</span>
      <button class="btn jc-nav" data-action="stepJournalPeriod" data-arg="1" aria-label="Later ${unit} with trades"${off(1)}>›</button></span>
      ${unit === 'day' ? `<button class="pos-link" data-action="pickJournalDay" data-arg="${key}">The day's trades</button>` : ''}`}
  </div>`;
}

/** the headline numbers over a list of closed trades: net, win rate, profit factor, expectancy, averages, R, drawdown, streaks */
export function headline(list) {
  const s = groupStats(list), eq = equityCurve(list), st = streaks(list);
  const dash = '—', partial = list.filter(t => t.partial).length;
  const count = partial ? `${s.trades} trade${s.trades === 1 ? '' : 's'} · ${partial} partly closed` : `${s.trades} closed trade${s.trades === 1 ? '' : 's'}`;
  return `<dl class="js-stats">
    ${statCell('Net P&amp;L', signed$(s.net), count, pnlClass(s.net))}
    ${statCell('Win rate', s.winRate === null ? dash : `${s.winRate}%`, `${s.wins} won, ${s.losses} lost`)}
    ${statCell('Profit factor', s.profitFactor === null ? dash : s.profitFactor.toFixed(2), 'gross wins ÷ gross losses')}
    ${statCell('Expectancy', s.expectancy === null ? dash : signed$(s.expectancy), 'per trade', s.expectancy === null ? '' : pnlClass(s.expectancy))}
    ${statCell('Average win', s.avgWin === null ? dash : signed$(s.avgWin), s.avgLoss === null ? '' : `average loss ${signed$(s.avgLoss)}`, 'journal-buy')}
    ${statCell('Average R', s.avgR === null ? dash : signedR(s.avgR), s.bigLosses ? `${s.bigLosses} worse than −1.5R` : 'trades with a stop')}
    ${statCell('Max drawdown', eq.maxDrawdown ? signed$(eq.maxDrawdown) : '$0.00', 'from a running peak', eq.maxDrawdown < 0 ? 'journal-sell' : '')}
    ${statCell('Streaks', `${st.longestWin}W · ${st.longestLoss}L`, st.current ? `now ${st.current.count} ${st.current.kind === 'win' ? 'win' : 'loss'}${st.current.count === 1 ? '' : st.current.kind === 'win' ? 's' : 'es'}` : 'longest runs')}
  </dl>`;
}

const THIN_TAG = ' <span class="journal-tag journal-tag-quiet" title="Fewer than 10 trades: too few to read much into">thin</span>';

/** a group's row; withR adds the average R after the win rate. group is markup when html is set (the Setups tab's
 * buttons), and sub (markup) goes on a line under it */
function statRow(group, s, { withR = false, html = false } = {}, sub = '') {
  const v = (x, f) => x === null || x === undefined ? '—' : f(x);
  return `<tr${s.thin ? ' class="journal-thin"' : ''}><td>${html ? group : `<b>${esc(group)}</b>`}${s.thin && s.trades ? THIN_TAG : ''}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</td>
    <td>${s.trades}</td><td class="${s.trades ? pnlClass(s.net) : ''}">${s.trades ? signed$(s.net) : '—'}</td><td>${v(s.avg, signed$)}</td><td>${v(s.median, signed$)}</td>
    <td>${v(s.winRate, x => `${x}%`)}</td>${withR ? `<td>${v(s.avgR, signedR)}</td>` : ''}<td>${v(s.avgWin, signed$)}</td><td>${v(s.avgLoss, signed$)}</td><td>${v(s.profitFactor, x => x.toFixed(2))}</td><td>${s.bigLosses || ''}</td></tr>`;
}

/** a breakdown's table, the same columns for every group; rows are { group, stats, sub? } */
export function statTable(title, rows, note = '', first = 'Group', opts = {}) {
  if (!rows.length) return '';
  return `<div class="section-title js-sub">${title}</div>${note ? `<p class="hint">${note}</p>` : ''}
    <div class="positions-wrap"><table class="positions-table journal-table js-table"><thead><tr><th scope="col">${first}</th><th scope="col">Trades</th><th scope="col">Net</th><th scope="col">Average</th><th scope="col">Median</th><th scope="col">Win %</th>${opts.withR ? '<th scope="col" title="Over the trades with a stop">Avg R</th>' : ''}<th scope="col">Avg win</th><th scope="col">Avg loss</th><th scope="col">PF</th><th scope="col" title="Losses worse than −1.5R">Big losses</th></tr></thead>
    <tbody>${rows.map(r => statRow(r.group, r.stats, opts, r.sub)).join('')}</tbody></table></div>`;
}

function rBars(dist, withR) {
  if (!withR) return '<div class="section-title js-sub">R distribution</div><p class="hint">No closed trades with an initial stop yet.</p>';
  const max = Math.max(1, ...dist.map(d => d.count));
  return `<div class="section-title js-sub">R distribution</div><p class="hint">${withR} trade${withR === 1 ? '' : 's'} with an initial stop.</p>
    <div class="js-rbars">${dist.map(d => `<div class="js-rbar"><span class="js-rlabel">${esc(d.group)}</span><span class="js-rtrack"><span class="js-rfill ${d.group.startsWith('−') || d.group.startsWith('Under') ? 'neg' : 'pos'}" style="width:${Math.round((d.count / max) * 100)}%"></span></span><span class="js-rcount">${d.count || ''}</span></div>`).join('')}</div>`;
}

/** all time: by month; a month or a week: by day; a day needs neither */
function overTime(unit, list) {
  if (unit === 'all') return statTable('By month', monthlyResults(list).map(m => ({ group: monthName(m.month), stats: m })), '', 'Month');
  if (unit === 'day') return '';
  const dayLabel = d => `${new Date(`${d}T00:00:00Z`).toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${+d.slice(5, 7)}/${+d.slice(8)}`;
  return statTable('By day', periodResults(list, 'day').map(({ key, ...s }) => ({ group: dayLabel(key), stats: s })), 'The day of each exit.', 'Day');
}

export function statsView(trades) {
  if (!countedTrades(trades).length && !activePeriods(trades, 'day').length) return '<p class="hint">No closed trades match yet.</p>';
  const scope = statsScope(trades), { unit, list } = scope;
  if (!list.length) return `${periodBar(scope)}<p class="hint">${unit === 'all' ? 'No closed trades yet. A trim on an open trade counts in its day, week and month.' : `No exits this ${unit}.`}</p>`;
  const b = breakdowns(list);
  const hold = b.holdWinners !== null || b.holdLosers !== null
    ? `Winners held ${b.holdWinners === null ? '—' : holdWords(b.holdWinners)} on average, losers ${b.holdLosers === null ? '—' : holdWords(b.holdLosers)}.` : '';
  return `${periodBar(scope)}${headline(list)}
    <div class="section-title js-sub">Equity</div>
    <div class="js-equity chart-wrap"><canvas id="journalEquity" height="180"></canvas></div>
    <p class="hint">P&amp;L added up trade by trade as they closed; the red is the drawdown from the running peak.</p>
    ${overTime(unit, list)}
    ${statTable('By symbol', b.bySymbol, b.concentration ? `<span style="color:var(--amber)">${esc(b.concentration.group)} made ${b.concentration.share}% of your gross gains: one name is carrying the results.</span>` : 'Options and spreads count under their underlying.')}
    ${statTable('By side', b.bySide)}
    ${statTable('By instrument', b.byInstrument)}
    ${statTable('By time of day', b.byTimeOfDay, 'When the trade opened, New York time.')}
    ${unit === 'day' ? '' : statTable('By weekday', b.byWeekday, 'The day it opened.')}
    ${statTable('By hold time', b.byHold, hold)}
    ${statTable('Scaled out or all at once', b.byExits, 'Scaled out: more than one exit.')}
    ${rBars(b.rDistribution, b.withR)}
    <p class="hint">${unit === 'all' ? 'Closed trades only, by the day they closed' : `The exits taken this ${unit}, like the calendar: a trim counts here even while the rest is still open or closes later`} (New York time). Deleted trades and trades from before your history don't count. Groups under ${THIN} trades are marked thin.</p>`;
}

/** the equity curve: running total (blue), its peak (dashed), the drawdown between them in red */
export function drawJournalEquity(trades) {
  const canvas = document.getElementById('journalEquity');
  if (!canvas || !canvas.getContext) return;
  const w = canvas.clientWidth;
  if (!w) return;
  const { unit, list } = statsScope(trades);
  const curve = equityCurve(list).points;
  // drawn from $0 before the first trade, so the first win or loss shows as a move
  const points = curve.length ? [{ at: curve[0].at, total: 0, peak: 0, drawdown: 0 }, ...curve] : [];
  const h = 180, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;
  const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
  const vals = [0, ...points.map(p => p.total), ...points.map(p => p.peak)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 10; lo -= pad; hi += pad;
  const padL = 8, padR = 64, padT = 10, padB = 20, plotW = w - padL - padR, plotH = h - padT - padB;
  const x = i => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = v => padT + (hi - v) / (hi - lo) * plotH;
  ctx.font = `10px ${SANS_FONT}`;
  ctx.fillStyle = col('--text3');
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
    ctx.fillText(compact$(v).replace('+', ''), w - padR + 6, y(v) + 3);
  }
  ctx.strokeStyle = col('--border2'); ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();
  // drawdown: between the peak and the total
  ctx.save();
  ctx.fillStyle = 'rgba(255,93,93,0.22)';
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.peak)) : ctx.moveTo(x(i), y(p.peak))));
  for (let i = points.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(points[i].total));
  ctx.closePath(); ctx.fill(); ctx.restore();
  ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = col('--text3'); ctx.lineWidth = 1;
  ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.peak)) : ctx.moveTo(x(i), y(p.peak)))); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = col('--blue'); ctx.lineWidth = 1.75;
  ctx.beginPath(); points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.total)) : ctx.moveTo(x(i), y(p.total)))); ctx.stroke();
  // a day's curve is labelled by time, longer ones by date (New York)
  const md = at => { const p = nyParts(at); return unit === 'day' ? p.time.replace(/^0/, '') : `${+p.day.slice(5, 7)}/${+p.day.slice(8)}`; };
  ctx.fillStyle = col('--text3');
  ctx.fillText(md(points[0].at), padL, h - 6);
  const lastLabel = md(points[points.length - 1].at);
  ctx.fillText(lastLabel, w - padR - ctx.measureText(lastLabel).width, h - 6);
}

// Journal Setups tab (docs/journal-step-3.md, slice 5): every one of My setups with its numbers (closed trades, net, win
// rate, average R, profit factor; the ones not used yet too), the same by kind (every bounce together) and by level, then
// your closed trades cut by the review's other labels
// (setup grade, entry tactic, followed the plan, market, sector, mistakes, tags). A setup tapped opens its own page: what
// it's made of, its headline numbers, its grades and tactics, and its trades; from there its trades, stats or model book
// examples. The Journal's side, symbol and fee choices apply. A trade counts in each of its setups.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { GRADES, PLAN_FOLLOWED } from '../core/journal-labels.js';
import { countedTrades, groupStats, statsByLabel } from '../core/journal-stats.js';
import { fmtPositionPrice } from '../core/positions.js';
import { state } from '../state.js';
import { headline, statTable } from './journal-stats.js';
import { labelKeys, reviewLibrary, reviewOf, setupsOf } from './journal-review.js';

const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const openedDay = iso => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: '2-digit' }) : '';
const SIDE_WORDS = { long: 'Long', short: 'Short', neutral: 'Neutral' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** a trade that can carry a review: not deleted, not from before your history */
const reviewable = t => !t.deleted && t.status !== 'history';

/** the tab: the overview, or one setup's page; empty-handed when the reviews couldn't be read */
export function setupsView(trades) {
  if (state.journalReviewError) return `<p class="hint" style="color:var(--amber)">Your reviews couldn't load (${esc(state.journalReviewError)}), so the setups can't be counted.</p>`;
  if (!state.journalReview) return '<p class="hint">Loading your setups…</p>';
  const lib = reviewLibrary();
  return state.journalSetupKey ? setupPage(trades, lib, lib.resolve('setup', state.journalSetupKey)) : overview(trades, lib);
}

/** what a setup is made of, in words; nothing when that's just its name again (a pattern named for itself) */
const madeOf = (lib, key) => { const w = lib.partsWords(lib.parts(key)); return w.toLowerCase() === lib.nameOf('setup', key).toLowerCase() ? '' : w; };

/** a cut by one label kind: [{ group (its name), stats }] and how many closed trades have none */
function cut(trades, keysOf, nameOf, order = []) {
  const { rows, none } = statsByLabel(trades, keysOf, order);
  return { rows: rows.map(r => ({ group: nameOf(r.group), stats: r.stats })), none };
}
const noneNote = (none, what) => none ? `${plural(none, 'closed trade')} without ${what} ${none === 1 ? "isn't" : "aren't"} in it.` : '';

function overview(trades, lib) {
  const live = trades.filter(reviewable);
  const { rows, none } = statsByLabel(live, t => labelKeys(t, 'setup'));
  const byKey = new Map(rows.map(r => [r.group, r.stats]));
  /** @type {Map<string, number>} */
  const openBy = new Map();
  for (const t of live) if (t.status === 'open') for (const k of labelKeys(t, 'setup')) openBy.set(k, (openBy.get(k) || 0) + 1);
  // every setup offered, plus any a trade still carries after it was hidden; used ones first, by closed trades then net
  const keys = [...new Set([...rows.map(r => r.group), ...openBy.keys(), ...lib.choices('setup').map(i => i.key)])];
  const empty = groupStats([]);
  const list = keys.map(key => ({ key, stats: byKey.get(key) || empty, open: openBy.get(key) || 0 }));
  const setupRows = list.map(s => {
    const name = lib.nameOf('setup', s.key);
    const sub = [madeOf(lib, s.key), s.open ? `${s.open} open` : '', !s.stats.trades && !s.open ? 'not used yet' : ''].filter(Boolean).join(' · ');
    return { group: `<button class="journal-name" data-action="openJournalSetup" data-arg="${esc(s.key)}" aria-label="Open ${esc(name)}"><b>${esc(name)}</b></button>`, sub: esc(sub), stats: s.stats };
  });
  const counted = countedTrades(live).length;
  const withSetup = counted - none;
  const named = kind => key => lib.nameOf(kind, key);
  const grades = cut(live, t => reviewOf(t).grade ? [reviewOf(t).grade] : [], g => g, GRADES);
  // the action first and the level second: every bounce together, whatever it bounced off; any setup at the 21 EMA
  const kinds = cut(live, t => setupsOf(t).map(s => s.kind?.name || s.name), k => k);
  const levels = cut(live, t => setupsOf(t).flatMap(s => s.levels.map(l => l.name)), l => l);
  const tactics = cut(live, t => labelKeys(t, 'tactic'), named('tactic'));
  const plans = cut(live, t => reviewOf(t).plan ? [reviewOf(t).plan] : [], p => (PLAN_FOLLOWED.find(([v]) => v === p) || [p, p])[1], PLAN_FOLLOWED.map(([v]) => v));
  const markets = cut(live, t => reviewOf(t).market ? [reviewOf(t).market] : [], named('market'), lib.choices('market').map(i => i.key));
  const sectors = cut(live, t => labelKeys(t, 'sector'), named('sector'), lib.choices('sector').map(i => i.key));
  const mistakes = cut(live, t => labelKeys(t, 'mistake'), named('mistake'));
  const tags = cut(live, t => labelKeys(t, 'tag'), named('tag'));
  return `<p class="hint journal-summary">${plural(list.length, 'setup')} · ${counted ? `${withSetup} of ${plural(counted, 'closed trade')} ${withSetup === 1 ? 'has' : 'have'} a setup` : 'no closed trades yet'}${none ? ` · <span class="journal-fees-missing">${none} without a setup</span>` : ''} · <button class="pos-link" data-action="openJournalLibrary">Edit choices</button></p>
    ${statTable('My setups', setupRows, 'Tap a setup for its page. A trade counts in each of its setups, so the rows can add up to more than your total.', 'Setup', { withR: true, html: true })}
    ${statTable('By setup kind', kinds.rows, 'Every bounce together, whatever it bounced off; the same for undercut &amp; rally and rejection. A pattern is its own kind. A trade with two kinds counts in both.', 'Kind', { withR: true })}
    ${statTable('By level', levels.rows, 'Any setup at that level, whatever happened there. A trade at two levels counts in both.', 'Level', { withR: true })}
    ${statTable('By setup grade', grades.rows, "If A trades don't beat C trades, the grade isn't telling you anything yet.", 'Grade', { withR: true })}
    ${statTable('By entry tactic', tactics.rows, noneNote(tactics.none, 'a tactic'), 'Tactic', { withR: true })}
    ${statTable('Followed the plan', plans.rows, noneNote(plans.none, 'an answer'), 'Plan', { withR: true })}
    ${statTable('By market', markets.rows, noneNote(markets.none, 'a market'), 'Market', { withR: true })}
    ${statTable('By sector', sectors.rows, noneNote(sectors.none, 'a sector'), 'Sector', { withR: true })}
    ${statTable('By mistake', mistakes.rows, 'A trade with two mistakes counts in both.', 'Mistake', { withR: true })}
    ${statTable('By tag', tags.rows, '', 'Tag', { withR: true })}
    <p class="hint">Closed trades only, from your reviews. Deleted trades and trades from before your history don't count. Groups under 10 trades are marked thin.</p>`;
}

function tradeLine(t) {
  const open = t.status === 'open';
  const grade = reviewOf(t).grade;
  return `<tr${open ? ' class="journal-open"' : ''} data-action="openTradeRow" data-arg="${esc(t.key)}">
    <td><button class="journal-name" data-action="openTradeRow" data-arg="${esc(t.key)}" aria-label="Open the ${esc(t.label)} trade"><b>${esc(t.label)}</b></button>${open ? ' <span class="journal-tag">open</span>' : ''}</td>
    <td class="${open && !t.exits ? '' : pnlClass(t.pnl)}">${open && !t.exits ? '—' : signed$(t.pnl)}</td>
    <td>${t.r === null ? '—' : signedR(t.r)}</td>
    <td>${esc(grade || '—')}</td>
    <td>${esc(SIDE_WORDS[t.bias] || '')}</td>
    <td>${px(t.avgEntry, t.assetType)}</td>
    <td>${t.avgExit === null ? '—' : px(t.avgExit, t.assetType)}</td>
    <td>${esc(openedDay(t.openedAt))}</td>
  </tr>`;
}

function setupPage(trades, lib, key) {
  const name = lib.nameOf('setup', key), item = lib.item('setup', key);
  const mine = trades.filter(t => reviewable(t) && labelKeys(t, 'setup').includes(key))
    .sort((a, b) => (b.openedAt || '').localeCompare(a.openedAt || ''));
  const closed = countedTrades(mine);
  const open = mine.length - closed.length;
  const named = kind => k => lib.nameOf(kind, k);
  const grades = cut(mine, t => reviewOf(t).grade ? [reviewOf(t).grade] : [], g => g, GRADES);
  const tactics = cut(mine, t => labelKeys(t, 'tactic'), named('tactic'));
  const markets = cut(mine, t => reviewOf(t).market ? [reviewOf(t).market] : [], named('market'), lib.choices('market').map(i => i.key));
  const sides = cut(mine, t => [SIDE_WORDS[t.bias] || 'Long'], s => s, ['Long', 'Short', 'Neutral']);
  const mistakes = cut(mine, t => labelKeys(t, 'mistake'), named('mistake'));
  const others = cut(mine, t => labelKeys(t, 'setup').filter(k => k !== key), named('setup'));
  const shown = mine.slice(0, 100);
  return `<div class="jc-head">
      <button class="btn" data-action="closeJournalSetup">← All setups</button>
      <span class="jc-title">${esc(name)}</span>
      ${item?.own ? '<span class="journal-tag journal-tag-quiet">yours</span>' : ''}
    </div>
    <p class="hint journal-summary">${madeOf(lib, key) ? `${esc(madeOf(lib, key))} · ` : ''}${plural(closed.length, 'closed trade')}${open ? ` · ${open} open` : ''}
      · <button class="pos-link" data-action="showSetupIn" data-arg="trades">Its trades</button>
      · <button class="pos-link" data-action="showSetupIn" data-arg="stats">Full stats</button>
      · <button class="pos-link" data-action="showSetupIn" data-arg="calendar">Calendar</button>
      · <button class="pos-link" data-action="showSetupIn" data-arg="books">Model book examples</button></p>
    ${closed.length ? headline(closed) : '<p class="hint">No closed trades with this setup yet.</p>'}
    ${statTable('By setup grade', grades.rows, '', 'Grade', { withR: true })}
    ${statTable('By entry tactic', tactics.rows, noneNote(tactics.none, 'a tactic'), 'Tactic', { withR: true })}
    ${statTable('By market', markets.rows, noneNote(markets.none, 'a market'), 'Market', { withR: true })}
    ${statTable('By side', sides.rows, '', 'Side', { withR: true })}
    ${statTable('Together with', others.rows, 'The other setups on the same trades.', 'Setup', { withR: true })}
    ${statTable('Mistakes', mistakes.rows, '', 'Mistake', { withR: true })}
    ${mine.length ? `<div class="section-title js-sub">Trades</div>
    <div class="positions-wrap"><table class="positions-table journal-table">
      <thead><tr><th scope="col">Symbol</th><th scope="col">P&amp;L</th><th scope="col">R</th><th scope="col">Grade</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col">Exit</th><th scope="col">Opened</th></tr></thead>
      <tbody>${shown.map(tradeLine).join('')}</tbody>
    </table></div>${mine.length > shown.length ? `<p class="hint">The newest ${shown.length} of ${mine.length}. Its trades shows them all.</p>` : ''}` : ''}`;
}

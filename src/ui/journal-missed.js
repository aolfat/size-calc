// The Journal's Missed tab (docs/journal-notebook.md): every trade you logged as missed on the notebook's days, newest
// first under each month, found by a search box (ticker, note, setups, tactics, why) and narrowed by side, setup and
// reason (state.journalMissed); each line opens its day with it open, and ← Missed comes back. Reads journal_days.missed
// through the review data, so it works before any import.
import { marketEscape as esc } from '../core/format.js';
import { buildLibrary } from '../core/journal-labels.js';
import { allMissed, MISSED_WHY } from '../core/journal-notebook.js';
import { state } from '../state.js';
import { renderJournal } from './journal.js';
import { missedWords, openMissedOnDay } from './journal-notebook.js';

const dayLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const monthLabel = ym => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const filters = () => state.journalMissed;
const filterOn = () => { const f = filters(); return !!(f.q.trim() || f.side !== 'all' || f.setup || f.why); };

export function setMissedSearch(v) {
  filters().q = String(v || '');
  renderJournal();
  const el = document.getElementById('journalMissedSearch'); // the redraw replaced the box: keep typing in it
  if (el && el.focus) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
}
export function setMissedFilterSide(v) { filters().side = ['long', 'short'].includes(v) ? v : 'all'; renderJournal(); }
export function setMissedFilterSetup(v) { filters().setup = String(v || ''); renderJournal(); }
/** a reason chip: on, or off again when it's the one on */
export function setMissedFilterWhy(v) { filters().why = filters().why === v || !MISSED_WHY.some(([k]) => k === v) ? '' : v; renderJournal(); }
export function clearMissedFilters() { state.journalMissed = { q: '', side: 'all', setup: '', why: '' }; renderJournal(); }
/** a line: its day's page with it open, and the page's back button returns here */
export function openMissedFromList(day, id) { openMissedOnDay(day, id); state.notebookBack = 'missed'; renderJournal(); }

/** the Missed tab's body */
export function missedTabHtml() {
  const d = state.journalReview;
  if (state.journalReviewError) return `<p class="hint" role="status">Your missed trades couldn't load: ${esc(state.journalReviewError)}</p>`;
  if (!d) return '<p class="hint">Loading your missed trades…</p>';
  if (d.notebookError || d.missedError) return `<p class="hint jw-db" role="status">Missed trades need a database update: ${esc(d.missedError || d.notebookError)}</p>`;
  const lib = buildLibrary(d.library || []);
  const words = m => missedWords(lib, m);
  const every = allMissed(d.days);
  if (!every.length) return `<p class="hint">No missed trades yet. Log one on a day's page: Calendar, then tap the day.</p>`;
  const f = filters();
  // each chip and menu counts what the other filters leave, so a number says what tapping it shows
  const without = change => allMissed(d.days, { ...f, ...change }, words);
  const list = without({});
  const on = (cur, v) => `class="${cur === v ? 'active' : ''}" aria-pressed="${cur === v}"`;
  const side = (v, label) => `<button ${on(f.side, v)} data-action="setMissedFilterSide" data-arg="${v}">${label}</button>`;
  const bySetup = new Map();
  for (const m of without({ setup: '' })) for (const k of m.setups) bySetup.set(k, (bySetup.get(k) || 0) + 1);
  if (f.setup && !bySetup.has(f.setup)) bySetup.set(f.setup, 0);
  const setups = [...bySetup].map(([k, n]) => [k, lib.nameOf('setup', k, 'both'), n]).sort((a, b) => b[2] - a[2] || a[1].localeCompare(b[1]));
  const setupMenu = setups.length ? `<select id="journalMissedSetup" class="journal-setup-filter${f.setup ? ' active' : ''}" data-change="setMissedFilterSetup" aria-label="Filter by setup">
      <option value="">All setups</option>${setups.map(([k, name, n]) => `<option value="${esc(k)}"${k === f.setup ? ' selected' : ''}>${esc(name)} (${n})</option>`).join('')}
    </select>` : '';
  const forWhy = without({ why: '' });
  const whyChip = (k, w) => { const n = forWhy.filter(m => m.why === k).length; return n || f.why === k ? `<button class="journal-chip${f.why === k ? ' active' : ''}" aria-pressed="${f.why === k}" data-action="setMissedFilterWhy" data-arg="${k}">${esc(w)} <b>${n}</b></button>` : ''; };
  const whys = MISSED_WHY.map(([k, w]) => whyChip(k, w)).join('');
  const head = `<div class="journal-controls jm-controls">
    <div class="journal-filters">
      <input type="search" id="journalMissedSearch" placeholder="Search ticker, setup, note" value="${esc(f.q)}" autocomplete="off" spellcheck="false" data-input="setMissedSearch" aria-label="Search missed trades" />
      ${setupMenu}
      <div class="seg" aria-label="Side">${side('all', 'All')}${side('long', 'Long')}${side('short', 'Short')}</div>
      ${filterOn() ? '<button class="pos-link" data-action="clearMissedFilters">Clear</button>' : ''}
    </div>
    ${whys ? `<div class="journal-chips-row"><div class="journal-chips" aria-label="Why you missed it">${whys}</div></div>` : ''}
  </div>`;
  const count = `<p class="hint jm-count" role="status">${filterOn() ? `${list.length} of ${every.length} missed` : `${every.length} missed`}</p>`;
  if (!list.length) return `${head}${count}<p class="hint">None match.</p>`;
  /** @type {Map<string, any[]>} */
  const months = new Map();
  for (const m of list) { const k = m.day.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(m); }
  const line = m => {
    const what = words(m);
    return `<li><button class="nb-trade nb-miss" data-action="openMissedFromList" data-arg="${esc(m.day)}" data-arg2="${esc(m.id)}" aria-label="${esc(`${m.symbol} missed on ${dayLabel(m.day)}. Open the day`)}"><span class="nb-trade-name"><b>${esc(m.symbol)}</b>${what ? ` ${esc(what)}` : ''}${m.note ? `<span class="nb-miss-note">${esc(m.note)}</span>` : ''}</span><span class="jw-miss-day">${esc(dayLabel(m.day))}</span></button></li>`;
  };
  const sections = [...months].map(([ym, ms]) => `<div class="section-title js-sub">${esc(monthLabel(ym))} <span class="jw-optional">${ms.length}</span></div>
    <ul class="nb-trades jw-missed" aria-label="Missed in ${esc(monthLabel(ym))}">${ms.map(line).join('')}</ul>`).join('');
  return `${head}${count}<div id="journalMissedList">${sections}</div>`;
}

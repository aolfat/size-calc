// Journal notebook (docs/journal-notebook.md, slice 1): a page per trading day, opened from the calendar (every weekday)
// or today's line under the Journal's status (state.journalNotebookDay; it replaces the calendar inside the Calendar
// tab). Premarket: your last focus, a mental check-in, your goals and rules, the day's market, the plan. The day: its
// trades and realized P&L, worked out, nothing to type. Post-market: a grade, each rule kept or broken, whether you kept
// your last focus, what went well, what to work on, more notes, the day's exit notes, and tomorrow's focus. Saved on the
// day's journal_days row field by field (core/journal-notebook.js has the rules), shown at once and put back with a toast
// if Supabase refuses; text is a draft while you type and saves when the box loses focus. Goals and rules are
// library_items rows (kinds goal and rule), edited in place. Missed trades: the ones you saw and didn't take, a ticker
// each with its side, why, setup, what it would have made in R and a note (journal_days.missed, its own migration).
// The calendar's marks: plan written, reviewed, review due, how many you missed.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { buildLibrary, setupsByUse } from '../core/journal-labels.js';
import { activeItems, cleanDayRow, DAY_GRADES, DAY_TEXT, dayOver, dayReviewState, dayTrades, ENERGY, FEELINGS, FOCUS_KEPT, isDay, lastFocus, MAX_ITEM, MAX_ITEMS, MAX_MISSED, MAX_MISSED_NOTE, MISSED_SIDES, MISSED_WHY, missedR, missedSymbol, notebookLists, notebookToday, PLACES, planMissingWords, planState, reviewMissingWords, RULE_ANSWERS, rulesForDay, stepWeekday } from '../core/journal-notebook.js';
import { dailyPnl, nyParts } from '../core/journal-stats.js';
import { saveJournalDay, saveLibraryItem } from '../services/journal-review.js';
import { state } from '../state.js';
import { showError, showToast } from './feedback.js';
import { reviewedMark } from './journal-review.js';
import { journalTradeList, renderJournal } from './journal.js';

const signed$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt$(Math.abs(v))}`;
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const pnlClass = v => v > 0 ? 'journal-buy' : v < 0 ? 'journal-sell' : '';
const nowIso = () => new Date(Date.now()).toISOString();
const dayName = (day, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });

const data = () => state.journalReview;
const days = () => data()?.days || {};
const rowOf = day => days()[day] || null;
const lists = () => notebookLists(data()?.library || []);
/** the notebook can't be read or saved: the reviews didn't load, or the database doesn't have its columns yet */
const notebookOff = () => !data() || !!state.journalReviewError || !!data().notebookError;
/** the missed trades can't: the notebook can't, or the database doesn't have their column yet */
const missedOff = () => notebookOff() || !!data().missedError;
const missedOf = day => rowOf(day)?.missed || [];

// ---------- opening the page ----------

/** a day's page (a calendar cell, today's line, ‹ ›): inside the Calendar tab, the calendar on its month behind it */
export function openJournalDay(day) {
  if (!isDay(day)) return;
  Object.assign(state, { journalTab: 'calendar', journalNotebookDay: day, journalMonth: day.slice(0, 7), journalReviewPeriod: null, journalDay: '', notebookDraft: null, notebookEdit: '', notebookItemDraft: '', missedDraft: '', missedOpen: '' });
  renderJournal();
  window.scrollTo?.({ top: 0 });
}
/** ← Calendar */
export function closeJournalDay() { state.journalNotebookDay = ''; state.notebookEdit = ''; renderJournal(); }
/** ‹ or ›: the weekday before or after */
export function stepJournalDay(by) { if (state.journalNotebookDay) openJournalDay(stepWeekday(state.journalNotebookDay, Number(by) || 0)); }
/** today's line: today's page (Monday's on a weekend) */
export function openTodayNotebook() { openJournalDay(notebookToday(nowIso())); }

// ---------- where a day stands ----------

/** the rules a day asks about */
const applying = day => rulesForDay(lists().rules, day, rowOf(day));
const reviewOf = day => dayReviewState(rowOf(day), applying(day));

/**
 * A calendar cell's marks: ✎ the plan written, ✓ reviewed, an amber dot once a day with exits is over and isn't
 * reviewed, ⊘ and how many trades you missed; words for its label. Nothing while the notebook can't be read.
 */
export function dayMark(day, hasExits) {
  if (notebookOff()) return { html: '', words: '' };
  const planned = planState(rowOf(day)).written, reviewed = reviewOf(day).reviewed;
  const due = !reviewed && hasExits && dayOver(day, nowIso());
  const missed = missedOff() ? 0 : missedOf(day).length;
  const marks = `${planned ? '<span class="jc-mk jc-mk-plan">✎</span>' : ''}${reviewed ? '<span class="jc-mk jc-mk-done">✓</span>' : due ? '<span class="jc-mk jc-mk-due">●</span>' : ''}${missed ? `<span class="jc-mk jc-mk-missed">⊘${missed}</span>` : ''}`;
  const words = [planned ? 'plan written' : '', reviewed ? 'reviewed' : due ? 'review the day' : '', missed ? `${missed} missed` : ''].filter(Boolean);
  return { html: marks ? `<span class="jc-marks" aria-hidden="true">${marks}</span>` : '', words: words.length ? `, ${words.join(', ')}` : '' };
}

/** today's line under the Journal's status: write the plan, then review the day after the close */
export function todayLineHtml() {
  if (!state.session || !data() || state.journalReviewError) return '';
  const now = nowIso(), day = notebookToday(now), isToday = day === nyParts(now).day;
  const planned = planState(rowOf(day)).written, over = dayOver(day, now), reviewed = reviewOf(day).reviewed;
  const what = reviewed ? 'Day reviewed ✓' : over ? 'Review the day' : planned ? 'Plan written ✓' : 'Write your plan';
  return `<p class="hint nb-today" role="status">${isToday ? 'Today' : 'Monday'}, ${esc(dayName(day, { weekday: 'short', month: 'short', day: 'numeric' }))}: <button class="pos-link" data-action="openTodayNotebook">${what}</button></p>`;
}

// ---------- saving: shown at once, back with a toast if Supabase refuses ----------

/** the redraw replaces the page: keep the box you're in */
function redraw() {
  const id = document.activeElement?.id;
  renderJournal();
  const el = id ? document.getElementById(id) : null;
  if (el && el.focus && el !== document.activeElement) el.focus();
}

/** a day's fields; planned_at and reviewed_at go with the save that flips them */
async function saveDay(day, fields) {
  if (notebookOff() || !isDay(day)) return;
  const before = rowOf(day);
  const next = cleanDayRow({ ...before, ...fields });
  const planned = planState(next).written, reviewed = dayReviewState(next, rulesForDay(lists().rules, day, next)).reviewed;
  if (planned !== !!next.planned_at) fields = { ...fields, planned_at: next.planned_at = planned ? nowIso() : null };
  if (reviewed !== !!next.reviewed_at) fields = { ...fields, reviewed_at: next.reviewed_at = reviewed ? nowIso() : null };
  data().days[day] = next;
  redraw();
  try { await saveJournalDay(day, fields); }
  catch(e) {
    const now = data()?.days[day];
    if (now) for (const [f, v] of Object.entries(fields)) if (JSON.stringify(now[f]) === JSON.stringify(v)) now[f] = before ? before[f] : cleanDayRow(null)[f];
    showError(`Couldn't save the notebook: ${String(e?.message || e)}`);
    redraw();
  }
}

const page = () => state.journalNotebookDay;
const one = (list, v, now) => list.some(([k]) => k === v) && v !== now ? v : null; // tapping the lit one clears it

export function toggleDayFeeling(v) {
  const day = page(), now = rowOf(day)?.feelings || [];
  if (!FEELINGS.some(([k]) => k === v)) return;
  return saveDay(day, { feelings: now.includes(v) ? now.filter(f => f !== v) : [...now, v] });
}
export function setDayEnergy(v) { return saveDay(page(), { energy: one(ENERGY, v, rowOf(page())?.energy) }); }
export function setDayPlace(v) { return saveDay(page(), { place: one(PLACES, v, rowOf(page())?.place) }); }
export function setDayGrade(v) { return saveDay(page(), { grade: DAY_GRADES.includes(v) && v !== rowOf(page())?.grade ? v : null }); }
export function setDayFocusKept(v) { return saveDay(page(), { focus_kept: one(FOCUS_KEPT, v, rowOf(page())?.focus_kept) }); }
/** the day's market: the same one every trade that day inherits in its review */
export function setDayMarket(key) {
  const lib = buildLibrary(data()?.library || []);
  if (!lib.choices('market').some(i => i.key === key)) return;
  return saveDay(page(), { market: key === rowOf(page())?.market ? null : key });
}
/** a rule kept or broken that day (tapping the lit one clears it) */
export function setDayRule(key, answer) {
  const day = page(), now = { ...(rowOf(day)?.rules || {}) };
  if (!applying(day).some(r => r.key === key) || !RULE_ANSWERS.some(([v]) => v === answer)) return;
  if (now[key] === answer) delete now[key]; else now[key] = answer;
  return saveDay(day, { rules: now });
}
/** hours slept: blank clears it */
export function daySleepSave(value) {
  const s = String(value ?? '').trim(), n = Number(s);
  const hours = s === '' || !Number.isFinite(n) || n < 0 || n > 24 ? null : Math.round(n * 2) / 2;
  if (hours === (rowOf(page())?.sleep_hours ?? null)) return;
  return saveDay(page(), { sleep_hours: hours });
}

/** typing in a box: a draft (a redraw never loses it) */
export function dayTextInput(field, text) { if (page() && field in DAY_TEXT) state.notebookDraft = { day: page(), field, text }; }
/** the box lost focus: saved, unless nothing changed */
export function dayTextSave(field, text) {
  state.notebookDraft = null;
  if (!page() || !(field in DAY_TEXT)) return;
  const value = String(text || '').trim().slice(0, DAY_TEXT[field]);
  if (value === (rowOf(page())?.[field] || '')) return;
  return saveDay(page(), { [field]: value || null });
}
const textOf = (day, field) => {
  const d = state.notebookDraft;
  return d && d.day === day && d.field === field ? d.text : rowOf(day)?.[field] || '';
};

// ---------- goals and rules (library_items rows) ----------

const KINDS = { goal: 'goal', rule: 'rule' };
const newId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
const libRow = id => (data()?.library || []).find(r => r.id === id);

async function saveItem(row) {
  if (notebookOff()) return;
  const before = data().library;
  data().library = [...before.filter(r => r.id !== row.id), row];
  redraw();
  try { await saveLibraryItem(row); }
  catch(e) {
    if (data()) data().library = before;
    showError(`Couldn't save the ${row.kind}: ${String(e?.message || e)}`);
    redraw();
  }
}

/** Edit on Goals or Rules: the list opens in place (again closes it) */
export function editNotebookList(kind) {
  state.notebookEdit = state.notebookEdit === kind || !KINDS[kind] ? '' : kind;
  state.notebookItemDraft = '';
  renderJournal();
}
export function notebookItemInput(text) { state.notebookItemDraft = String(text || ''); }
/** + Add: a new goal or rule at the end of the list, from today on */
export function addNotebookItem(kind) {
  if (!KINDS[kind]) return;
  const name = state.notebookItemDraft.trim().slice(0, MAX_ITEM);
  if (!name) return;
  const items = lists()[`${kind}s`];
  if (activeItems(items).length >= MAX_ITEMS) { showError(`${MAX_ITEMS} ${kind}s at most: retire one first.`); return; }
  state.notebookItemDraft = '';
  const order = items.reduce((m, i) => Math.max(m, i.order), 0) + 1;
  return saveItem({ id: newId(), kind, name, default_key: null, hidden: false, merged_into: null, settings: { order, since: nyParts(nowIso()).day } });
}
/** reword one: its history stays with it */
export function renameNotebookItem(id, name) {
  const row = libRow(id), text = String(name || '').trim().slice(0, MAX_ITEM);
  if (!row || !text || text === row.name) { if (row && !text) redraw(); return; }
  return saveItem({ ...row, name: text });
}
/** ↑ or ↓: swap places with its neighbour */
export function moveNotebookItem(id, by) {
  const row = libRow(id);
  if (!row) return;
  const items = activeItems(lists()[`${row.kind}s`]), i = items.findIndex(x => x.id === id), j = i + (Number(by) < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= items.length) return;
  // number the whole list again, so old rows without an order fall in line
  const order = items.map(x => x.id);
  [order[i], order[j]] = [order[j], order[i]];
  const rows = order.map((rid, n) => { const r = libRow(rid); return { ...r, settings: { ...(r.settings || {}), order: n + 1 } }; });
  return Promise.all(rows.filter(r => r.settings.order !== libRow(r.id)?.settings?.order).map(saveItem));
}
/** Retire: out of the list and the daily check, its answers kept; Bring back puts it back */
export function retireNotebookItem(id) {
  const row = libRow(id);
  if (row) return saveItem({ ...row, hidden: !row.hidden });
}

// ---------- missed trades (journal_days.missed) ----------

const missedOne = id => missedOf(page()).find(m => m.id === id);
/** the whole list saved, like any of the day's fields */
function saveMissed(list) { if (!missedOff() && page()) return saveDay(page(), { missed: list }); }
function changeMissed(id, change) {
  if (missedOne(id)) return saveMissed(missedOf(page()).map(m => m.id === id ? { ...m, ...change } : m));
}

export function missedInput(text) { state.missedDraft = String(text || ''); }
/** + Add: the ticker you missed, open to fill in the rest */
export function addMissedTrade() {
  if (missedOff() || !page()) return;
  const symbol = missedSymbol(state.missedDraft), list = missedOf(page());
  if (!symbol) { showError('Type the ticker you missed, like NVDA.'); return; }
  if (list.length >= MAX_MISSED) { showError(`${MAX_MISSED} missed trades a day at most.`); return; }
  const id = newId();
  state.missedDraft = '';
  state.missedOpen = id;
  return saveMissed([...list, { id, symbol, side: null, setup: null, why: null, r: null, note: null }]);
}
/** a missed trade's line: opens it to edit (again closes it) */
export function openMissedTrade(id) { state.missedOpen = state.missedOpen === id || !missedOne(id) ? '' : id; renderJournal(); }
export function setMissedSide(id, v) { return changeMissed(id, { side: one(MISSED_SIDES, v, missedOne(id)?.side) }); }
export function setMissedWhy(id, v) { return changeMissed(id, { why: one(MISSED_WHY, v, missedOne(id)?.why) }); }
/** one of My setups, or none */
export function setMissedSetup(id, key) {
  const ok = buildLibrary(data()?.library || []).choices('setup').some(i => i.key === key);
  return changeMissed(id, { setup: ok ? key : null });
}
/** what it would have made in R: blank clears it */
export function missedRSave(id, value) {
  const r = missedR(value);
  if (r !== (missedOne(id)?.r ?? null)) return changeMissed(id, { r });
}
/** its note: a draft while you type (a redraw never loses it), saved when the box loses focus */
export function missedNoteInput(id, text) { if (page()) state.notebookDraft = { day: page(), field: `missed:${id}`, text }; }
export function missedNoteSave(id, text) {
  state.notebookDraft = null;
  const note = String(text || '').trim().slice(0, MAX_MISSED_NOTE) || null;
  if (note !== (missedOne(id)?.note ?? null)) return changeMissed(id, { note });
}
/** Remove: out at once, with Undo on the toast */
export function removeMissedTrade(id) {
  const m = missedOne(id), list = missedOf(page());
  if (!m || missedOff()) return;
  state.missedUndo = { day: page(), list };
  if (state.missedOpen === id) state.missedOpen = '';
  const saving = saveMissed(list.filter(x => x.id !== id));
  showToast(`Removed ${m.symbol}.`, '<button class="pos-link toast-act" data-action="undoRemoveMissed">Undo</button>');
  return saving;
}
export function undoRemoveMissed() {
  const u = state.missedUndo;
  state.missedUndo = null;
  if (u && u.day === page()) return saveMissed(u.list);
}

// ---------- the page ----------

const chip = (label, on, attrs, off = '') => `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" ${attrs}${off}>${esc(label)}</button>`;
const row = (label, body, missing = false, cls = '') => `<div class="jr-row${missing ? ' jr-missing' : ''}${cls ? ` ${cls}` : ''}"><div class="jr-label">${label}</div><div class="chip-row jr-chips">${body}</div></div>`;
const textRow = (label, field, day, placeholder, off, missing = false, rows = 3) => `<div class="jr-row${missing ? ' jr-missing' : ''}"><label class="jr-label" for="nb-${field}">${label}</label>
  <textarea id="nb-${field}" rows="${rows}" maxlength="${DAY_TEXT[field]}" placeholder="${esc(placeholder)}" data-input="dayTextInput" data-change="dayTextSave" data-arg="${field}"${off}>${esc(textOf(day, field))}</textarea></div>`;

/** Goals or Rules: the list, or (Edit) each one as a box with ↑ ↓ Retire, the retired ones to bring back, and + Add */
function listRow(kind, title, empty, off) {
  const items = lists()[`${kind}s`], active = activeItems(items), editing = state.notebookEdit === kind && !off;
  const edit = off ? '' : `<button class="pos-link nb-edit" data-action="editNotebookList" data-arg="${kind}">${editing ? 'Done' : 'Edit'}</button>`;
  const label = `${title} ${edit}`;
  if (!editing) {
    const body = active.length ? `<ol class="nb-list">${active.map(i => `<li>${esc(i.name)}</li>`).join('')}</ol>` : `<p class="hint nb-empty">${empty}</p>`;
    return `<div class="jr-row"><div class="jr-label">${label}</div><div>${body}</div></div>`;
  }
  const line = (i, n) => `<div class="nb-item"><input type="text" maxlength="${MAX_ITEM}" value="${esc(i.name)}" aria-label="Reword ${esc(i.name)}" data-change="renameNotebookItem" data-arg="${esc(i.id)}" />
    <button class="btn nb-move" data-action="moveNotebookItem" data-arg="${esc(i.id)}" data-arg2="-1" aria-label="Move up"${n === 0 ? ' disabled' : ''}>↑</button><button class="btn nb-move" data-action="moveNotebookItem" data-arg="${esc(i.id)}" data-arg2="1" aria-label="Move down"${n === active.length - 1 ? ' disabled' : ''}>↓</button>
    <button class="pos-link" data-action="retireNotebookItem" data-arg="${esc(i.id)}">Retire</button></div>`;
  const retired = items.filter(i => i.hidden);
  const word = kind === 'goal' ? 'goal' : 'rule';
  return `<div class="jr-row"><div class="jr-label">${label}</div><div class="nb-editing">
    ${active.map(line).join('')}
    <div class="nb-item"><input type="text" id="nbNewItem" maxlength="${MAX_ITEM}" placeholder="${kind === 'goal' ? 'Learn to abide by your rules' : 'Follow your stop'}" autocomplete="off" value="${esc(state.notebookItemDraft)}" data-input="notebookItemInput" data-enter="addNotebookItem" data-arg="${kind}" aria-label="New ${word}" /><button class="btn" data-action="addNotebookItem" data-arg="${kind}">+ Add</button></div>
    ${retired.length ? `<p class="hint nb-retired">Retired: ${retired.map(i => `${esc(i.name)} <button class="pos-link" data-action="retireNotebookItem" data-arg="${esc(i.id)}">Bring back</button>`).join(' · ')}</p>` : ''}
    <p class="hint">${kind === 'rule' ? 'Each rule is checked after the close. Retiring one keeps the days it was answered.' : 'Your goals show every morning.'}</p>
  </div></div>`;
}

function premarket(day, off) {
  const r = rowOf(day), st = planState(r), started = Object.values(st).some(Boolean) && !st.written;
  const lib = buildLibrary(data()?.library || []);
  const focus = lastFocus(days(), day);
  const status = st.written ? '<span class="jr-status journal-buy" role="status">Plan written</span>' : `<span class="jr-status" role="status">To write: ${esc(planMissingWords(st))}</span>`;
  const hours = r?.sleep_hours ?? '';
  return `<section class="jr nb-sec" aria-label="Premarket">
    <div class="jr-head"><span class="section-title js-sub">Premarket</span>${status}</div>
    ${focus ? `<p class="nb-focus"><span class="nb-focus-label">Your last focus (${esc(dayName(focus.day, { weekday: 'short', month: 'short', day: 'numeric' }))})</span> ${esc(focus.text)}</p>` : ''}
    <div class="nb-group">Mental check-in</div>
    ${row('How you feel', FEELINGS.map(([v, w]) => chip(w, !!r?.feelings.includes(v), `data-action="toggleDayFeeling" data-arg="${v}"`, off)).join(''), started && !st.feeling)}
    ${row('Sleep and energy', ENERGY.map(([v, w]) => chip(w, r?.energy === v, `data-action="setDayEnergy" data-arg="${v}"`, off)).join('')
      + `<label class="nb-hours">Slept <input type="number" id="nbSleep" min="0" max="24" step="0.5" inputmode="decimal" placeholder="—" value="${hours}" data-change="daySleepSave" aria-label="Hours slept"${off} /> h</label>`, started && !st.energy)}
    ${row("Where you're trading", PLACES.map(([v, w]) => chip(w, r?.place === v, `data-action="setDayPlace" data-arg="${v}"`, off)).join(''), started && !st.place)}
    ${listRow('goal', 'Goals', 'No goals yet. Add what you\'re working toward.', off)}
    ${listRow('rule', 'Rules', 'No rules yet. Add the ones you trade by: each gets checked after the close.', off)}
    ${row('Market <span class="jr-sub">For every trade this day</span>', lib.choices('market').map(i => chip(i.name, r?.market === i.key, `data-action="setDayMarket" data-arg="${esc(i.key)}"`, off)).join(''), started && !st.market)}
    ${textRow('Plan', 'plan', day, 'Catalysts, levels, what you will and won\'t do today', off, started && !st.plan, 4)}
  </section>`;
}

/** the day's trades and realized P&L: nothing to type, no filters */
function theDay(day, trades) {
  const list = dayTrades(trades, day), d = dailyPnl(list).get(day);
  const opened = list.filter(t => nyParts(t.openedAt).day === day).length;
  const cell = (label, value, sub = '', cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}${sub ? `<span class="pos-sub">${sub}</span>` : ''}</dd></div>`;
  const stats = list.length ? `<dl class="js-stats jc-stats">
      ${cell('Net P&amp;L', d ? signed$(d.pnl) : '—', d ? `${d.trades} with an exit` : 'no exits', d ? pnlClass(d.pnl) : '')}
      ${cell('Win rate', d && d.winRate !== null ? `${d.winRate}%` : '—', d ? `${d.wins} won, ${d.losses} lost` : '')}
      ${cell('Opened', String(opened), `trade${opened === 1 ? '' : 's'}`)}
    </dl>` : '';
  const rows = list.map(t => {
    const p = d?.byTrade[t.key];
    const side = { long: 'long', short: 'short', neutral: 'neutral' }[t.bias] || '';
    const what = t.status === 'open' ? 'open' : t.r !== null && t.r !== undefined ? signedR(t.r) : '';
    return `<li><button class="nb-trade" data-action="openTradeRow" data-arg="${esc(t.key)}"><span class="nb-trade-name"><b>${esc(t.label)}</b> ${side}${reviewedMark(t)}</span><span class="${pnlClass(p || 0)}">${p !== undefined ? signed$(p) : '—'}${what ? ` · ${what}` : ''}</span></button></li>`;
  }).join('');
  const links = d ? `<span class="nb-links"><button class="pos-link" data-action="pickJournalDay" data-arg="${day}">The day's trades</button><button class="pos-link" data-action="openJournalStats" data-arg="day" data-arg2="${day}">The day's stats</button></span>` : '';
  return `<section class="jr nb-sec" aria-label="The day">
    <div class="jr-head"><span class="section-title js-sub">The day</span>${links}</div>
    ${list.length ? `${stats}<ul class="nb-trades">${rows}</ul>` : `<p class="hint">${dayOver(day, nowIso()) ? 'No trades this day.' : 'No trades yet.'}</p>`}
  </section>`;
}

function postmarket(day, trades, off) {
  const r = rowOf(day), rules = applying(day), st = dayReviewState(r, rules);
  const started = !!(r?.grade || r?.went_well || r?.work_on || Object.keys(r?.rules || {}).length) && !st.reviewed;
  const focus = lastFocus(days(), day);
  const status = st.reviewed ? '<span class="jr-status journal-buy" role="status">Reviewed</span>' : `<span class="jr-status" role="status">To review: ${esc(reviewMissingWords(st))}</span>`;
  const ruleRows = rules.length ? `<ul class="nb-rules">${rules.map(x => `<li><span class="nb-rule-name${x.hidden ? ' nb-retired-name' : ''}">${esc(x.name)}</span><span class="chip-row jr-chips">${RULE_ANSWERS.map(([v, w]) => chip(w, r?.rules?.[x.key] === v, `data-action="setDayRule" data-arg="${esc(x.key)}" data-arg2="${v}"`, off)).join('')}</span></li>`).join('')}</ul>`
    : '<p class="hint nb-empty">No rules yet. Add them under Rules above.</p>';
  const closed = dayTrades(trades, day).filter(t => t.status !== 'open');
  const exitNotes = closed.length ? `<div class="jr-row"><div class="jr-label">From the day's trades <span class="jr-sub">their exit notes</span></div><ul class="nb-notes">${closed.map(t => {
    const note = data()?.reviews?.[t.key]?.note;
    return `<li><b>${esc(t.label)}</b> ${note ? esc(note) : `<span class="nb-none">No exit note yet</span> <button class="pos-link" data-action="openTradeRow" data-arg="${esc(t.key)}">Review</button>`}</li>`;
  }).join('')}</ul></div>` : '';
  return `<section class="jr nb-sec" aria-label="Post-market">
    <div class="jr-head"><span class="section-title js-sub">Post-market</span>${status}</div>
    ${dayOver(day, nowIso()) ? '' : '<p class="hint nb-later">For after the close.</p>'}
    ${row('Day grade', DAY_GRADES.map(g => chip(g, r?.grade === g, `data-action="setDayGrade" data-arg="${g}"`, off)).join(''), started && !st.grade)}
    <div class="jr-row${started && !st.rules ? ' jr-missing' : ''}"><div class="jr-label">Your rules</div><div>${ruleRows}</div></div>
    ${focus ? row(`Kept your last focus? <span class="jr-sub">${esc(focus.text)}</span>`, FOCUS_KEPT.map(([v, w]) => chip(w, r?.focus_kept === v, `data-action="setDayFocusKept" data-arg="${v}"`, off)).join('')) : ''}
    ${textRow('What went well', 'went_well', day, 'What you did right, what worked', off, started && !st.note, 2)}
    ${textRow('What to work on', 'work_on', day, 'What to fix, what you\'d do differently', off, started && !st.note, 2)}
    ${textRow('More notes <span class="jr-sub">optional</span>', 'note', day, 'Anything else about the day', off, false, 2)}
    ${exitNotes}
    <div class="jr-row"><label class="jr-label" for="nbFocusNext">Tomorrow's focus <span class="jr-sub">optional</span></label>
      <input type="text" class="nb-focus-input" id="nbFocusNext" maxlength="${DAY_TEXT.focus_next}" autocomplete="off" placeholder="One thing to do better next session" data-input="dayTextInput" data-change="dayTextSave" data-arg="focus_next" value="${esc(textOf(day, 'focus_next'))}"${off} /></div>
  </section>`;
}

const signedOneR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)}R`;

/** the trades you saw and didn't take: a line each (tap to edit), the open one in full, and + Add */
function missedSection(day) {
  const list = missedOf(day), lib = buildLibrary(data()?.library || []), off = missedOff() ? ' disabled' : '';
  const word = (pairs, v) => pairs.find(([k]) => k === v)?.[1] || '';
  const setupName = (key, side) => key ? lib.nameOf('setup', key, side || 'long') : '';
  const withR = list.filter(m => m.r !== null), sumR = withR.reduce((s, m) => s + m.r, 0);
  const status = list.length ? `<span class="jr-status nb-miss-count" role="status">${list.length} missed${withR.length ? ` · ${signedOneR(sumR)} not taken` : ''}</span>` : '';
  const why = state.journalReviewError || !data() || data().notebookError ? '' : data().missedError ? `<p class="hint jw-db" role="status">Missed trades need a database update: ${esc(data().missedError)}</p>` : '';
  const line = m => {
    const what = [word(MISSED_SIDES, m.side).toLowerCase(), setupName(m.setup, m.side), word(MISSED_WHY, m.why)].filter(Boolean).map(esc).join(' · ');
    const summary = `<span class="nb-trade-name"><b>${esc(m.symbol)}</b>${what ? ` ${what}` : ''}${m.note && state.missedOpen !== m.id ? `<span class="nb-miss-note">${esc(m.note)}</span>` : ''}</span><span class="${pnlClass(m.r || 0)}">${m.r !== null ? signedOneR(m.r) : ''}</span>`;
    if (state.missedOpen !== m.id || off) return `<li><button class="nb-trade nb-miss" data-action="openMissedTrade" data-arg="${esc(m.id)}" aria-label="${esc(`${m.symbol} missed. Edit`)}"${off}>${summary}</button></li>`;
    const setups = setupsByUse(lib, data()?.labels || {});
    const now = m.setup ? lib.resolve('setup', m.setup) : '';
    const note = (() => { const d = state.notebookDraft; return d && d.day === day && d.field === `missed:${m.id}` ? d.text : m.note || ''; })();
    return `<li class="nb-miss-open">
      <div class="nb-miss-head"><b>${esc(m.symbol)}</b><span class="nb-links"><button class="pos-link" data-action="removeMissedTrade" data-arg="${esc(m.id)}">Remove</button><button class="pos-link" data-action="openMissedTrade" data-arg="${esc(m.id)}">Done</button></span></div>
      ${row('Side', MISSED_SIDES.map(([v, w]) => chip(w, m.side === v, `data-action="setMissedSide" data-arg="${esc(m.id)}" data-arg2="${v}"`)).join(''))}
      ${row('Why you missed it', MISSED_WHY.map(([v, w]) => chip(w, m.why === v, `data-action="setMissedWhy" data-arg="${esc(m.id)}" data-arg2="${v}"`)).join(''))}
      ${setups.length ? row('Setup', `<select class="nb-select" id="nbMissedSetup-${esc(m.id)}" data-change="setMissedSetup" data-arg="${esc(m.id)}" aria-label="Setup"><option value="">No setup</option>${setups.map(i => `<option value="${esc(i.key)}"${i.key === now ? ' selected' : ''}>${esc(i.name)}</option>`).join('')}</select>`) : ''}
      ${row('Would have made', `<label class="nb-hours"><input type="number" id="nbMissedR-${esc(m.id)}" step="0.1" min="-100" max="100" inputmode="decimal" placeholder="—" value="${m.r ?? ''}" data-change="missedRSave" data-arg="${esc(m.id)}" aria-label="Would have made, in R" /> R</label>`)}
      <div class="jr-row"><label class="jr-label" for="nbMissedNote-${esc(m.id)}">Note <span class="jr-sub">optional</span></label>
        <input type="text" class="nb-focus-input" id="nbMissedNote-${esc(m.id)}" maxlength="${MAX_MISSED_NOTE}" autocomplete="off" placeholder="What you saw, what held you back" data-input="missedNoteInput" data-change="missedNoteSave" data-arg="${esc(m.id)}" value="${esc(note)}" /></div>
    </li>`;
  };
  return `<section class="jr nb-sec" aria-label="Missed trades">
    <div class="jr-head"><span class="section-title js-sub">Missed trades</span>${status}</div>
    ${why}
    ${list.length ? `<ul class="nb-trades nb-missed">${list.map(line).join('')}</ul>` : '<p class="hint nb-empty">Trades you saw and didn\'t take. They never count in your P&amp;L.</p>'}
    <div class="nb-item nb-miss-add"><input type="text" id="nbMissedNew" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="Ticker you missed" aria-label="Ticker you missed" value="${esc(state.missedDraft)}" data-input="missedInput" data-enter="addMissedTrade"${off} /><button class="btn" data-action="addMissedTrade"${off}>+ Add</button></div>
  </section>`;
}

/** the day's page, in place of the calendar */
export function dayPageHtml() {
  const day = page(), trades = journalTradeList();
  const off = notebookOff() ? ' disabled' : '';
  const why = state.journalReviewError ? `The notebook couldn't load: ${state.journalReviewError}`
    : !data() ? 'Loading your notebook…'
    : data().notebookError ? `The notebook needs a database update: ${data().notebookError}` : '';
  const today = notebookToday(nowIso());
  return `<div class="nb-page" id="journalDayPage" role="region" aria-label="${esc(dayName(day))}">
    <div class="jc-head nb-head">
      <button class="btn jc-today" data-action="closeJournalDay">← Calendar</button>
      <button class="btn jc-nav" data-action="stepJournalDay" data-arg="-1" aria-label="The weekday before">‹</button>
      <span class="jc-title">${esc(dayName(day))}</span>
      <button class="btn jc-nav" data-action="stepJournalDay" data-arg="1" aria-label="The weekday after">›</button>
      ${day === today ? '' : '<button class="btn jc-today" data-action="openTodayNotebook">Today</button>'}
    </div>
    ${why ? `<p class="hint jw-db" role="status">${esc(why)}</p>` : ''}
    ${premarket(day, off)}
    ${theDay(day, trades)}
    ${missedSection(day)}
    ${postmarket(day, trades, off)}
    <p class="hint">Saved as you go; notes save when you leave the box. The plan is written once it has how you feel, sleep and energy, where you're trading, the market and the plan. The day is reviewed once it has a grade, every rule answered, and what went well or what to work on.</p>
  </div>`;
}

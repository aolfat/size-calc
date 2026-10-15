// Journal review (step 3, slice 1; docs/journal-step-3.md): the Review section on the trade page (market for the day or
// this trade, sector, setups, entry tactic, tags, mistakes, the setup grade, followed the plan, a note), saved as you
// go (services/journal-review.js), with what's still missing; the reviewed mark and To review filter in the list; and the
// Library sheet (#journalLibrarySheet) to rename, hide and merge choices. core/journal-labels.js holds the rules.
import { marketEscape as esc } from '../core/format.js';
import { buildLibrary, GRADES, missingWords, parseSetup, PLAN_FOLLOWED, reviewState, setupKey, SINGLE } from '../core/journal-labels.js';
import { nyParts } from '../core/journal-stats.js';
import { addTradeLabel, loadReviewData, removeTradeLabel, saveJournalDay, saveLibraryItem, saveReviewFields } from '../services/journal-review.js';
import { state } from '../state.js';
import { showError } from './feedback.js';
import { openSheet } from './sheets.js';

const EMPTY = { reviews: {}, labels: {}, days: {}, library: [] };
const data = () => state.journalReview || EMPTY;
const library = () => buildLibrary(data().library);
/** the New York day a trade's market label belongs to: the day it opened */
const dayOf = t => t.openedAt ? nyParts(t.openedAt).day : '';

/** where a trade's review stands (core/journal-labels.js reviewState) */
export function tradeReviewState(t) {
  const d = data();
  return reviewState(d.reviews[t.key], d.labels[t.key] || [], d.days[dayOf(t)]?.market);
}

/** the list's mark: a quiet "reviewed" tag on a reviewed trade, nothing else (most are still to review) */
export const reviewedMark = t => state.journalReview && t.status !== 'history' && tradeReviewState(t).reviewed ? ' <span class="journal-tag journal-tag-done">reviewed</span>' : '';
/** the To review filter: trades with an entry that aren't reviewed yet */
export const toReview = t => t.status !== 'history' && !t.deleted && !tradeReviewState(t).reviewed;

/** read everything a review needs; a failure keeps the journal working and says why in the section */
export async function loadJournalReview() {
  try {
    state.journalReview = await loadReviewData();
    state.journalReviewError = '';
  } catch(e) {
    state.journalReviewError = String(e?.message || e);
  }
}

let rerender = () => {};
/** the trade page registers how to redraw itself after a change */
export function onReviewChange(fn) { rerender = fn; }

// ---------- saving: shown at once, back with an error if Supabase refuses ----------

async function apply(change, save) {
  if (state.journalReviewError) return;
  const before = JSON.stringify(data());
  if (!state.journalReview) state.journalReview = structuredClone(EMPTY);
  change(state.journalReview);
  rerender();
  try { await save(); }
  catch(e) {
    state.journalReview = JSON.parse(before);
    showError(`Couldn't save the review: ${String(e?.message || e)}`);
    rerender();
  }
}

/** after a change: stamp or clear reviewed_at on the trade, so "reviewed" is kept with it */
function stampReviewed(t) {
  const d = data(), rv = d.reviews[t.key] || {};
  const done = tradeReviewState(t).reviewed;
  if (done === !!rv.reviewed_at) return null;
  const at = done ? new Date().toISOString() : null;
  d.reviews[t.key] = { ...rv, reviewed_at: at };
  return { reviewed_at: at };
}

function setFields(t, fields) {
  return apply(d => { d.reviews[t.key] = { ...(d.reviews[t.key] || {}), ...fields }; }, async () => {
    const stamp = stampReviewed(t);
    await saveReviewFields(t.key, { ...fields, ...(stamp || {}) });
  });
}

function labelChange(t, add, remove) {
  return apply(d => {
    const list = (d.labels[t.key] ||= []);
    for (const [kind, value] of remove) { const i = list.findIndex(l => l.kind === kind && l.value === value); if (i >= 0) list.splice(i, 1); }
    for (const [kind, value] of add) if (!list.some(l => l.kind === kind && l.value === value)) list.push({ kind, value, set_by: 'you' });
  }, async () => {
    for (const [kind, value] of remove) await removeTradeLabel(t.key, kind, value);
    for (const [kind, value] of add) await addTradeLabel(t.key, kind, value);
    const stamp = stampReviewed(t);
    if (stamp) await saveReviewFields(t.key, stamp);
  });
}

const labelsOf = (t, kind) => (data().labels[t.key] || []).filter(l => l.kind === kind);

// ---------- the actions (each takes the trade on the page) ----------

/** a market chip: the day's market, or this trade's when "Just this trade" is on (tapping the lit one clears it) */
export function setReviewMarket(t, value) {
  const st = tradeReviewState(t);
  if (state.reviewMarketOwn || st.marketOwn) return setFields(t, { market: st.marketOwn && data().reviews[t.key]?.market === value ? null : value });
  const day = dayOf(t), now = data().days[day]?.market;
  const next = now === value ? null : value;
  return apply(d => { d.days[day] = { ...(d.days[day] || {}), market: next }; }, async () => {
    await saveJournalDay(day, { market: next });
    const stamp = stampReviewed(t);
    if (stamp) await saveReviewFields(t.key, stamp);
  });
}

/** Just this trade: the market chips set this trade's own; off again goes back to the day's */
export function toggleReviewMarketOwn(t) {
  if (tradeReviewState(t).marketOwn) { state.reviewMarketOwn = false; return setFields(t, { market: null }); }
  state.reviewMarketOwn = !state.reviewMarketOwn;
  rerender();
}

/** sector or tactic: one per trade, tapping the lit one clears it; tags and mistakes toggle */
export function toggleReviewLabel(t, kind, value) {
  const has = labelsOf(t, kind).some(l => l.value === value);
  if (SINGLE.has(kind)) return labelChange(t, has ? [] : [[kind, value]], labelsOf(t, kind).map(l => [kind, l.value]));
  return labelChange(t, has ? [] : [[kind, value]], has ? [[kind, value]] : []);
}

/** a level: picked first, then an action finishes the setup (or "just the level") */
export function pickSetupLevel(level) {
  state.reviewLevel = state.reviewLevel === level ? '' : level;
  rerender();
}
export function addSetup(t, s) {
  state.reviewLevel = '';
  return labelChange(t, [['setup', setupKey(s)]], []);
}
export const removeSetup = (t, value) => labelChange(t, [], [['setup', value]]);

export const setSetupGrade = (t, g) => setFields(t, { setup_grade: data().reviews[t.key]?.setup_grade === g ? null : g });
export const setPlanFollowed = (t, v) => setFields(t, { plan_followed: data().reviews[t.key]?.plan_followed === v ? null : v });

/** the note: kept as a draft while you type (a redraw never loses it), saved when the box loses focus */
export function reviewNoteInput(t, text) { state.reviewNoteDraft = { key: t.key, text }; }
export function reviewNoteSave(t, text) {
  state.reviewNoteDraft = null;
  const now = data().reviews[t.key]?.note || '';
  if (text.trim() === now.trim()) return;
  return setFields(t, { note: text.trim() || null });
}

/** + New: a box for your own item of that kind; Enter adds it to your library and to this trade */
export function startReviewItem(kind) { state.reviewNewKind = kind; state.reviewNewName = ''; rerender(); }
export function cancelReviewItem() { state.reviewNewKind = ''; rerender(); }
export async function saveReviewItem(t, name) {
  const kind = state.reviewNewKind;
  name = String(name || '').trim().slice(0, 80);
  if (!kind || !name) return;
  const lib = library();
  const same = (lib.byKind[kind] || []).find(i => i.name.toLowerCase() === name.toLowerCase());
  state.reviewNewKind = '';
  const key = same ? same.key : `mine:${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  if (!same) {
    const row = { id: key.slice(5), kind, name };
    await apply(d => { d.library = [...d.library, row]; }, () => saveLibraryItem(row));
  }
  // and put it on the trade, the way tapping its chip would
  if (kind === 'market') return setReviewMarket(t, key);
  if (kind === 'level') return pickSetupLevel(key);
  if (kind === 'action') return state.reviewLevel ? addSetup(t, { level: state.reviewLevel, action: key }) : rerender();
  if (kind === 'pattern') return addSetup(t, { pattern: key });
  return toggleReviewLabel(t, kind === 'tactic' || kind === 'sector' || kind === 'tag' || kind === 'mistake' ? kind : 'tag', key);
}

// ---------- the section ----------

// attrs carries the data-action written out in full at each call (a test finds every action name in the templates)
const chip = (label, on, attrs) => `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;

function newBox(kind) {
  if (state.reviewNewKind !== kind) return `<button class="pos-link jr-new" data-action="startReviewItem" data-arg="${kind}">+ New</button>`;
  return `<span class="jr-newbox"><input type="text" id="reviewNewName" maxlength="80" placeholder="Name" autocomplete="off" value="${esc(state.reviewNewName || '')}" data-input="reviewNewNameInput" data-enter="saveReviewItem" aria-label="New choice" /><button class="btn" data-action="saveReviewItem">Add</button><button class="pos-link" data-action="cancelReviewItem">Cancel</button></span>`;
}

function row(label, body, missing, cls = '') {
  return `<div class="jr-row${missing ? ' jr-missing' : ''}${cls ? ` ${cls}` : ''}"><div class="jr-label">${label}</div><div class="chip-row jr-chips">${body}</div></div>`;
}

/** the Review section for a trade (empty for one from before your history: it has no entry to review) */
export function reviewSectionHtml(t) {
  if (t.status === 'history') return '';
  if (state.journalReviewError) return `<div class="section-title js-sub">Review</div><p class="hint" style="color:var(--amber)">Reviews couldn't load: ${esc(state.journalReviewError)}</p>`;
  const lib = library(), st = tradeReviewState(t), d = data(), rv = d.reviews[t.key] || {};
  const has = (kind, key) => labelsOf(t, kind).some(l => l.value === key);
  const miss = new Set(st.missing);
  const own = state.reviewMarketOwn || st.marketOwn;
  const day = dayOf(t), dayWords = day ? `${+day.slice(5, 7)}/${+day.slice(8)}` : '';
  const market = lib.choices('market').map(i => chip(i.name, (own ? rv.market : d.days[day]?.market) === i.key, `data-action="setReviewMarket" data-arg="${esc(i.key)}"`)).join('');
  const marketNote = st.marketOwn ? `This trade only <button class="pos-link" data-action="toggleReviewMarketOwn">use ${dayWords}'s</button>`
    : `${own ? 'This trade only' : `For every trade on ${dayWords}`} · <button class="pos-link" data-action="toggleReviewMarketOwn">${own ? `back to ${dayWords}'s` : 'just this trade'}</button>`;
  const pick = kind => lib.choices(kind).map(i => chip(i.name, has(kind, i.key), `data-action="toggleReviewLabel" data-arg="${kind}" data-arg2="${esc(i.key)}"`)).join('');
  const setups = labelsOf(t, 'setup').map(l => `<span class="jr-setup">${esc(lib.nameOf('setup', l.value))}<button class="pos-link" data-action="removeSetup" data-arg="${esc(l.value)}" aria-label="Remove ${esc(lib.nameOf('setup', l.value))}">×</button></span>`).join('');
  const level = state.reviewLevel;
  const builder = level
    ? `<span class="jr-step">${esc(lib.nameOf('setup', level))} +</span>${lib.choices('action').map(i => chip(i.name, false, `data-action="addSetupAction" data-arg="${esc(i.key)}"`)).join('')}${newBox('action')}<button class="btn" data-action="addSetupLevel">Just the level</button><button class="pos-link" data-action="pickSetupLevel" data-arg="${esc(level)}">Cancel</button>`
    : `${lib.choices('level').map(i => chip(i.name, false, `data-action="pickSetupLevel" data-arg="${esc(i.key)}"`)).join('')}${newBox('level')}<span class="jr-or">or</span>${lib.choices('pattern').map(i => chip(i.name, false, `data-action="addSetupPattern" data-arg="${esc(i.key)}"`)).join('')}${newBox('pattern')}`;
  const draft = state.reviewNoteDraft && state.reviewNoteDraft.key === t.key ? state.reviewNoteDraft.text : rv.note || '';
  return `<div class="jr" id="journalReview">
    <div class="jr-head"><span class="section-title js-sub">Review</span>
      <span class="jr-status ${st.reviewed ? 'journal-buy' : ''}" role="status">${st.reviewed ? 'Reviewed' : `To review: missing ${esc(missingWords(st.missing))}`}</span>
      <button class="pos-link" data-action="openJournalLibrary">Edit choices</button></div>
    ${row(`Market <span class="jr-sub">${marketNote}</span>`, market + newBox('market'), miss.has('market'))}
    ${row('Sector', pick('sector') + newBox('sector'), miss.has('sector'))}
    ${row('Daily setups', `${setups ? `<span class="jr-setups">${setups}</span>` : ''}${builder}`, miss.has('setup'))}
    ${row('Entry tactic', pick('tactic') + newBox('tactic'), miss.has('tactic'))}
    ${row('Tags', pick('tag') + newBox('tag'))}
    ${row('Mistakes', pick('mistake') + newBox('mistake'), false, 'jr-mistakes')}
    ${row('Setup grade', GRADES.map(g => chip(g, rv.setup_grade === g, `data-action="setSetupGrade" data-arg="${g}"`)).join(''), miss.has('setup grade'))}
    ${row('Followed the plan', PLAN_FOLLOWED.map(([v, w]) => chip(w, rv.plan_followed === v, `data-action="setPlanFollowed" data-arg="${v}"`)).join(''), miss.has('plan followed'))}
    <div class="jr-row${miss.has('note') ? ' jr-missing' : ''}"><label class="jr-label" for="reviewNote">Note</label>
      <textarea id="reviewNote" rows="3" maxlength="5000" placeholder="What you saw, what you did, what you'd do again" data-input="reviewNoteInput" data-change="reviewNoteSave">${esc(draft)}</textarea></div>
  </div>`;
}

// ---------- the Library sheet ----------

const KIND_WORDS = [['market', 'Market'], ['sector', 'Sector'], ['level', 'Setup levels'], ['action', 'Setup actions'], ['pattern', 'Setup patterns'], ['tactic', 'Entry tactics'], ['tag', 'Tags'], ['mistake', 'Mistakes']];

export function renderJournalLibrary() {
  const el = document.getElementById('journalLibraryBody');
  if (!el) return;
  const lib = library();
  el.innerHTML = KIND_WORDS.map(([kind, words]) => {
    const items = lib.byKind[kind] || [];
    const rows = items.map(i => {
      const into = lib.merged.get(`${kind}:${i.key}`);
      const others = items.filter(o => o.key !== i.key && !lib.merged.has(`${kind}:${o.key}`));
      return `<div class="jl-row${i.hidden || into ? ' jl-off' : ''}"><input type="text" maxlength="80" value="${esc(i.name)}" aria-label="Rename ${esc(i.name)}" data-change="renameLibraryItem" data-arg="${kind}" data-arg2="${esc(i.key)}" />
        ${i.own ? '<span class="journal-tag journal-tag-quiet">yours</span>' : ''}
        <button class="pos-link" data-action="toggleLibraryHidden" data-arg="${kind}" data-arg2="${esc(i.key)}">${i.hidden ? 'Show' : 'Hide'}</button>
        <select aria-label="Merge ${esc(i.name)} into" data-change="mergeLibraryItem" data-arg="${kind}" data-arg2="${esc(i.key)}"><option value="">${into ? '' : 'Merge into…'}</option>${others.map(o => `<option value="${esc(o.key)}"${into === o.key ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}${into ? '<option value="__unmerge">Unmerge</option>' : ''}</select></div>`;
    }).join('');
    return `<div class="sheet-section"><div class="sheet-label">${words}</div><div class="jl-list">${rows}</div></div>`;
  }).join('') + '<p class="hint">Hidden choices stop being offered; trades already labeled keep them. Merging counts one as the other everywhere, and the old name maps to the kept one from then on.</p>';
}

export function openJournalLibrary() { renderJournalLibrary(); openSheet('journalLibrary'); }

/** the library row for an item: yours, or the one that changes a default (made when first needed) */
function libraryRow(kind, key) {
  const rows = data().library;
  if (key.startsWith('mine:')) return rows.find(r => r.id === key.slice(5));
  return rows.find(r => r.kind === kind && r.default_key === key) || { id: globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2), kind, name: library().item(kind, key)?.name || key, default_key: key, hidden: false, merged_into: null };
}

function changeLibrary(kind, key, patch) {
  const base = libraryRow(kind, key);
  if (!base) return;
  const row = { ...base, ...patch };
  return apply(d => { d.library = [...d.library.filter(r => r.id !== row.id), row]; }, () => saveLibraryItem(row)).then(() => renderJournalLibrary());
}

export const renameLibraryItem = (kind, key, name) => String(name || '').trim() ? changeLibrary(kind, key, { name: String(name).trim().slice(0, 80) }) : renderJournalLibrary();
export const toggleLibraryHidden = (kind, key) => changeLibrary(kind, key, { hidden: !library().item(kind, key)?.hidden });
export const mergeLibraryItem = (kind, key, into) => into === '__unmerge' ? changeLibrary(kind, key, { merged_into: null }) : into ? changeLibrary(kind, key, { merged_into: into }) : null;

/** a trade's labels in words, for the list and the deck later: 'Strong · 50 SMA bounce · 30-minute pivot' */
export function labelWords(t) {
  const lib = library();
  return (data().labels[t.key] || []).filter(l => l.kind !== 'mistake').map(l => lib.nameOf(l.kind, l.value)).join(' · ');
}

export { parseSetup };

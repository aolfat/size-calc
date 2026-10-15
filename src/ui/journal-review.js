// Journal review (step 3, slice 1; docs/journal-step-3.md): the Review section on the trade page (market for the day or
// this trade, sector, setups, entry tactic, tags, mistakes, the setup grade, followed the plan, a note), saved as you
// go (services/journal-review.js), with what's still missing; the reviewed mark and To review filter in the list; and the
// Library sheet (#journalLibrarySheet) to rename, hide and merge choices. core/journal-labels.js holds the rules.
import { marketEscape as esc } from '../core/format.js';
import { buildLibrary, cleanLink, GRADES, linkLabel, MAX_LINKS, missingWords, parseSetup, PLAN_FOLLOWED, reviewState, sameParts, setupFits, setupName, setupsByUse, SINGLE } from '../core/journal-labels.js';
import { nyParts } from '../core/journal-stats.js';
import { addTradeLabel, loadReviewData, removeTradeLabel, saveJournalDay, saveLabelLinks, saveLibraryItem, saveReviewFields } from '../services/journal-review.js';
import { state } from '../state.js';
import { showError } from './feedback.js';
import { openSheet } from './sheets.js';
import { shotsRowHtml } from './journal-shots.js';

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

/** one of My setups on this trade, or off it */
export const toggleSetup = (t, key) => toggleReviewLabel(t, 'setup', key);

// + New setup: what happened (an action) at what (one or more levels), or a pattern; then a name
export function startSetupDraft() { state.setupDraft = { action: '', levels: [], pattern: '', name: '' }; rerender(); }
export function cancelSetupDraft() { state.setupDraft = null; rerender(); }
export function setDraftAction(action) { const d = state.setupDraft; if (!d) return; d.action = d.action === action ? '' : action; d.pattern = ''; rerender(); }
export function setDraftPattern(pattern) { const d = state.setupDraft; if (!d) return; d.pattern = d.pattern === pattern ? '' : pattern; if (d.pattern) { d.action = ''; d.levels = []; } rerender(); }
export function toggleDraftLevel(level) {
  const d = state.setupDraft;
  if (!d) return;
  d.levels = d.levels.includes(level) ? d.levels.filter(l => l !== level) : [...d.levels, level];
  d.pattern = '';
  rerender();
}
export function setupDraftNameInput(name) { if (state.setupDraft) state.setupDraft.name = name; }
/** the setup you already have, from the builder: on the trade, builder closed */
export function useSetupDraftMatch(t, key) {
  state.setupDraft = null;
  if (labelsOf(t, 'setup').some(l => l.value === key)) return rerender();
  return labelChange(t, [['setup', key]], []);
}

/** Save to my setups and add: a setup made of the same things (or named the same) is reused, not made twice */
export async function saveSetupDraft(t) {
  const d = state.setupDraft, lib = library();
  if (!d) return;
  const parts = d.pattern ? { pattern: d.pattern } : { action: d.action, levels: d.levels };
  if (!parts.pattern && !(parts.action && parts.levels.length)) return;
  const name = (d.name.trim() || setupName(lib, parts)).slice(0, 80);
  const same = lib.choices('setup').find(i => i.name.toLowerCase() === name.toLowerCase() || sameParts(lib.parts(i.key), parts));
  state.setupDraft = null;
  let key = same?.key;
  if (!key) {
    const row = { id: newId(), kind: 'setup', name, settings: parts };
    key = `mine:${row.id}`;
    await apply(dd => { dd.library = [...dd.library, row]; }, () => saveLibraryItem(row));
  }
  if (!labelsOf(t, 'setup').some(l => l.value === key)) return labelChange(t, [['setup', key]], []);
  rerender();
}

const newId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

// ---------- links on a tag: Option flow's Unusual Whales / Bullflow pages ----------

/** the label a link box belongs to (a tag on this trade) */
const tagLabel = (t, value) => labelsOf(t, 'tag').find(l => l.value === value);
export function reviewLinkInput(text) { state.reviewLinkDraft = text; }
/** paste a link and Add (or Enter): https only, ten at most, the same one once */
export function addReviewLink(t, value, raw) {
  const url = cleanLink(raw ?? state.reviewLinkDraft);
  if (!url) { showError('Paste a link that starts with https://'); return; }
  const l = tagLabel(t, value);
  if (!l) return;
  const links = [...(l.links || [])];
  state.reviewLinkDraft = '';
  if (links.includes(url)) return rerender();
  if (links.length >= MAX_LINKS) { showError(`Ten links at most on a tag.`); return; }
  return setLinks(t, value, [...links, url]);
}
export function removeReviewLink(t, value, index) {
  const l = tagLabel(t, value);
  if (!l) return;
  return setLinks(t, value, (l.links || []).filter((_, i) => i !== Number(index)));
}
function setLinks(t, value, links) {
  return apply(d => { const l = (d.labels[t.key] || []).find(x => x.kind === 'tag' && x.value === value); if (l) l.links = links; }, () => saveLabelLinks(t.key, 'tag', value, links));
}

/** under a lit Option flow tag (or any tag that has links): its links as chips, and a box to paste another */
function linksHtml(t, lib) {
  return labelsOf(t, 'tag').filter(l => lib.resolve('tag', l.value) === 'option_flow' || (l.links || []).length).map(l => {
    const chips = (l.links || []).map((url, i) => `<span class="jr-link"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(linkLabel(url))} ↗</a><button class="pos-link" data-action="removeReviewLink" data-arg="${esc(l.value)}" data-arg2="${i}" aria-label="Remove the ${esc(linkLabel(url))} link">×</button></span>`).join('');
    return `<div class="jr-links"><span class="jr-draft-q">${esc(lib.nameOf('tag', l.value))} links</span>${chips}
      <input type="url" id="reviewLinkInput" inputmode="url" autocomplete="off" placeholder="Paste an Unusual Whales or Bullflow link" value="${esc(state.reviewLinkDraft || '')}" data-input="reviewLinkInput" data-enter="addReviewLink" data-arg="${esc(l.value)}" aria-label="Add a link" />
      <button class="btn" data-action="addReviewLink" data-arg="${esc(l.value)}">Add</button></div>`;
  }).join('');
}

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
  const key = same ? same.key : `mine:${newId()}`;
  if (!same) {
    const row = { id: key.slice(5), kind, name };
    await apply(d => { d.library = [...d.library, row]; }, () => saveLibraryItem(row));
  }
  // and put it on the trade, the way tapping its chip would
  if (kind === 'market') return setReviewMarket(t, key);
  // inside + New setup: a new level, action or pattern goes into the setup being made
  if (kind === 'level') return toggleDraftLevel(key);
  if (kind === 'action') return setDraftAction(key);
  if (kind === 'pattern') return setDraftPattern(key);
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
  // My setups: the ones on this trade (any, even hidden), then the rest, most used first; while + New setup is open,
  // only the ones that fit what's picked so far, so you tap one you have before making another
  const on = labelsOf(t, 'setup').map(l => l.value);
  const sd = state.setupDraft;
  const picking = !!sd && !!(sd.action || sd.levels.length || sd.pattern);
  const offered = setupsByUse(lib, d.labels).filter(i => !on.includes(i.key) && (!picking || setupFits(lib, i.key, sd)));
  const mySetups = [...on.map(k => chip(lib.nameOf('setup', k), true, `data-action="toggleSetup" data-arg="${esc(k)}" title="${esc(lib.partsWords(lib.parts(k)))}"`)),
    ...offered.map(i => chip(i.name, false, `data-action="toggleSetup" data-arg="${esc(i.key)}" title="${esc(lib.partsWords(lib.parts(i.key)))}"`))].join('');
  const fitNote = picking ? `<span class="jr-fit">${offered.length ? 'My setups that fit:' : 'None of My setups fit yet.'}</span>` : '';
  const builder = state.setupDraft ? setupDraftHtml(lib, t) : '<button class="pos-link jr-new" data-action="startSetupDraft">+ New setup</button>';
  const draft = state.reviewNoteDraft && state.reviewNoteDraft.key === t.key ? state.reviewNoteDraft.text : rv.note || '';
  return `<div class="jr" id="journalReview">
    <div class="jr-head"><span class="section-title js-sub">Review</span>
      <span class="jr-status ${st.reviewed ? 'journal-buy' : ''}" role="status">${st.reviewed ? 'Reviewed' : `To review: missing ${esc(missingWords(st.missing))}`}</span>
      <button class="pos-link" data-action="openJournalLibrary">Edit choices</button></div>
    ${row(`Market <span class="jr-sub">${marketNote}</span>`, market + newBox('market'), miss.has('market'))}
    ${row('Sector', pick('sector') + newBox('sector'), miss.has('sector'))}
    ${row('My setups', `${fitNote}${mySetups}${builder}`, miss.has('setup'))}
    ${row('Entry tactic', pick('tactic') + newBox('tactic'), miss.has('tactic'))}
    ${row('Tags', pick('tag') + newBox('tag') + linksHtml(t, lib))}
    ${row('Mistakes', pick('mistake') + newBox('mistake'), false, 'jr-mistakes')}
    ${row('Setup grade', GRADES.map(g => chip(g, rv.setup_grade === g, `data-action="setSetupGrade" data-arg="${g}"`)).join(''), miss.has('setup grade'))}
    ${row('Followed the plan', PLAN_FOLLOWED.map(([v, w]) => chip(w, rv.plan_followed === v, `data-action="setPlanFollowed" data-arg="${v}"`)).join(''), miss.has('plan followed'))}
    <div class="jr-row${miss.has('note') ? ' jr-missing' : ''}"><label class="jr-label" for="reviewNote">Note</label>
      <textarea id="reviewNote" rows="3" maxlength="5000" placeholder="What you saw, what you did, what you'd do again" data-input="reviewNoteInput" data-change="reviewNoteSave">${esc(draft)}</textarea></div>
    ${shotsRowHtml(t)}
  </div>`;
}

/** + New setup: what happened, at what (or a pattern), and the name it gets; one you already have says so instead */
function setupDraftHtml(lib, t) {
  const d = state.setupDraft;
  const parts = d.pattern ? { pattern: d.pattern } : { action: d.action, levels: d.levels };
  const auto = setupName(lib, parts);
  const ready = !!auto;
  const have = ready ? lib.choices('setup').find(i => sameParts(lib.parts(i.key), parts)) : null;
  const onTrade = have && labelsOf(t, 'setup').some(l => lib.resolve('setup', l.value) === have.key);
  const finish = have
    ? `<span class="jr-have">${onTrade ? `Already on this trade: <b>${esc(have.name)}</b>` : `Already in My setups: ${chip(have.name, false, `data-action="useSetupDraftMatch" data-arg="${esc(have.key)}"`)} tap it to add`}</span><button class="pos-link" data-action="cancelSetupDraft">Close</button>`
    : `<button class="btn primary" data-action="saveSetupDraft"${ready ? '' : ' disabled'}>Save to my setups and add</button><button class="pos-link" data-action="cancelSetupDraft">Cancel</button>`;
  return `<div class="jr-draft">
      <div class="jr-draft-row"><span class="jr-draft-q">What happened?</span>${lib.choices('action').map(i => chip(i.name.replace(/^./, c => c.toUpperCase()), d.action === i.key, `data-action="setDraftAction" data-arg="${esc(i.key)}"`)).join('')}${newBox('action')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">At what?</span>${lib.choices('level').map(i => chip(i.name, d.levels.includes(i.key), `data-action="toggleDraftLevel" data-arg="${esc(i.key)}"`)).join('')}${newBox('level')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">Or a pattern</span>${lib.choices('pattern').map(i => chip(i.name, d.pattern === i.key, `data-action="setDraftPattern" data-arg="${esc(i.key)}"`)).join('')}${newBox('pattern')}</div>
      <div class="jr-draft-row">${have ? '' : `<label class="jr-draft-q" for="setupDraftName">Name</label><input type="text" id="setupDraftName" maxlength="80" autocomplete="off" placeholder="${esc(auto || 'Pick what happened and at what')}" value="${esc(d.name)}" data-input="setupDraftNameInput" data-enter="saveSetupDraft" />`}
        ${finish}</div>
    </div>`;
}

// ---------- the Library sheet ----------

const KIND_WORDS = [['setup', 'My setups'], ['market', 'Market'], ['sector', 'Sector'], ['level', 'Levels'], ['action', 'What happened'], ['pattern', 'Patterns'], ['tactic', 'Entry tactics'], ['tag', 'Tags'], ['mistake', 'Mistakes']];

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
        ${kind === 'setup' ? `<span class="jl-parts">${esc(lib.partsWords(lib.parts(i.key)))}</span>` : ''}${i.own ? '<span class="journal-tag journal-tag-quiet">yours</span>' : ''}
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

/** a trade's setups as the list shows them: [{ key, name }], merges followed, in the order they were added */
export function setupsOf(t) {
  if (!state.journalReview) return [];
  const lib = library();
  const seen = new Set();
  return (data().labels[t.key] || []).filter(l => l.kind === 'setup').map(l => lib.resolve('setup', l.value))
    .filter(k => !seen.has(k) && seen.add(k)).map(key => ({ key, name: lib.nameOf('setup', key) }));
}

/** the setups these trades carry, most used first, for the list's filter: [{ key, name, count }] */
export function setupsInUse(trades) {
  /** @type {Map<string, { key: string, name: string, count: number }>} */
  const by = new Map();
  for (const t of trades) for (const s of setupsOf(t)) { const c = by.get(s.key) || { ...s, count: 0 }; c.count++; by.set(s.key, c); }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** a trade's labels in words, for the list and the deck later: 'Strong · 50 SMA bounce · 30-minute pivot' */
export function labelWords(t) {
  const lib = library();
  return (data().labels[t.key] || []).filter(l => l.kind !== 'mistake').map(l => lib.nameOf(l.kind, l.value)).join(' · ');
}

export { parseSetup };

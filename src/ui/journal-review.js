// Journal review (step 3, slice 1; docs/journal-step-3.md): the Review section on the trade page (market for the day or
// this trade, sector, setups, entry tactic, tags, an entry note, mistakes, the setup grade, followed the plan, an exit
// note), saved as you
// go (services/journal-review.js), with what's still missing; the reviewed mark and To review filter in the list; and the
// Library sheet (#journalLibrarySheet) to rename, hide and merge choices, and edit what a setup is made of. core/journal-labels.js holds the rules.
import { marketEscape as esc } from '../core/format.js';
import { buildLibrary, cleanLink, deckQueue, fromReviewDay, GRADES, linkLabel, MAX_LINKS, missingWords, OPENING_PASS, parseSetup, PLAN_FOLLOWED, reviewFromDay, reviewPass, reviewState, sameParts, setupFits, setupGroups, setupName, setupsByUse, setupTwin, shortTwin, SINGLE, BUILT_IN_MERGES, tradeSide } from '../core/journal-labels.js';
import { nyParts } from '../core/journal-stats.js';
import { store } from '../lib/store.js';
import { addTradeLabel, deleteLibraryItem, loadReviewData, removeTradeLabel, saveJournalDay, saveLabelLinks, saveLibraryItem, saveReviewFields } from '../services/journal-review.js';
import { state } from '../state.js';
import { showError } from './feedback.js';
import { openSheet } from './sheets.js';
import { shotsRowHtml } from './journal-shots.js';

const EMPTY = { reviews: {}, labels: {}, days: {}, library: [], weekly: {}, weeklyError: '', entryNoteError: '', notebookError: '', missedError: '' };
const data = () => state.journalReview || EMPTY;
const library = () => buildLibrary(data().library);
/** the New York day a trade's market label belongs to: the day it opened */
const dayOf = t => t.openedAt ? nyParts(t.openedAt).day : '';

/** where a trade's review stands (core/journal-labels.js reviewState) */
export function tradeReviewState(t) {
  const d = data();
  return reviewState(d.reviews[t.key], d.labels[t.key] || [], d.days[dayOf(t)]?.market);
}

/** the list's marks: a quiet "reviewed" tag on a reviewed trade (most are still to review), and "for weekly" on one saved for the weekly review */
export const reviewedMark = t => !state.journalReview || t.status === 'history' ? ''
  : `${tradeReviewState(t).reviewed ? ' <span class="journal-tag journal-tag-done">reviewed</span>' : ''}${savedForWeekly(t) ? ' <span class="journal-tag journal-tag-quiet">for weekly</span>' : ''}`;
/** the pass a trade needs (core/journal-labels.js reviewPass): opening while it's open, the plan, grade and exit note once it closes */
export const tradePass = t => reviewPass(t, tradeReviewState(t));
/** the day reviewing starts from (journal_review_from, synced with your account): trades opened before it leave the deck; '' = every day */
export const reviewFrom = () => reviewFromDay(store.get('journal_review_from'));
/** the To review filter: the trades the review deck would show (an open trade with its opening pass done waits for its close) */
export const toReview = t => fromReviewDay(t, reviewFrom()) && !!tradePass(t);
/** the review deck's queue, newest first, from the review-from day; empty until the reviews have been read */
export const reviewQueue = trades => state.journalReview && !state.journalReviewError ? deckQueue(trades, tradeReviewState, reviewFrom()) : [];
/** saved for the weekly review (trade_reviews.weekly_at) */
export const savedForWeekly = t => !!data().weekly?.[t.key];

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

/** shown at once, saved after; true when it saved, false when it came back (or couldn't start) */
async function apply(change, save) {
  if (state.journalReviewError) return false;
  const before = JSON.stringify(data());
  if (!state.journalReview) state.journalReview = structuredClone(EMPTY);
  change(state.journalReview);
  rerender();
  try { await save(); return true; }
  catch(e) {
    state.journalReview = JSON.parse(before);
    showError(`Couldn't save the review: ${String(e?.message || e)}`);
    rerender();
    return false;
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

/** labels off and on a trade, in what's shown */
function editLabels(d, t, add, remove) {
  const list = (d.labels[t.key] ||= []);
  for (const [kind, value] of remove) { const i = list.findIndex(l => l.kind === kind && l.value === value); if (i >= 0) list.splice(i, 1); }
  for (const [kind, value] of add) if (!list.some(l => l.kind === kind && l.value === value)) list.push({ kind, value, set_by: 'you' });
}
/** the same, saved, and reviewed_at stamped or cleared */
async function saveLabelEdits(t, add, remove) {
  for (const [kind, value] of remove) await removeTradeLabel(t.key, kind, value);
  for (const [kind, value] of add) await addTradeLabel(t.key, kind, value);
  const stamp = stampReviewed(t);
  if (stamp) await saveReviewFields(t.key, stamp);
}

function labelChange(t, add, remove) {
  return apply(d => editLabels(d, t, add, remove), () => saveLabelEdits(t, add, remove));
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

/** sector: one per trade, tapping the lit one clears it; setups, tactics, tags and mistakes toggle */
export function toggleReviewLabel(t, kind, value) {
  const has = labelsOf(t, kind).some(l => l.value === value);
  if (SINGLE.has(kind)) return labelChange(t, has ? [] : [[kind, value]], labelsOf(t, kind).map(l => [kind, l.value]));
  return labelChange(t, has ? [] : [[kind, value]], has ? [[kind, value]] : []);
}

/** one of My setups on this trade, or off it */
export const toggleSetup = (t, key) => toggleReviewLabel(t, 'setup', key);

// + New setup: what happened (an action) at what (one or more levels), or a pattern. There's no Save: each tap puts the
// setup those parts make on the trade, one of My setups made of the same things or else a new one named for them, and the
// next tap changes it (21 EMA, then Support too, makes it the 21 EMA + Support one). The draft keeps the setup it put on
// (key) and the one it made (made): one it made that the parts move off goes back out of My setups, so trying a few taps
// leaves nothing behind. A name is typed in Edit setups.
export function startSetupDraft() { state.setupDraft = { action: '', levels: [], pattern: '', key: '', made: '' }; rerender(); }
/** Done: the builder closes; what it put on the trade stays */
export function cancelSetupDraft() { state.setupDraft = null; rerender(); }
export function setDraftAction(t, action) { const d = state.setupDraft; if (!d) return; d.action = d.action === action ? '' : action; d.pattern = ''; return syncSetupDraft(t); }
export function setDraftPattern(t, pattern) { const d = state.setupDraft; if (!d) return; d.pattern = d.pattern === pattern ? '' : pattern; if (d.pattern) { d.action = ''; d.levels = []; } return syncSetupDraft(t); }
export function toggleDraftLevel(t, level) {
  const d = state.setupDraft;
  if (!d) return;
  d.levels = d.levels.includes(level) ? d.levels.filter(l => l !== level) : [...d.levels, level];
  d.pattern = '';
  return syncSetupDraft(t);
}
const draftParts = d => d.pattern ? { pattern: d.pattern } : { action: d.action, levels: d.levels };

// one tap's saves wait for the last one's, so a quick second tap can't delete a setup before the first has written it
let draftSaves = Promise.resolve();

/** the trade gets the setup the picked parts make, in place of the one the builder put on before */
function syncSetupDraft(t) {
  const d = state.setupDraft, lib = library();
  if (!d || !t) return rerender();
  // a setup it made stops being the builder's once another trade carries it
  if (d.made && Object.entries(data().labels).some(([k, list]) => k !== t.key && list.some(l => l.kind === 'setup' && l.value === d.made))) d.made = '';
  const parts = draftParts(d), name = setupName(lib, parts);
  const made = d.made ? data().library.find(r => `mine:${r.id}` === d.made) || null : null;
  const have = name ? lib.choices('setup').find(i => i.key !== d.made && sameParts(lib.parts(i.key), parts)) : null;
  const row = name && !have ? { ...(made || { id: newId(), kind: 'setup' }), name, settings: parts } : null;
  const drop = made && !row ? made : null;
  const target = have ? have.key : row ? `mine:${row.id}` : '';
  const already = !!target && target !== d.key && labelsOf(t, 'setup').some(l => lib.resolve('setup', l.value) === target);
  const remove = d.key && d.key !== target ? [['setup', d.key]] : [];
  const add = target && target !== d.key && !already ? [['setup', target]] : [];
  const before = { key: d.key, made: d.made };
  d.key = already ? '' : target;
  d.made = row ? target : '';
  if (!row && !drop && !add.length && !remove.length) return rerender();
  return apply(dd => {
    if (row) dd.library = [...dd.library.filter(r => r.id !== row.id), row];
    editLabels(dd, t, add, remove);
    if (drop) dd.library = dd.library.filter(r => r.id !== drop.id);
  }, () => (draftSaves = draftSaves.catch(() => {}).then(async () => {
    if (row) await saveLibraryItem(row);
    await saveLabelEdits(t, add, remove);
    if (drop) await deleteLibraryItem(drop.id);
  }))).then(ok => { if (!ok && state.setupDraft === d) Object.assign(d, before); });
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
    // checked again here: a row written around the app could hold a javascript: link; i stays the row's own index
    const chips = (l.links || []).map((url, i) => !cleanLink(url) ? '' : `<span class="jr-link"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">${esc(linkLabel(url))} ↗</a><button class="pos-link" data-action="removeReviewLink" data-arg="${esc(l.value)}" data-arg2="${i}" aria-label="Remove the ${esc(linkLabel(url))} link">×</button></span>`).join('');
    return `<div class="jr-links"><span class="jr-draft-q">${esc(lib.nameOf('tag', l.value))} links</span>${chips}
      <input type="url" id="reviewLinkInput" inputmode="url" autocomplete="off" placeholder="Paste an Unusual Whales or Bullflow link" value="${esc(state.reviewLinkDraft || '')}" data-input="reviewLinkInput" data-enter="addReviewLink" data-arg="${esc(l.value)}" aria-label="Add a link" />
      <button class="btn" data-action="addReviewLink" data-arg="${esc(l.value)}">Add</button></div>`;
  }).join('');
}

/** Save for the weekly review: weekly_at stamped, or cleared again; before the migration it says it needs it */
export function toggleWeekly(t) {
  if (data().weeklyError) { showError(`Saving for the weekly review needs a database update: ${data().weeklyError}`); return; }
  const at = savedForWeekly(t) ? null : new Date().toISOString();
  return apply(d => { d.weekly = { ...(d.weekly || {}) }; if (at) d.weekly[t.key] = at; else delete d.weekly[t.key]; }, () => saveReviewFields(t.key, { weekly_at: at }));
}

export const setSetupGrade = (t, g) => setFields(t, { setup_grade: data().reviews[t.key]?.setup_grade === g ? null : g });
export const setPlanFollowed = (t, v) => setFields(t, { plan_followed: data().reviews[t.key]?.plan_followed === v ? null : v });

/** the two notes: 'entry' (entry_note, optional, written while it's live) and 'exit' (note, what a review needs) */
const NOTE_FIELD = { entry: 'entry_note', exit: 'note' };
const noteField = which => NOTE_FIELD[which] || 'note';

/** a note: kept as a draft while you type (a redraw never loses it), saved when the box loses focus */
export function reviewNoteInput(t, text, which = 'exit') { state.reviewNoteDraft = { key: t.key, which, text }; }
export function reviewNoteSave(t, text, which = 'exit') {
  state.reviewNoteDraft = null;
  const field = noteField(which);
  const now = data().reviews[t.key]?.[field] || '';
  if (text.trim() === now.trim()) return;
  if (field === 'entry_note' && data().entryNoteError) { showError(`Entry notes need a database update: ${data().entryNoteError}`); return; }
  return setFields(t, { [field]: text.trim() || null });
}
/** what a note box shows: the draft being typed, else what's saved */
const noteText = (t, which) => {
  const d = state.reviewNoteDraft;
  return d && d.key === t.key && (d.which || 'exit') === which ? d.text : data().reviews[t.key]?.[noteField(which)] || '';
};

/** + New: a box for your own item of that kind; Enter adds it to your library and to this trade */
export function startReviewItem(kind) { state.reviewNewKind = kind; state.reviewNewName = ''; state.reviewNewShort = ''; rerender(); }
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
    // an action or pattern takes its words on a short from the box beside it (blank: a breakout's is a breakdown, else the same)
    const short = (kind === 'action' || kind === 'pattern') && String(state.reviewNewShort || '').trim().slice(0, 80);
    const row = { id: key.slice(5), kind, name, ...(short ? { settings: { short } } : {}) };
    await apply(d => { d.library = [...d.library, row]; }, () => saveLibraryItem(row));
  }
  // and put it on the trade, the way tapping its chip would
  if (kind === 'market') return setReviewMarket(t, key);
  // inside + New setup: a new level, action or pattern goes into the setup being made
  if (kind === 'level') return toggleDraftLevel(t, key);
  if (kind === 'action') return setDraftAction(t, key);
  if (kind === 'pattern') return setDraftPattern(t, key);
  const k = kind === 'tactic' || kind === 'sector' || kind === 'tag' || kind === 'mistake' ? kind : 'tag';
  // a name already on the trade stays on it (tapping its chip would take it off)
  if (labelsOf(t, k).some(l => l.value === key)) return rerender();
  return toggleReviewLabel(t, k, key);
}

// ---------- the section ----------

// attrs carries the data-action written out in full at each call (a test finds every action name in the templates)
const chip = (label, on, attrs) => `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;

function newBox(kind) {
  if (state.reviewNewKind !== kind) return `<button class="pos-link jr-new" data-action="startReviewItem" data-arg="${kind}">+ New</button>`;
  // an action or pattern asks for its words on a short too: a breakout on a short is a breakdown
  const short = kind === 'action' || kind === 'pattern'
    ? `<input type="text" id="reviewNewShort" maxlength="80" placeholder="On a short" autocomplete="off" value="${esc(state.reviewNewShort || '')}" data-input="reviewNewShortInput" data-enter="saveReviewItem" aria-label="Its words on a short" />` : '';
  return `<span class="jr-newbox"><input type="text" id="reviewNewName" maxlength="80" placeholder="Name" autocomplete="off" value="${esc(state.reviewNewName || '')}" data-input="reviewNewNameInput" data-enter="saveReviewItem" aria-label="New choice" />${short}<button class="btn" data-action="saveReviewItem">Add</button><button class="pos-link" data-action="cancelReviewItem">Cancel</button></span>`;
}

function row(label, body, missing, cls = '') {
  return `<div class="jr-row${missing ? ' jr-missing' : ''}${cls ? ` ${cls}` : ''}"><div class="jr-label">${label}</div><div class="chip-row jr-chips">${body}</div></div>`;
}

/** the Review section for a trade (empty for one from before your history: it has no entry to review) */
export function reviewSectionHtml(t) {
  if (t.status === 'history') return '';
  if (state.journalReviewError) return `<div class="section-title js-sub">Review</div><p class="hint" style="color:var(--amber)">Reviews couldn't load: ${esc(state.journalReviewError)}</p>`;
  const lib = library(), st = tradeReviewState(t), d = data(), rv = d.reviews[t.key] || {};
  const side = tradeSide(t); // setups read in this trade's words: a short's bounce is a rejection
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
  // (a label on a setup merged away counts as the kept one: shown once, and the kept one isn't offered again)
  const kept = new Set();
  const on = labelsOf(t, 'setup').map(l => l.value).filter(v => { const k = lib.resolve('setup', v); return !kept.has(k) && kept.add(k); });
  const sd = state.setupDraft;
  const picking = !!sd && !!(sd.action || sd.levels.length || sd.pattern);
  const offered = setupsByUse(lib, d.labels).filter(i => !kept.has(i.key) && (!picking || setupFits(lib, i.key, sd)));
  const mySetups = [...on.map(k => chip(lib.nameOf('setup', k, side), true, `data-action="toggleSetup" data-arg="${esc(k)}" title="${esc(lib.partsWords(lib.parts(k), side))}"`)),
    ...offered.map(i => chip(lib.nameOf('setup', i.key, side), false, `data-action="toggleSetup" data-arg="${esc(i.key)}" title="${esc(lib.partsWords(lib.parts(i.key), side))}"`))].join('');
  // what each setup on the trade is made of: Action Bounce · Level 8 EMA (a pattern says so)
  const partsLine = on.length && !sd ? `<div class="jr-parts">${on.map(k => {
    const g = setupGroups(lib, lib.resolve('setup', k), side), lvl = g.levels.map(l => l.name).join(', ');
    const bits = g.kind && !g.kind.action ? [`Pattern <b>${esc(g.kind.name)}</b>`]
      : [...(g.kind ? [`Action <b>${esc(g.kind.name)}</b>`] : []), ...(lvl ? [`Level${g.levels.length > 1 ? 's' : ''} <b>${esc(lvl)}</b>`] : [])];
    return `<span>${on.length > 1 ? `${esc(lib.nameOf('setup', k, side))}: ` : ''}${bits.join(' · ')}</span>`;
  }).join('')}</div>` : '';
  // once the parts make a setup it's on the trade, so there's nothing left to say about fitting
  const fitNote = picking && !setupName(lib, draftParts(sd)) ? `<span class="jr-fit">${offered.length ? 'My setups that fit:' : 'None of My setups fit yet.'}</span>` : '';
  const builder = state.setupDraft ? setupDraftHtml(lib, t) : '<button class="pos-link jr-new" data-action="startSetupDraft">+ New setup</button><button class="pos-link jr-new" data-action="openJournalLibrary">Edit setups</button>';
  // while it's live: the opening pass is what's asked; the plan and exit note wait for the close (shown if already in)
  const open = t.status === 'open';
  const openingMissing = st.missing.filter(m => OPENING_PASS.includes(m));
  const status = st.reviewed ? 'Reviewed'
    : open ? (openingMissing.length ? `Opening pass: missing ${esc(missingWords(openingMissing))}` : 'Opening pass done. The rest after the close')
    : `To review: missing ${esc(missingWords(st.missing))}`;
  const later = open && !rv.plan_followed && !rv.note?.trim();
  const entryOff = d.entryNoteError ? ' disabled' : '';
  return `<div class="jr" id="journalReview">
    <div class="jr-head"><span class="section-title js-sub">Review</span>
      <span class="jr-status ${st.reviewed || (open && !openingMissing.length) ? 'journal-buy' : ''}" role="status">${status}</span>
      <button class="pos-link" data-action="openJournalLibrary">Edit choices</button></div>
    ${row(`Market <span class="jr-sub">${marketNote}</span>`, market + newBox('market'), miss.has('market'))}
    ${row('Sector', pick('sector') + newBox('sector'), miss.has('sector'))}
    ${row('My setups', `${fitNote}${mySetups}${builder}${partsLine}`, miss.has('setup'))}
    ${row('Entry tactic', pick('tactic') + newBox('tactic'), miss.has('tactic'))}
    ${row('Tags', pick('tag') + newBox('tag') + linksHtml(t, lib))}
    <div class="jr-row"><label class="jr-label" for="entryNote">Entry note <span class="jr-sub">optional</span></label>
      <div><textarea id="entryNote" rows="2" maxlength="5000" placeholder="Why you're in, the plan, what proves it wrong" data-input="reviewNoteInput" data-change="reviewNoteSave" data-arg="entry"${entryOff}>${esc(noteText(t, 'entry'))}</textarea>
      ${d.entryNoteError ? `<p class="hint jr-later" style="color:var(--amber)">Entry notes need a database update: ${esc(d.entryNoteError)}</p>` : ''}</div></div>
    ${row('Mistakes', pick('mistake') + newBox('mistake'), false, 'jr-mistakes')}
    ${row('Setup grade', GRADES.map(g => chip(g, rv.setup_grade === g, `data-action="setSetupGrade" data-arg="${g}"`)).join(''), !open && miss.has('setup grade'))}
    ${later ? '<div class="jr-row"><div class="jr-label">After the close</div><p class="hint jr-later">Followed the plan and the exit note: the deck brings this trade back when it closes.</p></div>'
      : `${row('Followed the plan', PLAN_FOLLOWED.map(([v, w]) => chip(w, rv.plan_followed === v, `data-action="setPlanFollowed" data-arg="${v}"`)).join(''), !open && miss.has('plan followed'))}
    <div class="jr-row${!open && miss.has('exit note') ? ' jr-missing' : ''}"><label class="jr-label" for="reviewNote">Exit note</label>
      <textarea id="reviewNote" rows="3" maxlength="5000" placeholder="What happened, how you managed it, what you'd do differently" data-input="reviewNoteInput" data-change="reviewNoteSave" data-arg="exit">${esc(noteText(t, 'exit'))}</textarea></div>`}
    ${shotsRowHtml(t)}
  </div>`;
}

/** + New setup: what happened, at what (or a pattern); what's picked is on the trade already, and the line says which */
function setupDraftHtml(lib, t) {
  const d = state.setupDraft, side = tradeSide(t);
  const parts = draftParts(d);
  const on = d.key && labelsOf(t, 'setup').some(l => l.value === d.key) ? d.key : '';
  const have = !on && setupName(lib, parts) ? lib.choices('setup').find(i => sameParts(lib.parts(i.key), parts)) : null;
  const onTrade = have && labelsOf(t, 'setup').some(l => lib.resolve('setup', l.value) === have.key);
  const said = on ? `Added <b>${esc(lib.nameOf('setup', on, side))}</b>${d.made === on ? ' to this trade and My setups. Rename it in Edit setups.' : '.'}`
    : onTrade ? `Already on this trade: <b>${esc(lib.nameOf('setup', have.key, side))}</b>`
    : d.action && !d.levels.length ? 'Now at what?' : 'Tap what happened and at what, or a pattern. It goes on this trade as you tap.';
  return `<div class="jr-draft">
      <div class="jr-draft-row"><span class="jr-draft-q">What happened?</span>${lib.choices('action').map(i => chip(lib.nameOf('action', i.key, side).replace(/^./, c => c.toUpperCase()), d.action === i.key, `data-action="setDraftAction" data-arg="${esc(i.key)}"`)).join('')}${newBox('action')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">At what?</span>${lib.choices('level').map(i => chip(lib.nameOf('level', i.key, side), d.levels.includes(i.key), `data-action="toggleDraftLevel" data-arg="${esc(i.key)}"`)).join('')}${newBox('level')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">Or a pattern</span>${lib.choices('pattern').map(i => chip(lib.nameOf('pattern', i.key, side), d.pattern === i.key, `data-action="setDraftPattern" data-arg="${esc(i.key)}"`)).join('')}${newBox('pattern')}</div>
      <div class="jr-draft-row"><span class="jr-have" role="status"><span>${said}</span></span><button class="btn${on ? ' primary' : ''}" data-action="cancelSetupDraft">Done</button></div>
    </div>`;
}

// ---------- editing one of My setups (Edit choices): what it's made of, and its name ----------

const editParts = d => d.pattern ? { pattern: d.pattern } : { action: d.action, levels: d.levels };
/** another of My setups made of the same things, which the edit would duplicate */
const editTwin = (lib, d) => lib.choices('setup').find(i => i.key !== d.key && sameParts(lib.parts(i.key), editParts(d))) || null;

/** Edit: the builder opens under the setup, with what it's made of now; a name that's its parts' follows the change */
export function editSetup(key) {
  const lib = library(), p = lib.parts(key), name = lib.nameOf('setup', key);
  state.setupEdit = { key, action: p.action || '', levels: [...(p.levels || [])], pattern: p.pattern || '', name, follow: !!lib.item('setup', key)?.follows };
  renderJournalLibrary();
}
export function cancelSetupEdit() { state.setupEdit = null; renderJournalLibrary(); }
function setupEdited() {
  const d = state.setupEdit;
  if (d.follow) d.name = setupName(library(), editParts(d)) || d.name;
  renderJournalLibrary();
}
export function setEditAction(action) { const d = state.setupEdit; if (!d) return; d.action = d.action === action ? '' : action; d.pattern = ''; setupEdited(); }
export function setEditPattern(pattern) { const d = state.setupEdit; if (!d) return; d.pattern = d.pattern === pattern ? '' : pattern; if (d.pattern) { d.action = ''; d.levels = []; } setupEdited(); }
export function toggleEditLevel(level) {
  const d = state.setupEdit;
  if (!d) return;
  d.levels = d.levels.includes(level) ? d.levels.filter(l => l !== level) : [...d.levels, level];
  d.pattern = '';
  setupEdited();
}
/** a name typed stops following the parts */
export function setupEditNameInput(name) { if (state.setupEdit) Object.assign(state.setupEdit, { name, follow: false }); }

/** Save: the setup's new parts and name, on its library row; every trade with it groups the new way from then on */
export function saveSetupEdit() {
  const d = state.setupEdit, lib = library();
  if (!d) return;
  const parts = editParts(d), auto = setupName(lib, parts);
  if (!auto || editTwin(lib, d)) return;
  state.setupEdit = null;
  // a typed short name stays with it
  const short = libraryRow('setup', d.key)?.settings?.short;
  return changeLibrary('setup', d.key, { name: (d.name.trim() || auto).slice(0, 80), settings: typeof short === 'string' ? { ...parts, short } : parts });
}

/** the builder under a setup being edited; one made of the same things offers a merge instead of a twin */
function setupEditHtml(lib) {
  const d = state.setupEdit, auto = setupName(lib, editParts(d)), twin = auto ? editTwin(lib, d) : null;
  const finish = twin
    ? `<span class="jr-have">Same as <b>${esc(lib.nameOf('setup', twin.key, 'both'))}</b>.</span><button class="btn" data-action="mergeEditedSetup" data-arg="${esc(twin.key)}">Merge into it</button><button class="pos-link" data-action="cancelSetupEdit">Cancel</button>`
    : `<button class="btn primary" data-action="saveSetupEdit"${auto ? '' : ' disabled'}>Save</button><button class="pos-link" data-action="cancelSetupEdit">Cancel</button>`;
  return `<div class="jr-draft jl-edit">
      <div class="jr-draft-row"><span class="jr-draft-q">What happened?</span>${lib.choices('action').map(i => chip(i.name.replace(/^./, c => c.toUpperCase()), d.action === i.key, `data-action="setEditAction" data-arg="${esc(i.key)}"`)).join('')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">At what?</span>${lib.choices('level').map(i => chip(i.name, d.levels.includes(i.key), `data-action="toggleEditLevel" data-arg="${esc(i.key)}"`)).join('')}</div>
      <div class="jr-draft-row"><span class="jr-draft-q">Or a pattern</span>${lib.choices('pattern').map(i => chip(i.name, d.pattern === i.key, `data-action="setEditPattern" data-arg="${esc(i.key)}"`)).join('')}</div>
      <div class="jr-draft-row"><label class="jr-draft-q" for="setupEditName">Name</label><input type="text" id="setupEditName" maxlength="80" autocomplete="off" placeholder="${esc(auto || 'Pick what happened and at what')}" value="${esc(d.name)}" data-input="setupEditNameInput" data-enter="saveSetupEdit" />
        ${finish}</div>
      <p class="hint">Every trade with this setup counts the new way, in the filter, the stats and the reviews.</p>
    </div>`;
}

/** Merge into it: the setup being edited counts as its twin from then on */
export function mergeEditedSetup(into) {
  const d = state.setupEdit;
  if (!d || !into) return;
  state.setupEdit = null;
  return mergeLibraryItem('setup', d.key, into);
}

// ---------- the Library sheet ----------

const KIND_WORDS = [['setup', 'My setups'], ['market', 'Market'], ['sector', 'Sector'], ['level', 'Levels'], ['action', 'What happened'], ['pattern', 'Patterns'], ['tactic', 'Entry tactics'], ['tag', 'Tags'], ['mistake', 'Mistakes']];
/** what a kind's section says first: the second box is the words on a short */
const KIND_NOTES = {
  setup: 'A setup reads by the trade\'s side: 9 EMA bounce on a long, 9 EMA rejection on a short. One named for its parts follows them; a typed name takes its own short name.',
  level: 'The second box is the level on a short: a bounce off support on a short is a rejection at resistance. Moving averages read the same.',
  action: 'The second box is the word on a short: a bounce on a short is a rejection.',
  pattern: 'The second box is the name on a short: a breakout on a short is a breakdown.',
};
/** the box for an item's words on a short */
const shortBox = (kind, i) => `<input type="text" class="jl-short" maxlength="80" value="${esc(i.short)}" placeholder="On a short: same" aria-label="${esc(i.name)} on a short" data-change="setLibraryShort" data-arg="${kind}" data-arg2="${esc(i.key)}" />`;

export function renderJournalLibrary() {
  const el = document.getElementById('journalLibraryBody');
  if (!el) return;
  const lib = library();
  el.innerHTML = KIND_WORDS.map(([kind, words]) => {
    const items = lib.byKind[kind] || [];
    // a built-in merge (the rejection: a bounce on a short) isn't yours to undo, so it isn't listed
    const builtIn = i => BUILT_IN_MERGES.has(`${kind}:${i.key}`) && !libraryRow(kind, i.key)?.merged_into;
    const rows = items.filter(i => !builtIn(i)).map(i => {
      const into = lib.merged.get(`${kind}:${i.key}`);
      const others = items.filter(o => o.key !== i.key && !lib.merged.has(`${kind}:${o.key}`));
      const sideWords = kind === 'level' || kind === 'action' || kind === 'pattern' || (kind === 'setup' && !i.follows);
      // a setup named for its parts says what it reads as on a short; one made of the same things as another offers the merge
      const shortWords = kind === 'setup' && i.follows && i.short && i.short !== i.name ? ` · on a short: ${i.short}` : '';
      const twin = into || i.hidden ? null : kind === 'setup' ? setupTwin(lib, i.key) : kind === 'action' || kind === 'pattern' ? shortTwin(lib, kind, i.key) : null;
      return `<div class="jl-row${kind === 'setup' ? ' jl-setup' : ''}${sideWords ? ' jl-sided' : ''}${i.hidden || into ? ' jl-off' : ''}"><input type="text" maxlength="80" value="${esc(i.name)}" aria-label="Rename ${esc(i.name)}" data-change="renameLibraryItem" data-arg="${kind}" data-arg2="${esc(i.key)}" />
        ${sideWords && !into ? shortBox(kind, i) : ''}
        ${kind === 'setup' ? `<span class="jl-parts">${esc(lib.partsWords(lib.parts(i.key)) + shortWords)}</span>` : ''}${i.own ? '<span class="journal-tag journal-tag-quiet">yours</span>' : ''}
        ${kind === 'setup' && !into ? `<button class="pos-link" data-action="editSetup" data-arg="${esc(i.key)}" aria-expanded="${state.setupEdit?.key === i.key}">Edit</button>` : ''}
        <button class="pos-link" data-action="toggleLibraryHidden" data-arg="${kind}" data-arg2="${esc(i.key)}">${i.hidden ? 'Show' : 'Hide'}</button>
        <select aria-label="Merge ${esc(i.name)} into" data-change="mergeLibraryItem" data-arg="${kind}" data-arg2="${esc(i.key)}"><option value="">${into ? '' : 'Merge into…'}</option>${others.map(o => `<option value="${esc(o.key)}"${into === o.key ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}${into ? '<option value="__unmerge">Unmerge</option>' : ''}</select>
        ${twin ? `<span class="jl-twin">${kind === 'setup' ? 'Same setup as' : 'The short side of'} <b>${esc(lib.nameOf(kind, twin.key, 'both'))}</b> <button class="pos-link" data-action="mergeTwin" data-arg="${kind}" data-arg2="${esc(i.key)}" data-into="${esc(twin.key)}">Merge into it</button></span>` : ''}</div>
        ${kind === 'setup' && state.setupEdit?.key === i.key ? setupEditHtml(lib) : ''}`;
    }).join('');
    return `<div class="sheet-section"><div class="sheet-label">${words}</div>${KIND_NOTES[kind] ? `<p class="hint">${esc(KIND_NOTES[kind])}</p>` : ''}<div class="jl-list">${rows}</div></div>`;
  }).join('') + '<p class="hint">Hidden choices stop being offered; trades already labeled keep them. Merging counts one as the other everywhere, and the old name maps to the kept one from then on.</p>';
}

export function openJournalLibrary() { state.setupEdit = null; renderJournalLibrary(); openSheet('journalLibrary'); }

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
/** a setup made of the same things as another, or a pattern or action that is another's short side, merged into it */
export const mergeTwin = (kind, key, into) => kind && key && into ? mergeLibraryItem(kind, key, into) : null;
/** a level's, action's, pattern's or typed setup's words on a short; blank reads the same both ways */
export function setLibraryShort(kind, key, value) {
  const short = String(value || '').trim().slice(0, 80);
  const base = libraryRow(kind, key);
  if (!base) return;
  return changeLibrary(kind, key, { settings: { ...(base.settings || {}), short } });
}

/** the side the Journal's side filter shows, for names read off any one trade: a short's, a long's, or both */
export const shownSide = () => state.journalSide === 'long' || state.journalSide === 'short' ? state.journalSide : 'both';

/**
 * a trade's setups as the list shows them: [{ key, name, kind, levels }], merges followed, in the order they were added;
 * kind and levels are what it adds up under (setupGroups); names in the trade's own words unless a side is given
 */
export function setupsOf(t, side = tradeSide(t)) {
  if (!state.journalReview) return [];
  const lib = library();
  const seen = new Set();
  return (data().labels[t.key] || []).filter(l => l.kind === 'setup').map(l => lib.resolve('setup', l.value))
    .filter(k => !seen.has(k) && seen.add(k)).map(key => ({ key, name: lib.nameOf('setup', key, side), ...setupGroups(lib, key, side) }));
}

/** whether a trade fits the setup filter: a kind ('action:bounce': any bounce), a level ('level:ema21'), or one setup's key */
export function setupMatches(t, filter) {
  if (!filter) return true;
  const list = setupsOf(t);
  if (filter.startsWith('action:') || filter.startsWith('pat:')) return list.some(s => s.kind?.key === filter);
  if (filter.startsWith('level:')) return list.some(s => s.levels.some(l => l.key === filter));
  return list.some(s => s.key === filter);
}

/**
 * The setup filter's menu, the action first and the level second: each kind (Bounce, Undercut & rally) with its count and
 * its setups under it, patterns and setups without a kind on their own, most used first; then every level on its own (any
 * action at the 21 EMA). A trade counts once in each. [{ value, name, count, depth }] and the levels, or empty. Names in
 * side's words: a short's when the side filter shows shorts, both ('Bounce / rejection') when it shows every side.
 */
export function setupMenu(trades, side = shownSide()) {
  /** @type {Map<string, { value: string, name: string, count: number, kids?: Map<string, any> }>} */
  const top = new Map(), levels = new Map();
  const bump = (map, value, name) => { const e = map.get(value) || { value, name, count: 0 }; e.count++; map.set(value, e); return e; };
  for (const t of trades) {
    const list = setupsOf(t, side);
    if (!list.length) continue;
    const kinds = new Set(), lvls = new Set();
    for (const s of list) {
      if (s.kind?.action) {
        const k = top.get(s.kind.key) || { value: s.kind.key, name: s.kind.name, count: 0, kids: new Map() };
        if (!kinds.has(s.kind.key)) { kinds.add(s.kind.key); k.count++; }
        top.set(s.kind.key, k);
        bump(k.kids, s.key, s.name);
      } else bump(top, s.key, s.name);
      for (const l of s.levels) if (!lvls.has(l.key)) { lvls.add(l.key); bump(levels, l.key, l.name); }
    }
  }
  const byUse = list => [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const setups = byUse(top.values()).flatMap(e => [{ value: e.value, name: e.name, count: e.count, depth: 0 },
    ...(e.kids ? byUse(e.kids.values()).map(c => ({ ...c, depth: 1 })) : [])]);
  return { setups, levels: byUse(levels.values()).map(l => ({ ...l, depth: 0 })) };
}

/** your library as the review sees it (defaults, your items, renames, merges) */
export const reviewLibrary = () => library();
/** a trade's labels of one kind as item keys, merges followed, each once */
export function labelKeys(t, kind) {
  if (!state.journalReview) return [];
  const lib = library();
  return [...new Set((data().labels[t.key] || []).filter(l => l.kind === kind).map(l => lib.resolve(kind, l.value)))];
}
/** what a trade's review says, for the Setups tab's cuts: its grade, followed the plan, and market (its own, else the day's) */
export const reviewOf = t => ({ grade: data().reviews[t.key]?.setup_grade || '', plan: data().reviews[t.key]?.plan_followed || '', market: state.journalReview ? tradeReviewState(t).market || '' : '' });

/** a trade's labels in words, for the list and the deck later: 'Strong · 50 SMA bounce · 30-minute pivot' */
export function labelWords(t) {
  const lib = library();
  return (data().labels[t.key] || []).filter(l => l.kind !== 'mistake').map(l => lib.nameOf(l.kind, l.value, tradeSide(t))).join(' · ');
}

export { parseSetup };

/**
 * What a week or month review reads from your review (core/journal-week.js's context): each trade's grades and notes, its
 * labels, its market (its own, else the day's), item names (merges followed), each setup's kind (Bounce), and whether it's reviewed.
 */
export function periodReviewContext() {
  const d = data(), lib = library();
  return {
    review: key => d.reviews[key],
    labels: key => (d.labels[key] || []).map(l => ({ kind: l.kind, value: lib.resolve(l.kind, l.value) })),
    market: t => tradeReviewState(t).market,
    nameOf: (kind, value) => lib.nameOf(kind, value, 'both'),
    kinds: key => (d.labels[key] || []).filter(l => l.kind === 'setup').map(l => { const k = lib.resolve('setup', l.value); return setupGroups(lib, k, 'both').kind?.name || lib.nameOf('setup', k, 'both'); }),
    reviewed: t => tradeReviewState(t).reviewed,
    saved: key => !!d.weekly?.[key],
  };
}

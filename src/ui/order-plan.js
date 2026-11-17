// Order plans (docs/schwab.md, docs/journal.md): the Trade at Schwab sheet's setup, setup grade and entry tactic picks
// (today's focus list and the opening range fill them in), what the calculator knew when the review opened (core/order-plans.js PlanNumbers:
// the risk, the account size, how the stop was set), the plan saved once the order goes and picks changed after, and the
// journal putting each plan's labels and grade on its trade once (services/order-plans.js).
import { state } from '../state.js';
import { marketEscape as esc, nyDateStr } from '../core/format.js';
import { buildLibrary, goesBy, GRADES, levelPickGroups, onOrderSheet, readQuickLine, sameParts, setupName, setupOfParts, setupsByUse, setupSearchNames } from '../core/journal-labels.js';
import { DESKTOP_MQ, mq } from '../lib/media.js';
import { store } from '../lib/store.js';
import { matchPlans, planGrade, planLabels } from '../core/order-plans.js';
import { addAppLabels, saveLibraryItem, saveReviewFields } from '../services/journal-review.js';
import { loadOrderPlans, saveOrderPlan, updateOrderPlan } from '../services/order-plans.js';
import { schwabAccounts, schwabBalances } from '../services/schwab.js';
import { accountSizeFromSchwab, todaysAccountValue } from './account-size.js';
import { showError } from './feedback.js';
import { loadJournalReview, tacticGroupsHtml } from './journal-review.js';
import { orbActive, orbStopName } from './orb.js';
import { riskDollars } from './risk.js';
import { currentAtr5, dayRange, rawStop } from './stops.js';

/** the default tactics the opening-range chips stand for */
const ORB_TACTICS = /** @type {Record<number, string>} */ ({ 15: 'pivot15', 30: 'pivot30' });
const newId = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
const round2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
const num = id => { const v = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById(id)).value); return Number.isFinite(v) && v > 0 ? v : null; };
const library = () => buildLibrary(state.journalReview?.library || []);
const sideOf = t => t.isLong ? 'long' : 'short';

/**
 * What the calculator knew when the review opened, for the plan: the max loss, the account size and where it came from, and
 * how the stop was set (LOD/HOD with its adjustment; a custom or opening-range stop records no adjustment, since none applied).
 * @param {boolean} isLong @param {number} stopPlanned the calculator's stop, before Schwab's tick
 */
export function planContext(isLong, stopPlanned) {
  const range = dayRange(), atr = currentAtr5(), orb = orbActive();
  const custom = rawStop(isLong ? 'stopLong' : 'stopShort') > 0;
  const source = !custom ? 'auto' : orbStopName(isLong) ? 'orb' : 'custom';
  const strategy = source === 'auto' ? state.stopStrategy : null;
  return {
    ...riskContext(),
    stop_source: source, stop_strategy: strategy,
    stop_amount: strategy === 'atr' ? state.atrMultiplier : strategy === 'percent' && Number.isFinite(state.stopPercent) ? state.stopPercent : null,
    stop_level: (isLong ? range.low : range.high) || null, stop_level_name: isLong ? 'LOD' : 'HOD', ext_hours: !!range.ext,
    atr5: atr && Number.isFinite(atr.value) ? atr.value : null, stop_planned: Number.isFinite(stopPlanned) ? stopPlanned : null,
    orb_minutes: orb ? orb.minutes : null,
  };
}

/** the max loss and the account it comes from, as they stand now (a share order card's review reads them fresh) */
export function riskContext() {
  return { max_loss: round2(riskDollars()), account_size: num('accountSize'), account_source: accountSizeFromSchwab() ? 'schwab' : 'typed', risk_pct: num('riskPct') };
}

// ---------- the sheet's picks ----------

/**
 * Your setups and tactics, read once and shared by every caller. The trade button showing starts it, so the sheet opens
 * with them in place instead of pushing its buttons down when they arrive; opening the sheet tries again after a failure.
 */
export function loadPlanChoices({ retry = false } = {}) {
  if (!state.session || state.journalReview || (state.journalReviewError && !retry)) return state.planChoicesRead || Promise.resolve();
  return state.planChoicesRead ||= loadJournalReview().finally(() => { state.planChoicesRead = null; });
}

/** a new review: your choices (read already, or now), then today's focus setups and the opening range's tactic */
export function startTradePlan(t) {
  if (!state.session) return;
  if (state.journalReview) { prefillPicks(t); return; }
  loadPlanChoices({ retry: true }).then(() => {
    prefillPicks(t);
    if (state.tradeTicket === t) { renderTradePlan(); focusTradeQuick(); }
  });
}

/** today's focus list for this ticker (its side, or no side) gives the setups; a 15m or 30m opening range the tactic. Once, and never over a pick of yours */
function prefillPicks(t) {
  if (t.picksTouched || t.prefilled || !state.journalReview) return;
  t.prefilled = true;
  const lib = library(), side = sideOf(t);
  const focus = (state.journalReview.days?.[nyDateStr(new Date())]?.focus_list || []).find(f => f.symbol === (t.underlying || t.symbol) && (!f.side || f.side === side)); // an option's focus is its underlying's
  const setups = lib.choices('setup').map(i => i.key);
  t.setups = [...new Set((focus?.setups || []).map(k => lib.resolve('setup', k)).filter(k => setups.includes(k)))];
  const tactic = ORB_TACTICS[t.planCtx?.orb_minutes];
  t.tactics = tactic && lib.choices('tactic').some(i => i.key === tactic) ? [tactic] : [];
}

const chip = (label, on, attrs, cls = '') => `<button class="filter-btn${on ? ' active' : ''}${cls}" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;
/** picks can change until the order goes, and after it while its plan is kept */
const picksOff = t => t.sent && !t.planId ? ' disabled' : '';
const cap = s => s.replace(/^./, c => c.toUpperCase());

/** whether the sheet offers a library item: it isn't marked Review only (an item the library doesn't know is offered) */
const offered = (lib, kind, key) => { const i = lib.item(kind, key); return !i || onOrderSheet(i); };
/** a setup the sheet offers: none of what it's made of is Review only */
function setupOffered(lib, key) {
  const p = lib.parts(key);
  return p.pattern ? offered(lib, 'pattern', p.pattern) : (!p.action || offered(lib, 'action', p.action)) && (p.levels || []).every(l => offered(lib, 'level', l));
}
const PATTERN = 'pattern';
/** the moves the sheet offers, and any you picked a setup under */
const movesShown = (t, lib) => lib.choices('action').filter(i => onOrderSheet(i) || t.setups.some(k => lib.parts(k).action === i.key) || t.pickMove === i.key);
/** levels the sheet offers, and any a picked setup sits at */
const levelsShown = (t, lib) => lib.choices('level').filter(i => onOrderSheet(i) || t.setups.some(k => (lib.parts(k).levels || []).includes(i.key)));
const patternsShown = (t, lib) => lib.choices('pattern').filter(i => onOrderSheet(i) || pickedOf(t, lib, { pattern: i.key }));
/**
 * The move the picker shows: the one you tapped or typed, else the first picked setup's, else the move of your most used
 * setup (owner request: less tapping when you don't type), else the first move.
 */
function moveOf(t, lib) {
  if (t.pickMove) return t.pickMove;
  const p = t.setups.map(k => lib.parts(k)).find(p => p.pattern || p.action);
  if (p) return p.pattern ? PATTERN : p.action;
  const moves = lib.choices('action').filter(i => onOrderSheet(i)).map(i => i.key);
  const used = setupsByUse(lib, state.journalReview?.labels || {}).map(i => lib.parts(i.key)).find(p => p.pattern ? patternsShown(t, lib).length : moves.includes(p.action || ''));
  return used ? (used.pattern ? PATTERN : used.action) : moves[0] || PATTERN;
}
/** the setup on the ticket made of these parts, if any */
const pickedOf = (t, lib, parts) => t.setups.find(k => sameParts(lib.parts(k), parts));
/** how many setups on the ticket sit under a move */
const pickedUnder = (t, lib, move) => t.setups.filter(k => { const p = lib.parts(k); return move === PATTERN ? !!p.pattern : p.action === move; }).length;

// ---------- the setup picker's three layouts (Settings, Setup picker; owner request: try them side by side) ----------

export const PICKERS = ['sketch', 'grid', 'level'];
/** the layout picked in Settings (this device only): Sketches, the default, Grid or Level first */
export const tradePicker = () => { const v = store.get('trade_picker'); return PICKERS.includes(v) ? v : 'sketch'; };
export function setTradePicker(v) {
  if (!PICKERS.includes(v)) return;
  store.set('trade_picker', v);
  paintTradePicker();
  renderTradePlan();
}
export function paintTradePicker() {
  const on = tradePicker();
  for (const [p, id] of [['sketch', 'tradePickerSketch'], ['grid', 'tradePickerGrid'], ['level', 'tradePickerLevel']]) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.classList.toggle('active', p === on);
    b.setAttribute('aria-pressed', String(p === on));
  }
}

/**
 * A move drawn as a tiny chart, price (solid) against the level (dashed): a bounce touches it and turns, an undercut dips
 * through and comes back, a breakout crosses it, a pattern is a flag. Read from the move's name, so your own moves get one
 * too; a short's is the long's upside down.
 */
const SHAPES = /** @type {Record<string, [string, number]>} */ ({
  bounce: ['M2 3 L13 13 L26 3', 14], undercut: ['M2 3 L11 17 L15 8 L26 3', 13], breakout: ['M2 16 L8 13 L12 15 L26 3', 9],
  pattern: ['M2 16 L8 5 L12 8 L16 6 L20 8 L26 2', 0], other: ['M2 12 L9 6 L15 12 L20 8 L26 10', 0],
});
function moveShape(lib, move) {
  if (move === PATTERN) return 'pattern';
  const n = String(lib.nameOf('action', move, 'long') || '').toLowerCase();
  return /under|reclaim/.test(n) ? 'undercut' : /break|through/.test(n) ? 'breakout' : /bounce|reject|hold/.test(n) ? 'bounce' : 'other';
}
function glyph(lib, move, side) {
  const [d, level] = SHAPES[moveShape(lib, move)];
  return `<svg class="tp-glyph" viewBox="0 0 28 20" width="28" height="20" aria-hidden="true"><g${side === 'short' ? ' transform="matrix(1 0 0 -1 0 20)"' : ''}>${level ? `<line x1="1" x2="27" y1="${level}" y2="${level}" class="tp-glyph-level"/>` : ''}<path d="${d}"/></g></svg>`;
}
const moveName = (lib, move, side) => move === PATTERN ? 'Pattern' : cap(lib.nameOf('action', move, side));

/** a setup made of parts, as a key the rings go by */
const partsKey = p => p.pattern ? `p:${p.pattern}` : `a:${p.action || ''}:${[...(p.levels || [])].sort().join('+')}`;
/** what the typed line rings: every part's first match (Enter's, top) and the part being typed's every match (all) */
function quickRing(t, lib) {
  const none = { top: new Set(), all: new Set() };
  if (!(state.tradeQuickText || '').trim()) return none;
  const line = quickLine(t, lib);
  const top = new Set([...line.setups.map(partsKey), ...line.tactics.map(k => `t:${k}`), ...(line.grade ? [`g:${line.grade}`] : [])]);
  return { top, all: new Set([...top, ...line.last.setups.map(partsKey), ...line.last.tactics.map(k => `t:${k}`)]) };
}
const ringCls = (ring, key, on) => on ? '' : ring.top.has(key) ? ' tp-cand tp-top' : ring.all.has(key) ? ' tp-cand' : '';

/** a level chip for a move: lit when that setup is on, dashed when it was never made (a tap makes it), ringed when typed */
function levelChip(t, lib, ring, side, off, move, level, label) {
  const parts = { action: move, levels: [level] }, on = !!pickedOf(t, lib, parts), made = !!setupOfParts(lib, parts), name = setupName(lib, parts, side);
  return chip(label, on, `data-action="pickTradeLevel" data-arg="${esc(level)}" data-arg2="${esc(move)}" title="${esc(made ? name : `${name}: a tap adds it to My setups`)}"${off}`, (made ? '' : ' tp-new') + ringCls(ring, partsKey(parts), on));
}
function patternChips(t, lib, ring, side, off) {
  return patternsShown(t, lib).map(i => {
    const parts = { pattern: i.key }, on = !!pickedOf(t, lib, parts), made = !!setupOfParts(lib, parts), label = lib.nameOf('pattern', i.key, side);
    return chip(label, on, `data-action="pickTradePattern" data-arg="${esc(i.key)}" title="${esc(made ? label : `${label}: a tap adds it to My setups`)}"${off}`, (made ? '' : ' tp-new') + ringCls(ring, partsKey(parts), on));
  }).join('');
}
const levelGroups = (t, lib, side) => levelPickGroups(levelsShown(t, lib).map(i => ({ key: i.key, name: lib.nameOf('level', i.key, side) })));
const DASHED = '<p class="jr-none">Dashed: not in My setups yet. A tap adds it.</p>';
const group = (name, chips) => `<div class="jr-group"><span class="jr-group-name">${esc(name)}</span><span class="jr-group-chips">${chips}</span></div>`;

/** Sketches: what happened (a move, or Pattern), each drawn, then at what */
function sketchHtml(t, lib, ring, side, off) {
  const move = moveOf(t, lib);
  const seg = key => {
    const n = pickedUnder(t, lib, key), on = move === key;
    return `<button class="tp-move${on ? ' active' : ''}" aria-pressed="${on}" data-action="setTradeMove" data-arg="${esc(key)}"${off}>${glyph(lib, key, side)}<span class="tp-move-name">${esc(moveName(lib, key, side))}</span>${n ? `<span class="tp-move-count" title="${n} picked">${n}</span>` : ''}</button>`;
  };
  const head = `<div class="tp-moves" role="group" aria-label="What happened">${movesShown(t, lib).map(i => seg(i.key)).join('')}${seg(PATTERN)}</div>`;
  if (move === PATTERN) {
    const chips = patternChips(t, lib, ring, side, off);
    return head + `<div class="tp-panel" id="tradeSetupPick"><div class="tp-panel-head"><b>Pattern</b></div>${chips ? group('Pattern', chips) : '<p class="jr-none">No patterns yet. Add them in Edit setups.</p>'}${/tp-new/.test(chips) ? DASHED : ''}</div>`;
  }
  const groups = levelGroups(t, lib, side).map(g => group(g.name, g.items.map(i => levelChip(t, lib, ring, side, off, move, i.key, i.label)).join(''))).join('');
  return head + `<div class="tp-panel" id="tradeSetupPick"><div class="tp-panel-head"><b>${esc(moveName(lib, move, side))}</b> at…</div>${groups || '<p class="jr-none">No levels yet. Add them in Edit setups.</p>'}${/tp-new/.test(groups) ? DASHED : ''}</div>`;
}

/** Grid: a row per level, a column per move; every setup one tap, a ✓ when it's on */
function gridHtml(t, lib, ring, side, off) {
  const moves = movesShown(t, lib);
  const cols = `style="--tp-cols:${moves.length}"`;
  const head = `<div class="tp-grid-row tp-grid-head" ${cols}><span></span>${moves.map(m => `<span class="tp-grid-col${pickedUnder(t, lib, m.key) ? ' has' : ''}">${glyph(lib, m.key, side)}<span>${esc(moveName(lib, m.key, side))}</span></span>`).join('')}</div>`;
  const rows = levelGroups(t, lib, side).map(g => `<div class="tp-grid-group">${esc(g.name)}</div>` + g.items.map(l => `<div class="tp-grid-row" ${cols}><span class="tp-grid-name">${esc(l.label)}</span>${moves.map(m => {
    const parts = { action: m.key, levels: [l.key] }, on = !!pickedOf(t, lib, parts), made = !!setupOfParts(lib, parts), name = setupName(lib, parts, side);
    return `<button class="tp-cell${on ? ' active' : ''}${made ? '' : ' tp-new'}${ringCls(ring, partsKey(parts), on)}" aria-pressed="${on}" aria-label="${esc(name)}" title="${esc(made ? name : `${name}: a tap adds it to My setups`)}" data-action="pickTradeLevel" data-arg="${esc(l.key)}" data-arg2="${esc(m.key)}"${off}>${on ? '✓' : ''}</button>`;
  }).join('')}</div>`).join('')).join('');
  const chips = patternChips(t, lib, ring, side, off);
  return `<div class="tp-grid" id="tradeSetupPick">${rows ? head + rows : '<p class="jr-none">No levels yet. Add them in Edit setups.</p>'}</div>${chips ? `<div class="tp-groups">${group('Pattern', chips)}</div>` : ''}${/tp-new/.test(rows + chips) ? DASHED : ''}`;
}

/** Level first: every level; a tap opens what it did there, and a level carries the moves picked at it */
function levelFirstHtml(t, lib, ring, side, off) {
  const moves = movesShown(t, lib);
  let fresh = false;
  const groups = levelGroups(t, lib, side).map(g => {
    const open = g.items.find(l => l.key === t.openLevel);
    const chips = g.items.map(l => {
      const at = moves.filter(m => pickedOf(t, lib, { action: m.key, levels: [l.key] }));
      const typed = moves.some(m => ringCls(ring, partsKey({ action: m.key, levels: [l.key] }), at.includes(m)));
      const isOpen = open === l;
      return `<button class="filter-btn${at.length ? ' active' : ''}${isOpen ? ' tp-open' : ''}${typed ? ' tp-cand tp-top' : ''}" aria-expanded="${isOpen}" data-action="openTradeLevel" data-arg="${esc(l.key)}" title="${esc(`What ${l.label} did`)}"${off}>${esc(l.label)}${at.length ? ` <span class="tp-lv-move">${esc(at.map(m => lib.nameOf('action', m.key, side)).join(', '))}</span>` : ''}</button>`;
    }).join('');
    const strip = open ? `<span class="tp-strip" role="group" aria-label="${esc(`What ${open.label} did`)}"><span class="tp-strip-name">${esc(open.label)}:</span>${moves.map(m => {
      const c = levelChip(t, lib, ring, side, off, m.key, open.key, moveName(lib, m.key, side));
      if (/tp-new/.test(c)) fresh = true;
      return c;
    }).join('')}</span>` : '';
    return group(g.name, chips + strip);
  }).join('');
  const chips = patternChips(t, lib, ring, side, off);
  if (/tp-new/.test(chips)) fresh = true;
  return `<div class="tp-groups" id="tradeSetupPick">${groups || '<p class="jr-none">No levels yet. Add them in Edit setups.</p>'}${chips ? group('Pattern', chips) : ''}</div>${fresh ? DASHED : ''}`;
}

const PICKER_HINT = { sketch: 'what happened, then at what', grid: 'the level\'s row, the move\'s column', level: 'the level, then what it did' };
function setupPickerHtml(t, lib, ring) {
  const side = sideOf(t), off = picksOff(t), how = tradePicker();
  return (how === 'grid' ? gridHtml : how === 'level' ? levelFirstHtml : sketchHtml)(t, lib, ring, side, off);
}

/** entry tactics by timeframe, then + New, which takes a name */
function tacticPickerHtml(t, lib, ring) {
  const off = picksOff(t);
  const items = lib.choices('tactic').filter(i => onOrderSheet(i) || t.tactics.includes(i.key));
  const add = t.addingTactic
    ? `<span class="jr-newbox tp-newbox"><input type="text" id="tradeNewTactic" maxlength="80" placeholder="15m flag break" autocomplete="off" spellcheck="false" data-enter="addTradeTactic" aria-label="New entry tactic" /><button class="btn" data-action="addTradeTactic">Add</button><button class="pos-link" data-action="cancelTradeTactic">Cancel</button></span>`
    : `<button class="filter-btn tp-new" data-action="startTradeTactic" title="Add an entry tactic to your library and pick it"${off}>+ New</button>`;
  const groups = tacticGroupsHtml(items, i => { const on = t.tactics.includes(i.key); return chip(i.label, on, `data-action="toggleTradeTactic" data-arg="${esc(i.key)}" title="${esc(i.name)}"${off}`, ringCls(ring, `t:${i.key}`, on)); });
  return `<div class="tp-groups">${groups}${groups ? '' : '<p class="jr-none">No entry tactics yet.</p>'}<div class="tp-add">${add}</div></div>`;
}

function gradeHtml(t, ring) {
  const off = picksOff(t);
  return `<div class="tp-grades" role="group" aria-label="Setup grade">${GRADES.map(g => `<button class="tp-grade-btn g-${g}${t.setupGrade === g ? ' active' : ''}${ringCls(ring, `g:${g}`, t.setupGrade === g)}" aria-pressed="${t.setupGrade === g}" data-action="setTradeGrade" data-arg="${g}" title="How good the setup is: ${g}"${off}>${g}</button>`).join('')}</div>`;
}

/**
 * What you picked, read back in one line, each a tap to take it off; on desktop the typed line is in it, after the picks
 * (owner request: the box is the plan line). What's missing in amber (Place never waits for it).
 */
function planLineHtml(t, lib) {
  const side = sideOf(t), off = picksOff(t);
  const item = (label, attrs, cls = '') => `<button class="tp-picked${cls}" ${attrs}${off}>${esc(label)}<span aria-hidden="true">×</span></button>`;
  const parts = [
    ...t.setups.map(k => item(lib.nameOf('setup', k, side), `data-action="toggleTradeSetup" data-arg="${esc(k)}" title="Take this setup off"`)),
    ...t.tactics.map(k => item(lib.nameOf('tactic', k), `data-action="toggleTradeTactic" data-arg="${esc(k)}" title="Take this tactic off"`)),
    ...(t.setupGrade ? [item(t.setupGrade, `data-action="setTradeGrade" data-arg="${t.setupGrade}" title="Clear the grade"`, ` tp-picked-grade g-${t.setupGrade}`)] : []),
  ];
  if (t.backArmed && parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace('class="tp-picked', 'class="tp-picked tp-armed');
  // desktop only (CSS): the whole plan typed on one line
  const quick = `<input type="text" id="tradeQuick" class="tp-quick" placeholder="${parts.length ? 'Type more' : 'Type it: 21 ur, 15 orb, a'}" autocomplete="off" spellcheck="false" value="${esc(state.tradeQuickText || '')}" data-input="tradeQuickInput" data-enter="applyTradeQuick" aria-label="Type the setup, entry tactic and grade, separated by commas; Enter picks them" aria-describedby="tradeQuickPreview"${off} />`;
  const need = needWords(t);
  return `<div class="tp-line" id="tradePlanLine">${parts.join('')}${quick}${need ? `<span class="tp-need">${need}</span>` : ''}</div>`;
}
function needWords(t) {
  const missing = [!t.setups.length && 'setup', !t.tactics.length && 'tactic', !t.setupGrade && 'grade'].filter(Boolean);
  return missing.length ? `No ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} or ${missing.at(-1)}` : missing[0]} yet` : '';
}

/** the plan line and typed line, then Setup, Entry tactic and Grade, or why they can't show */
export function tradePlanHtml(t) {
  if (!state.session) return '<p class="hint">Sign in with Google to keep the setup, tactic and plan with the order.</p>';
  if (state.journalReviewError) return `<p class="hint" style="color:var(--amber)">Your setups couldn't load: ${esc(state.journalReviewError)}. The plan's numbers are still saved with the order.</p>`;
  if (!state.journalReview) return '<p class="hint">Loading your setups…</p>';
  const lib = library(), ring = quickRing(t, lib);
  return `<div class="trade-plan-picks">
      ${planLineHtml(t, lib)}
      <div class="tp-quick-preview" id="tradeQuickPreview" role="status">${quickPreview(t, lib)}</div>
      <div class="tp-title">Setup <span class="tp-title-hint">${PICKER_HINT[tradePicker()]}</span></div>
      <div id="tradePickSetup">${setupPickerHtml(t, lib, ring)}</div>
      <div class="tp-title">Entry tactic</div>
      <div id="tradePickTactic">${tacticPickerHtml(t, lib, ring)}</div>
      <div class="tp-title">Grade</div>
      <div id="tradePickGrade">${gradeHtml(t, ring)}</div>
    </div>
    <p class="hint">Saved with the order. The journal puts them on the trade once it fills.</p>`;
}

/** a redraw that replaces the typed line keeps your cursor in it, where it was */
export function keepQuickCursor(draw) {
  const was = /** @type {HTMLInputElement | null} */ (document.activeElement?.id === 'tradeQuick' ? document.activeElement : null);
  const at = was ? [was.selectionStart, was.selectionEnd] : null;
  draw();
  if (!was) return;
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('tradeQuick'));
  if (!box || box.disabled) return;
  box.focus();
  try { box.setSelectionRange(at[0], at[1]); } catch(e) {}
}

/** desktop: the sheet opens with the cursor in the typed line (owner request), unless you've already moved on in it */
export function focusTradeQuick() {
  if (!mq(DESKTOP_MQ) || state.openSheetName !== 'trade') return;
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('tradeQuick'));
  const at = document.activeElement;
  if (!box || box.disabled || (at && at !== document.body && at !== document.getElementById('tradeSheet') && at !== box)) return;
  box.focus();
}

/** only the picks redraw */
function renderTradePlan() {
  const el = document.getElementById('tradePlan');
  if (el && state.tradeTicket) keepQuickCursor(() => { el.innerHTML = tradePlanHtml(state.tradeTicket); });
}

/** a pick changed: drawn, and saved with the plan once there is one */
function picked(t) {
  t.picksTouched = true;
  t.backArmed = false;
  renderTradePlan();
  if (t.planId) queuePlanSave(t);
}
const canPick = t => !!t && !t.error && !picksOff(t) && !!state.journalReview;

function togglePick(field, key) {
  const t = state.tradeTicket;
  if (!canPick(t) || typeof key !== 'string' || !key) return;
  t[field] = t[field].includes(key) ? t[field].filter(k => k !== key) : [...t[field], key];
  picked(t);
}
export function toggleTradeSetup(key) { togglePick('setups', key); }
export function toggleTradeTactic(key) { togglePick('tactics', key); }

/** the setup's grade, A to F (GRADES, the journal review's); tapping the lit one clears it */
export function setTradeGrade(g) {
  const t = state.tradeTicket;
  if (!canPick(t) || !GRADES.includes(g)) return;
  t.setupGrade = t.setupGrade === g ? '' : g;
  picked(t);
}

/** what happened: a move (bounce, undercut & rally, breakout, yours) or Pattern; the levels or patterns under it follow */
export function setTradeMove(move) {
  const t = state.tradeTicket;
  if (!canPick(t) || (move !== PATTERN && !library().item('action', move))) return;
  t.pickMove = move;
  renderTradePlan();
}

/** Level first: a level's tap opens what it did there (the moves), a tap again closes it */
export function openTradeLevel(level) {
  const t = state.tradeTicket;
  if (!canPick(t) || typeof level !== 'string' || !library().item('level', level)) return;
  t.openLevel = t.openLevel === level ? '' : level;
  renderTradePlan();
}

/**
 * The setup these parts make goes on the ticket: one of My setups made of them, or with none a new one, named for its
 * parts as the journal's + New setup names it, put into My setups (taken back off the ticket if the save fails).
 * Returns the save to run once the ticket is drawn, or null.
 */
function addParts(t, parts) {
  const lib = library(), have = setupOfParts(lib, parts);
  if (have) { t.setups = [...t.setups, have.key]; return null; }
  const name = setupName(lib, parts);
  if (!name) return null;
  const row = { id: newId(), kind: 'setup', name, settings: parts }, key = `mine:${row.id}`;
  state.journalReview.library = [...state.journalReview.library, row];
  t.setups = [...t.setups, key];
  return () => saveLibraryItem(row).catch(e => {
    if (state.journalReview) state.journalReview.library = state.journalReview.library.filter(r => r.id !== row.id);
    t.setups = t.setups.filter(k => k !== key);
    showError(`Couldn't add ${name} to My setups: ${String(e?.message || e)}`);
    picked(t);
  });
}
/** a tap: the setup these parts make goes on, or comes off if it's on */
function pickParts(parts) {
  const t = state.tradeTicket;
  if (!canPick(t)) return;
  const on = pickedOf(t, library(), parts);
  if (on) { t.setups = t.setups.filter(k => k !== on); return picked(t); }
  const save = addParts(t, parts);
  picked(t);
  return save?.();
}
/** a level under a move (the one given, else the one the picker shows) */
export function pickTradeLevel(level, move) {
  const t = state.tradeTicket, lib = library();
  const m = move || (t && moveOf(t, lib));
  if (!t || !m || m === PATTERN || typeof level !== 'string' || !lib.item('level', level) || !lib.item('action', m)) return;
  return pickParts({ action: m, levels: [level] });
}
export function pickTradePattern(pattern) {
  if (typeof pattern !== 'string' || !library().item('pattern', pattern)) return;
  return pickParts({ pattern });
}

/** + New under the tactics: a name box */
export function startTradeTactic() {
  const t = state.tradeTicket;
  if (!canPick(t)) return;
  t.addingTactic = true;
  renderTradePlan();
  document.getElementById('tradeNewTactic')?.focus();
}
export function cancelTradeTactic() {
  const t = state.tradeTicket;
  if (!t) return;
  t.addingTactic = false;
  renderTradePlan();
}
/** the typed tactic goes on the ticket: one you have by that name, else a new one in your library (back off if the save fails) */
export function addTradeTactic(value) {
  const t = state.tradeTicket;
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('tradeNewTactic'));
  const name = String(value ?? input?.value ?? '').trim().slice(0, 80);
  if (!canPick(t) || !name) return;
  const lib = library();
  t.addingTactic = false;
  const same = (lib.byKind.tactic || []).find(i => !lib.merged.has(`tactic:${i.key}`) && goesBy('tactic', i, name));
  if (same) {
    if (!t.tactics.includes(same.key)) t.tactics = [...t.tactics, same.key];
    return picked(t);
  }
  const row = { id: newId(), kind: 'tactic', name }, key = `mine:${row.id}`;
  state.journalReview.library = [...state.journalReview.library, row];
  t.tactics = [...t.tactics, key];
  picked(t);
  return saveLibraryItem(row).catch(e => {
    if (state.journalReview) state.journalReview.library = state.journalReview.library.filter(r => r.id !== row.id);
    t.tactics = t.tactics.filter(k => k !== key);
    showError(`Couldn't add ${name} to your entry tactics: ${String(e?.message || e)}`);
    picked(t);
  });
}

// ---------- the typed line (desktop) ----------

/** what the typed line reads against: only what the sheet offers, both sides' words, your setups most used first */
function quickLists(t, lib) {
  const both = (kind, key) => [lib.nameOf(kind, key, 'long'), lib.nameOf(kind, key, 'short')];
  return {
    moves: lib.choices('action').filter(i => onOrderSheet(i)).map(i => ({ key: i.key, names: both('action', i.key) })),
    levels: lib.choices('level').filter(i => onOrderSheet(i)).map(i => ({ key: i.key, names: both('level', i.key) })),
    patterns: lib.choices('pattern').filter(i => onOrderSheet(i)).map(i => ({ key: i.key, names: both('pattern', i.key) })),
    setups: setupsByUse(lib, state.journalReview?.labels || {}).filter(i => setupOffered(lib, i.key)).map(i => ({ key: i.key, names: setupSearchNames(lib, i.key), parts: lib.parts(i.key) })),
    tactics: lib.choices('tactic').filter(i => onOrderSheet(i)).map(i => ({ key: i.key, names: [i.name] })),
    move: moveOf(t, lib),
  };
}
const quickLine = (t, lib) => readQuickLine(state.tradeQuickText || '', quickLists(t, lib));
/** a setup's words by its parts: the one of My setups made of them, else the name a new one would get */
const partsName = (lib, p, side) => { const have = setupOfParts(lib, p); return have ? lib.nameOf('setup', have.key, side) : setupName(lib, p, side); };

/** under the line: what Enter puts on and what didn't match, the move a lone move word turned to, or what's still missing */
function quickPreview(t, lib) {
  if (!(state.tradeQuickText || '').trim()) { const need = needWords(t); return need ? `<span class="tp-need">${need}</span>` : ''; }
  const p = quickLine(t, lib), side = sideOf(t);
  const said = [...p.setups.map(s => partsName(lib, s, side)), ...p.tactics.map(k => lib.nameOf('tactic', k)), ...(p.grade ? [`Grade ${p.grade}`] : [])];
  const lone = !said.length && p.last.move && !p.last.setups.length ? `<b>${esc(moveName(lib, p.last.move, side))}</b> at… type the level` : '';
  return (said.length ? `<kbd>Enter</kbd> puts on <b>${esc(said.join(' · '))}</b>` : lone)
    + (p.unmatched.length ? `${said.length || lone ? ' · ' : ''}<span class="tp-need">no match: ${esc(p.unmatched.join(', '))}</span>` : '');
}
/**
 * Typing: the picker follows the part you're typing (a move word turns it, a level opens in Level first) and rings what
 * Enter will put on; the line itself isn't redrawn, so the cursor stays put.
 */
export function tradeQuickInput(value) {
  state.tradeQuickText = String(value || '');
  const t = state.tradeTicket;
  if (!t || !state.journalReview || state.journalReviewError) return;
  if (t.backArmed) { t.backArmed = false; renderTradePlan(); return; }
  const lib = library(), last = quickLine(t, lib).last;
  if (last.move && last.move !== moveOf(t, lib)) t.pickMove = last.move;
  const one = last.setups[0];
  if (one && !one.pattern && one.levels?.length === 1) t.openLevel = one.levels[0];
  const ring = quickRing(t, lib);
  for (const [id, html] of [['tradeQuickPreview', quickPreview(t, lib)], ['tradePickSetup', setupPickerHtml(t, lib, ring)], ['tradePickTactic', tacticPickerHtml(t, lib, ring)], ['tradePickGrade', gradeHtml(t, ring)]]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}
/** Enter: what it reads as goes on (nothing comes off; a setup never made is made), the grade is set, and the line clears for the next */
export function applyTradeQuick() {
  const t = state.tradeTicket;
  if (!canPick(t) || !(state.tradeQuickText || '').trim()) return;
  const p = quickLine(t, library());
  if (!p.setups.length && !p.tactics.length && !p.grade) return;
  const saves = p.setups.filter(s => !pickedOf(t, library(), s)).map(s => addParts(t, s)).filter(Boolean);
  t.tactics = [...t.tactics, ...p.tactics.filter(k => !t.tactics.includes(k))];
  if (p.grade) t.setupGrade = p.grade;
  state.tradeQuickText = '';
  picked(t);
  document.getElementById('tradeQuick')?.focus();
  return Promise.all(saves.map(save => save()));
}
/** Esc in the typed line: text clears first (true); an empty line lets Esc close the sheet */
export function clearTradeQuick() {
  if (!(state.tradeQuickText || '')) return false;
  state.tradeQuickText = '';
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById('tradeQuick'));
  if (box) box.value = '';
  tradeQuickInput('');
  return true;
}
/**
 * Backspace in an empty typed line: the first marks the last pick (the grade, else the last tactic, else the last setup),
 * the second takes it off. True when it did either.
 */
export function tradeQuickBackspace() {
  const t = state.tradeTicket;
  if (!canPick(t) || state.tradeQuickText || (!t.setups.length && !t.tactics.length && !t.setupGrade)) return false;
  if (!t.backArmed) { t.backArmed = true; renderTradePlan(); return true; }
  if (t.setupGrade) t.setupGrade = '';
  else if (t.tactics.length) t.tactics = t.tactics.slice(0, -1);
  else t.setups = t.setups.slice(0, -1);
  picked(t);
  return true;
}

// ---------- saved once the order goes ----------

/** the Schwab account's value now (a fresh read), else today's daily read; { value: null } when neither */
async function accountValue(hash) {
  try {
    const v = Math.round(Number((await schwabBalances(hash))?.currentBalances?.liquidationValue) || 0);
    if (v > 0) return { value: v, at: new Date().toISOString() };
  } catch(e) {}
  return todaysAccountValue(hash) || { value: null, at: null };
}

/** the whole row the first save sends */
function planRow(t, v) {
  const acct = schwabAccounts().find(a => a.hash === t.hash);
  return {
    id: t.planId, account: acct ? acct.last4 : '', symbol: t.symbol, side: sideOf(t), order_ids: [...t.planOrderIds], sent_at: t.planSentAt,
    setups: [...t.setups], tactics: [...t.tactics], setup_grade: t.setupGrade || null,
    plan: { ...t.planCtx, qty: t.qty, entry_type: t.entryType, entry: t.entry, stop: t.stop, planned_risk: round2(t.plannedRisk), fill_risk: round2(t.fillRisk), schwab_value: v.value, schwab_value_at: v.at },
  };
}

/** saves one after another: the first sends the whole plan, later ones only the picks (an Edit may have added ids and edits since) */
function queuePlanSave(t) {
  const first = !t.planSaved;
  t.planSaved = true;
  t.planChain = (t.planChain || Promise.resolve()).then(async () => {
    if (first) await saveOrderPlan(planRow(t, await t.planValue));
    else await updateOrderPlan(t.planId, { setups: [...t.setups], tactics: [...t.tactics], setup_grade: t.setupGrade || null });
  }).catch(e => showError(e?.gradeOnly ? `Order sent and its plan saved, but not the setup grade: ${e.message}`
    : `Order sent. Its plan wasn't saved for the journal: ${String(e?.message || e)}`));
  return t.planChain;
}

/**
 * The order went (or may have: a lost answer saves no id, and the journal finds its trade by time): keep its plan. Signed
 * out, nothing is kept. Never before the send, and never in its way.
 */
export function saveTradePlan(t) {
  if (!state.session || t.planId) return Promise.resolve();
  t.planId = newId();
  t.planSentAt = new Date().toISOString();
  t.planOrderIds = t.orderId ? [String(t.orderId)] : [];
  t.planValue = accountValue(t.hash);
  return queuePlanSave(t);
}

// ---------- the journal ----------

/**
 * Read the plans and match them to the journal's trades (state.orderPlanMatch, for the trade page). A plan's labels go on
 * its trade once: the first time they meet, for a kind the trade has none of, marked as the app's; its setup grade too, when
 * the trade's review has none. The plan then keeps the trade's key, so a label you take off or a grade you change stays.
 * @param {() => any[]} trades the journal's trades now
 * @returns {Promise<number>} how many trades got labels
 */
export async function applyOrderPlans(trades) {
  try { state.orderPlans = await loadOrderPlans(); state.orderPlansError = ''; }
  catch(e) { state.orderPlansError = String(e?.message || e); return 0; }
  const list = trades();
  state.orderPlanMatch = matchPlans(list, state.orderPlans);
  if (!state.journalReview || state.journalReviewError) return 0;
  let labeled = 0;
  for (const [key, plans] of state.orderPlanMatch) {
    const fresh = plans.filter(p => p.trade_key === null);
    if (!fresh.length) continue;
    const labels = state.journalReview.labels[key] ||= [];
    const met = plans.some(p => p.trade_key === key);
    const add = met ? [] : planLabels(plans, labels);
    const grade = met ? null : planGrade(plans, state.journalReview.reviews[key]);
    try {
      if (add.length) {
        await addAppLabels(key, add, 'Picked when the order was placed');
        for (const [kind, value] of add) labels.push({ kind, value, set_by: 'app', links: [] });
      }
      if (grade) {
        await saveReviewFields(key, { setup_grade: grade });
        state.journalReview.reviews[key] = { ...(state.journalReview.reviews[key] || {}), setup_grade: grade };
      }
      if (add.length || grade) labeled++;
      for (const p of fresh) { await updateOrderPlan(p.id, { trade_key: key }); p.trade_key = key; }
    } catch(e) {
      state.orderPlansError = String(e?.message || e);
      break;
    }
  }
  return labeled;
}

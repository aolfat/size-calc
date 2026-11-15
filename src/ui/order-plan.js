// Order plans (docs/schwab.md, docs/journal.md): the Trade at Schwab sheet's setup, setup grade and entry tactic picks
// (today's focus list and the opening range fill them in), what the calculator knew when the review opened (core/order-plans.js PlanNumbers:
// the risk, the account size, how the stop was set), the plan saved once the order goes and picks changed after, and the
// journal putting each plan's labels and grade on its trade once (services/order-plans.js).
import { state } from '../state.js';
import { marketEscape as esc, nyDateStr } from '../core/format.js';
import { buildLibrary, goesBy, GRADES, levelPickGroups, onOrderSheet, parseQuickPick, sameParts, setupName, setupOfParts, setupsByUse, setupSearchNames } from '../core/journal-labels.js';
import { matchPlans, planGrade, planLabels } from '../core/order-plans.js';
import { addAppLabels, saveLibraryItem, saveReviewFields } from '../services/journal-review.js';
import { loadOrderPlans, saveOrderPlan, updateOrderPlan } from '../services/order-plans.js';
import { schwabAccounts, schwabBalances } from '../services/schwab.js';
import { accountSizeFromSchwab, todaysAccountValue } from './account-size.js';
import { showError } from './feedback.js';
import { loadJournalReview, pickGroupsHtml, tacticGroupsHtml } from './journal-review.js';
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
    if (state.tradeTicket === t) renderTradePlan();
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
/** the move the picker shows: the one you tapped, else the first picked setup's, else the first move */
function moveOf(t, lib) {
  if (t.pickMove) return t.pickMove;
  const p = t.setups.map(k => lib.parts(k)).find(p => p.pattern || p.action);
  return p ? (p.pattern ? PATTERN : p.action) : lib.choices('action').find(i => onOrderSheet(i))?.key || PATTERN;
}
/** the setup on the ticket made of these parts, if any */
const pickedOf = (t, lib, parts) => t.setups.find(k => sameParts(lib.parts(k), parts));

/** what you picked, read back in one line; each tap takes it off; what's missing in amber (Place never waits for it) */
function planLineHtml(t, lib) {
  const side = sideOf(t), off = picksOff(t);
  const tacticName = key => lib.nameOf('tactic', key);
  const item = (label, attrs, cls = '') => `<button class="tp-picked${cls}" ${attrs}${off}>${esc(label)}<span aria-hidden="true">×</span></button>`;
  const parts = [
    ...t.setups.map(k => item(lib.nameOf('setup', k, side), `data-action="toggleTradeSetup" data-arg="${esc(k)}" title="Take this setup off"`)),
    ...t.tactics.map(k => item(tacticName(k), `data-action="toggleTradeTactic" data-arg="${esc(k)}" title="Take this tactic off"`)),
    ...(t.setupGrade ? [item(t.setupGrade, `data-action="setTradeGrade" data-arg="${t.setupGrade}" title="Clear the grade"`, ` tp-picked-grade g-${t.setupGrade}`)] : []),
  ];
  const missing = [!t.setups.length && 'setup', !t.tactics.length && 'tactic', !t.setupGrade && 'grade'].filter(Boolean);
  const need = missing.length ? `<span class="tp-need">No ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} or ${missing.at(-1)}` : missing[0]} yet</span>` : '';
  return `<div class="tp-line" id="tradePlanLine">${parts.join('') || ''}${need}</div>`;
}

/** the setup picker: what happened (a move, or Pattern), then at what; a level that move hasn't been paired with is dashed and a tap makes it */
function setupPickerHtml(t, lib) {
  const side = sideOf(t), move = moveOf(t, lib), off = picksOff(t);
  const moves = lib.choices('action').filter(i => onOrderSheet(i) || move === i.key);
  const seg = (key, label) => `<button class="${move === key ? 'active' : ''}" aria-pressed="${move === key}" data-action="setTradeMove" data-arg="${esc(key)}"${off}>${esc(label)}</button>`;
  const head = `<div class="seg tp-moves" role="group" aria-label="What happened">${moves.map(i => seg(i.key, cap(lib.nameOf('action', i.key, side)))).join('')}${seg(PATTERN, 'Pattern')}</div>`;
  if (move === PATTERN) {
    const items = lib.choices('pattern').filter(i => onOrderSheet(i) || pickedOf(t, lib, { pattern: i.key }));
    return head + `<div class="tp-groups" id="tradeSetupPick">${items.length ? pickGroupsHtml([{ name: 'Pattern', items: items.map(i => ({ key: i.key, label: lib.nameOf('pattern', i.key, side) })) }], i => {
      const parts = { pattern: i.key }, made = !!setupOfParts(lib, parts);
      return chip(i.label, !!pickedOf(t, lib, parts), `data-action="pickTradePattern" data-arg="${esc(i.key)}" title="${esc(made ? i.label : `${i.label}: a tap adds it to My setups`)}"${off}`, made ? '' : ' tp-new');
    }) : '<p class="jr-none">No patterns yet. Add them in Edit setups.</p>'}</div>`;
  }
  const levels = lib.choices('level').filter(i => onOrderSheet(i) || pickedOf(t, lib, { action: move, levels: [i.key] }));
  let fresh = false;
  const groups = pickGroupsHtml(levelPickGroups(levels.map(i => ({ key: i.key, name: lib.nameOf('level', i.key, side) }))), i => {
    const parts = { action: move, levels: [i.key] }, made = !!setupOfParts(lib, parts), name = setupName(lib, parts, side);
    if (!made) fresh = true;
    return chip(i.label, !!pickedOf(t, lib, parts), `data-action="pickTradeLevel" data-arg="${esc(i.key)}" title="${esc(made ? name : `${name}: a tap adds it to My setups`)}"${off}`, made ? '' : ' tp-new');
  });
  return head + `<div class="tp-groups" id="tradeSetupPick">${groups || '<p class="jr-none">No levels yet. Add them in Edit setups.</p>'}</div>`
    + (fresh ? '<p class="jr-none">Dashed: not in My setups yet. A tap adds it.</p>' : '');
}

/** entry tactics by timeframe, then + New, which takes a name */
function tacticPickerHtml(t, lib) {
  const off = picksOff(t);
  const items = lib.choices('tactic').filter(i => onOrderSheet(i) || t.tactics.includes(i.key));
  const add = t.addingTactic
    ? `<span class="jr-newbox tp-newbox"><input type="text" id="tradeNewTactic" maxlength="80" placeholder="15m flag break" autocomplete="off" spellcheck="false" data-enter="addTradeTactic" aria-label="New entry tactic" /><button class="btn" data-action="addTradeTactic">Add</button><button class="pos-link" data-action="cancelTradeTactic">Cancel</button></span>`
    : `<button class="filter-btn tp-new" data-action="startTradeTactic" title="Add an entry tactic to your library and pick it"${off}>+ New</button>`;
  const groups = tacticGroupsHtml(items, i => chip(i.label, t.tactics.includes(i.key), `data-action="toggleTradeTactic" data-arg="${esc(i.key)}" title="${esc(i.name)}"${off}`));
  return `<div class="tp-groups">${groups}${groups ? '' : '<p class="jr-none">No entry tactics yet.</p>'}<div class="tp-add">${add}</div></div>`;
}

/** the plan line, then Setup, Entry tactic and Grade, or why they can't show */
export function tradePlanHtml(t) {
  if (!state.session) return '<p class="hint">Sign in with Google to keep the setup, tactic and plan with the order.</p>';
  if (state.journalReviewError) return `<p class="hint" style="color:var(--amber)">Your setups couldn't load: ${esc(state.journalReviewError)}. The plan's numbers are still saved with the order.</p>`;
  if (!state.journalReview) return '<p class="hint">Loading your setups…</p>';
  const lib = library(), off = picksOff(t);
  // desktop only (CSS): the whole plan typed on one line
  const quick = `<div class="tp-quick"><input type="text" id="tradeQuick" class="jr-search" placeholder="Type it: 21 ur, 15 orb, a" autocomplete="off" spellcheck="false" value="${esc(state.tradeQuickText || '')}" data-input="tradeQuickInput" data-enter="applyTradeQuick" aria-label="Type the setup, entry tactic and grade, separated by commas; Enter picks them"${off} /><span class="tp-quick-preview" id="tradeQuickPreview" role="status">${quickPreview(t, lib)}</span></div>`;
  const grade = `<div class="tp-grades" role="group" aria-label="Setup grade">${GRADES.map(g => `<button class="tp-grade-btn g-${g}${t.setupGrade === g ? ' active' : ''}" aria-pressed="${t.setupGrade === g}" data-action="setTradeGrade" data-arg="${g}" title="How good the setup is: ${g}"${off}>${g}</button>`).join('')}</div>`;
  return `<div class="trade-plan-picks">
      ${planLineHtml(t, lib)}
      ${quick}
      <div class="tp-title">Setup</div>
      ${setupPickerHtml(t, lib)}
      <div class="tp-title">Entry tactic</div>
      ${tacticPickerHtml(t, lib)}
      <div class="tp-title">Grade</div>
      ${grade}
    </div>
    <p class="hint">Saved with the order. The journal puts them on the trade once it fills.</p>`;
}

/** only the picks redraw */
function renderTradePlan() {
  const el = document.getElementById('tradePlan');
  if (el && state.tradeTicket) el.innerHTML = tradePlanHtml(state.tradeTicket);
}

/** a pick changed: drawn, and saved with the plan once there is one */
function picked(t) {
  t.picksTouched = true;
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

/**
 * The setup these parts make goes on the ticket, or comes off if it's on. One of My setups made of them is used; with none,
 * a new one, named for its parts as the journal's + New setup names it, goes into My setups first (taken back out of the
 * ticket if the save fails).
 */
function pickParts(parts) {
  const t = state.tradeTicket;
  if (!canPick(t)) return;
  const lib = library(), on = pickedOf(t, lib, parts);
  if (on) { t.setups = t.setups.filter(k => k !== on); return picked(t); }
  const have = setupOfParts(lib, parts);
  if (have) { t.setups = [...t.setups, have.key]; return picked(t); }
  const name = setupName(lib, parts);
  if (!name) return;
  const row = { id: newId(), kind: 'setup', name, settings: parts }, key = `mine:${row.id}`;
  state.journalReview.library = [...state.journalReview.library, row];
  t.setups = [...t.setups, key];
  picked(t);
  return saveLibraryItem(row).catch(e => {
    if (state.journalReview) state.journalReview.library = state.journalReview.library.filter(r => r.id !== row.id);
    t.setups = t.setups.filter(k => k !== key);
    showError(`Couldn't add ${name} to My setups: ${String(e?.message || e)}`);
    picked(t);
  });
}
export function pickTradeLevel(level) {
  const t = state.tradeTicket, move = t && moveOf(t, library());
  if (!t || !move || move === PATTERN || typeof level !== 'string' || !library().item('level', level)) return;
  return pickParts({ action: move, levels: [level] });
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

/** what the typed line reads as, with your setups most used first and only what the sheet offers */
function quickParse(lib) {
  const setups = setupsByUse(lib, state.journalReview?.labels || {}).filter(i => setupOffered(lib, i.key)).map(i => ({ key: i.key, names: setupSearchNames(lib, i.key) }));
  const tactics = lib.choices('tactic').filter(i => onOrderSheet(i)).map(i => ({ key: i.key, names: [i.name] }));
  return parseQuickPick(state.tradeQuickText || '', setups, tactics);
}
function quickPreview(t, lib) {
  if (!(state.tradeQuickText || '').trim()) return '';
  const p = quickParse(lib), side = sideOf(t);
  const said = [...p.setups.map(k => lib.nameOf('setup', k, side)), ...p.tactics.map(k => lib.nameOf('tactic', k)), ...(p.grade ? [p.grade] : [])];
  return esc(said.join(' · ')) + (p.unmatched.length ? `${said.length ? ' · ' : ''}<span class="tp-need">no match: ${esc(p.unmatched.join(', '))}</span>` : '');
}
/** typing: only the line under it redraws */
export function tradeQuickInput(value) {
  state.tradeQuickText = String(value || '');
  const el = document.getElementById('tradeQuickPreview');
  if (el && state.tradeTicket && state.journalReview) el.innerHTML = quickPreview(state.tradeTicket, library());
}
/** Enter: what it reads as goes on (nothing comes off), the grade is set, and the line clears for the next */
export function applyTradeQuick() {
  const t = state.tradeTicket;
  if (!canPick(t) || !(state.tradeQuickText || '').trim()) return;
  const p = quickParse(library());
  if (!p.setups.length && !p.tactics.length && !p.grade) return;
  t.setups = [...t.setups, ...p.setups.filter(k => !t.setups.includes(k))];
  t.tactics = [...t.tactics, ...p.tactics.filter(k => !t.tactics.includes(k))];
  if (p.grade) t.setupGrade = p.grade;
  state.tradeQuickText = '';
  picked(t);
  document.getElementById('tradeQuick')?.focus();
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

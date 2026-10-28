// Order plans (docs/schwab.md, docs/journal.md): the Trade at Schwab sheet's setup and entry tactic picks (today's focus list
// and the opening range fill them in), what the calculator knew when the review opened (core/order-plans.js PlanNumbers:
// the risk, the account size, how the stop was set), the plan saved once the order goes and picks changed after, and the
// journal putting each plan's labels on its trade once (services/order-plans.js).
import { state } from '../state.js';
import { marketEscape as esc, nyDateStr } from '../core/format.js';
import { buildLibrary, matchesQuery, setupsByUse, setupSearchNames } from '../core/journal-labels.js';
import { matchPlans, planLabels } from '../core/order-plans.js';
import { addAppLabels } from '../services/journal-review.js';
import { loadOrderPlans, saveOrderPlan, updateOrderPlan } from '../services/order-plans.js';
import { schwabAccounts, schwabBalances } from '../services/schwab.js';
import { accountSizeFromSchwab, todaysAccountValue } from './account-size.js';
import { showError } from './feedback.js';
import { loadJournalReview } from './journal-review.js';
import { orbActive, orbStopName } from './orb.js';
import { riskDollars } from './risk.js';
import { currentAtr5, dayRange, rawStop } from './stops.js';

/** the most setup chips the sheet shows before you search (the ones on always show) */
const SETUP_CHIPS = 12;
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
    max_loss: round2(riskDollars()), account_size: num('accountSize'), account_source: accountSizeFromSchwab() ? 'schwab' : 'typed', risk_pct: num('riskPct'),
    stop_source: source, stop_strategy: strategy,
    stop_amount: strategy === 'atr' ? state.atrMultiplier : strategy === 'percent' && Number.isFinite(state.stopPercent) ? state.stopPercent : null,
    stop_level: (isLong ? range.low : range.high) || null, stop_level_name: isLong ? 'LOD' : 'HOD', ext_hours: !!range.ext,
    atr5: atr && Number.isFinite(atr.value) ? atr.value : null, stop_planned: Number.isFinite(stopPlanned) ? stopPlanned : null,
    orb_minutes: orb ? orb.minutes : null,
  };
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
  const focus = (state.journalReview.days?.[nyDateStr(new Date())]?.focus_list || []).find(f => f.symbol === t.symbol && (!f.side || f.side === side));
  const setups = lib.choices('setup').map(i => i.key);
  t.setups = [...new Set((focus?.setups || []).map(k => lib.resolve('setup', k)).filter(k => setups.includes(k)))];
  const tactic = ORB_TACTICS[t.planCtx?.orb_minutes];
  t.tactics = tactic && lib.choices('tactic').some(i => i.key === tactic) ? [tactic] : [];
}

const chip = (label, on, attrs) => `<button class="filter-btn${on ? ' active' : ''}" aria-pressed="${on}" ${attrs}>${esc(label)}</button>`;
/** picks can change until the order goes, and after it while its plan is kept */
const picksOff = t => t.sent && !t.planId ? ' disabled' : '';

/**
 * The setup chips in one order for the whole review, set the first time they show: the ones filled in first, then the most
 * used. Tapping one lights it where it is, so nothing moves under your finger; a search only hides the ones that don't match.
 */
function setupChipsHtml(t) {
  const lib = library(), side = sideOf(t), q = state.tradeSetupQuery || '';
  t.setupOrder ||= [...t.setups, ...setupsByUse(lib, state.journalReview?.labels || {}).map(i => i.key).filter(k => !t.setups.includes(k))];
  // without a search, the first SETUP_CHIPS always (and any lit one past them); with one, the first SETUP_CHIPS that match
  let room = SETUP_CHIPS;
  const shown = t.setupOrder.filter((k, i) => t.setups.includes(k) || (q ? matchesQuery(setupSearchNames(lib, k), q) && room-- > 0 : i < SETUP_CHIPS));
  if (q && !shown.length) return `<p class="jr-none">No setup matches “${esc(q)}”.</p>`;
  return shown.map(k => chip(lib.nameOf('setup', k, side), t.setups.includes(k), `data-action="toggleTradeSetup" data-arg="${esc(k)}"${picksOff(t)}`)).join('');
}

/** the Setup and Entry tactic rows, or why they can't show */
export function tradePlanHtml(t) {
  if (!state.session) return '<p class="hint">Sign in with Google to keep the setup, tactic and plan with the order.</p>';
  if (state.journalReviewError) return `<p class="hint" style="color:var(--amber)">Your setups couldn't load: ${esc(state.journalReviewError)}. The plan's numbers are still saved with the order.</p>`;
  if (!state.journalReview) return '<p class="hint">Loading your setups…</p>';
  const lib = library();
  const tactics = lib.choices('tactic').map(i => chip(i.name, t.tactics.includes(i.key), `data-action="toggleTradeTactic" data-arg="${esc(i.key)}"${picksOff(t)}`)).join('');
  return `<dl class="trade-legs trade-plan-picks">
      <div><dt>Setup</dt><dd><input type="search" class="jr-search" id="tradeSetupSearch" placeholder="Search setups" autocomplete="off" spellcheck="false" value="${esc(state.tradeSetupQuery || '')}" data-input="tradeSetupSearch" aria-label="Search My setups" /><div class="chip-row jr-chips trade-chips" id="tradeSetupPick">${setupChipsHtml(t)}</div></dd></div>
      <div><dt>Entry tactic</dt><dd><div class="chip-row jr-chips trade-chips">${tactics || '<span class="jr-none">No entry tactics yet. Add them on a journal trade.</span>'}</div></dd></div>
    </dl>
    <p class="hint">Saved with the order. The journal puts them on the trade once it fills.</p>`;
}

/** only the picks redraw, so the search keeps its cursor */
function renderTradePlan() {
  const el = document.getElementById('tradePlan');
  if (el && state.tradeTicket) el.innerHTML = tradePlanHtml(state.tradeTicket);
}

function togglePick(field, key) {
  const t = state.tradeTicket;
  if (!t || t.error || picksOff(t) || typeof key !== 'string' || !key) return;
  t.picksTouched = true;
  t[field] = t[field].includes(key) ? t[field].filter(k => k !== key) : [...t[field], key];
  renderTradePlan();
  if (t.planId) queuePlanSave(t);
}
export function toggleTradeSetup(key) { togglePick('setups', key); }
export function toggleTradeTactic(key) { togglePick('tactics', key); }

/** typing in the setup search: only the chips under it redraw */
export function tradeSetupSearch(value) {
  state.tradeSetupQuery = String(value || '');
  const el = document.getElementById('tradeSetupPick');
  if (el && state.tradeTicket) el.innerHTML = setupChipsHtml(state.tradeTicket);
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
    setups: [...t.setups], tactics: [...t.tactics],
    plan: { ...t.planCtx, qty: t.qty, entry_type: t.entryType, entry: t.entry, stop: t.stop, planned_risk: round2(t.plannedRisk), fill_risk: round2(t.fillRisk), schwab_value: v.value, schwab_value_at: v.at },
  };
}

/** saves one after another: the first sends the whole plan, later ones only the picks (an Edit may have added ids and edits since) */
function queuePlanSave(t) {
  const first = !t.planSaved;
  t.planSaved = true;
  t.planChain = (t.planChain || Promise.resolve()).then(async () => {
    if (first) await saveOrderPlan(planRow(t, await t.planValue));
    else await updateOrderPlan(t.planId, { setups: [...t.setups], tactics: [...t.tactics] });
  }).catch(e => showError(`Order sent. Its plan wasn't saved for the journal: ${String(e?.message || e)}`));
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
 * its trade once: the first time they meet, for a kind the trade has none of, marked as the app's; the plan then keeps the
 * trade's key, so a label you take off stays off.
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
    const add = plans.some(p => p.trade_key === key) ? [] : planLabels(plans, labels);
    try {
      if (add.length) {
        await addAppLabels(key, add, 'Picked when the order was placed');
        for (const [kind, value] of add) labels.push({ kind, value, set_by: 'app', links: [] });
        labeled++;
      }
      for (const p of fresh) { await updateOrderPlan(p.id, { trade_key: key }); p.trade_key = key; }
    } catch(e) {
      state.orderPlansError = String(e?.message || e);
      break;
    }
  }
  return labeled;
}

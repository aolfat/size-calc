// The review deck (journal step 3, slice 2; docs/journal-step-3.md; state.journalDeck): the trades that need a pass, one
// card after another, each the trade page in deck mode with the deck bar (count, pass, Back, Next, Save for the weekly
// review, Done) and P&L hidden until you grade; the end screen; the Journal tab's count; Review N trades and the
// Journal's line, with the day reviewing starts from. The queue is every trade that needs a pass and opened on or after
// that day, newest first, with no other filters (journal-review.js reviewQueue).
import { marketEscape as esc } from '../core/format.js';
import { fromReviewDay, reviewFromDay } from '../core/journal-labels.js';
import { nyParts } from '../core/journal-stats.js';
import { store } from '../lib/store.js';
import { state } from '../state.js';
import { showToast } from './feedback.js';
import { journalTradeList, renderJournal } from './journal.js';
import { reviewFrom, reviewQueue, savedForWeekly, toggleWeekly, tradePass } from './journal-review.js';
import { journalPageTrade, openJournalTrade, syncJournalPage } from './journal-trade.js';

const PASS_WORDS = { opening: 'Opening pass', closing: 'Closing pass: the grade and note', full: '' };
const trades = () => journalTradeList();
const byKey = (list, key) => list.find(t => t.key === key) || null;

/** the Journal tab's count: the trades waiting in the deck (blank until the journal has been read, or when none) */
export function syncJournalBadge(list) {
  const el = document.getElementById('journalCount');
  if (!el) return;
  const n = state.session && list ? reviewQueue(list).length : 0;
  el.textContent = n ? String(n) : '';
}

/** Review N trades in the Journal's header (hidden when nothing is waiting) */
export function deckButtonHtml(list) {
  const n = reviewQueue(list).length;
  return n ? `<button class="btn primary" id="journalDeckBtn" data-action="startReviewDeck">Review ${n} trade${n === 1 ? '' : 's'}</button>` : '';
}

/**
 * the Journal's line: "12 trades to review · Start", or "All reviewed", then Review from (a day: older trades leave the
 * deck, the count says how many) with All days to take it back; nothing before the reviews are read
 */
export function deckLineHtml(list) {
  if (!state.journalReview || state.journalReviewError || !list.some(t => t.status !== 'history' && !t.deleted)) return '';
  const n = reviewQueue(list).length, from = reviewFrom();
  if (!n && !from) return '<p class="hint jr-queue" role="status">All reviewed</p>';
  const older = from ? list.filter(t => !fromReviewDay(t, from) && tradePass(t)).length : 0;
  const today = nyParts(new Date().toISOString()).day;
  return `<p class="hint jr-queue" role="status">${n ? `${n} trade${n === 1 ? '' : 's'} to review · <button class="pos-link" data-action="startReviewDeck">Start</button>` : 'All reviewed'}
    · <label class="jr-from">Review from <input type="date" id="journalReviewFrom" value="${from}" max="${today}" data-change="setReviewFrom" aria-label="Review trades opened from this day" /></label>${from
      ? ` <button class="pos-link" data-action="clearReviewFrom">All days</button>${older ? ` · ${older} older left out` : ''}` : ''}</p>`;
}

/** Review from: trades opened before the day leave the deck, the count and To review (journal_review_from, synced); '' = every day */
export function setReviewFrom(v) {
  store.set('journal_review_from', reviewFromDay(v));
  renderJournal();
}

/** start the deck: the whole queue, or the given keys (the ones skipped last time) */
export function startReviewDeck(keys) {
  const list = trades();
  const queue = Array.isArray(keys) ? keys.filter(k => { const t = byKey(list, k); return t && tradePass(t); }) : reviewQueue(list).map(t => t.key);
  if (!queue.length) { showToast('Nothing to review.'); return; }
  state.journalDeck = { keys: queue, at: 0, seen: [queue[0]], shown: [], finished: false };
  openJournalTrade(queue[0]);
}

/** Go through the N skipped, from the end screen */
export function reviewSkipped() { startReviewDeck(deckTally().skipped); }

/** Next: on to the next trade still waiting, finished or not; a trade gone, or reviewed elsewhere meanwhile, is passed over */
export function deckNext() {
  const d = state.journalDeck;
  if (!d || d.finished) return;
  const list = trades();
  for (let i = d.at + 1; i < d.keys.length; i++) {
    const t = byKey(list, d.keys[i]);
    if (t && (d.seen.includes(t.key) || tradePass(t))) return goTo(i);
  }
  finish();
}

/** Back: the card before (from the end screen, the last one) */
export function deckBack() {
  const d = state.journalDeck;
  if (!d) return;
  const list = trades();
  for (let i = (d.finished ? d.keys.length : d.at) - 1; i >= 0; i--) if (byKey(list, d.keys[i])) { d.finished = false; return goTo(i); }
}

function goTo(i) {
  const d = state.journalDeck;
  d.at = i;
  if (!d.seen.includes(d.keys[i])) d.seen.push(d.keys[i]);
  openJournalTrade(d.keys[i]);
}

function finish() {
  state.journalDeck.finished = true;
  state.journalTrade = null;
  syncJournalPage();
  renderDeckEnd();
  window.scrollTo?.({ top: 0 });
}

/** Done: back to the list (closeJournalTrade ends the deck too) */
export function endReviewDeck() {
  state.journalDeck = null;
  state.journalTrade = null;
  renderJournal();
}

/** what the deck got through: the cards seen whose pass is done, the ones still waiting, and those saved for the weekly review */
export function deckTally() {
  const d = state.journalDeck, list = trades();
  const seen = (d?.seen || []).map(k => byKey(list, k)).filter(Boolean);
  return {
    done: seen.filter(t => !tradePass(t)).length,
    skipped: seen.filter(t => tradePass(t)).map(t => t.key),
    weekly: (d?.keys || []).map(k => byKey(list, k)).filter(t => t && savedForWeekly(t)).length,
  };
}

/** the deck bar on a card: where you are, the pass, Back, Next, Save for the weekly review, Done */
export function deckBarHtml(t) {
  const d = state.journalDeck;
  if (!d || d.finished) return '';
  const pass = tradePass(t);
  const passWords = pass ? PASS_WORDS[pass] : t.status === 'open' ? 'Opening pass done' : 'Reviewed';
  const weekly = savedForWeekly(t);
  return `<div class="jt-deck" id="jtDeckBar" role="toolbar" aria-label="Review deck">
      <span class="jt-deck-count">${d.at + 1} of ${d.keys.length}</span>
      ${passWords ? `<span class="jt-deck-pass${pass ? '' : ' journal-buy'}">${esc(passWords)}</span>` : ''}
      <span class="jt-deck-acts">
        <button class="btn" data-action="toggleDeckWeekly" aria-pressed="${weekly}" title="Saved trades come back in the weekly review">${weekly ? 'Saved for weekly ✓' : 'Save for weekly'}</button>
        <button class="btn" data-action="deckBack"${d.at === 0 ? ' disabled' : ''} aria-label="Back (←)">‹ Back</button>
        <button class="btn primary" data-action="deckNext" aria-label="Next (→)">Next ›</button>
        <button class="btn" data-action="endReviewDeck" title="Leave the deck (Esc)">Done</button>
      </span>
    </div>`;
}

export function toggleDeckWeekly() {
  const t = journalPageTrade();
  return t ? toggleWeekly(t) : undefined;
}

// ---------- P&L hidden until you grade ----------

/** "Always show" or "Hide until I grade" (journal_deck_pnl, synced with your account) */
export const deckPnlAlways = () => store.get('journal_deck_pnl') === 'always';
export function setDeckPnl(v) { store.set('journal_deck_pnl', v === 'always' ? 'always' : 'graded'); renderJournal(); }

/** in the deck, before the setup grade, P&L, R and exit efficiency wait (Show reveals them for this card) */
export function deckHidesPnl(t) {
  const d = state.journalDeck;
  if (!d || d.finished || deckPnlAlways() || d.shown.includes(t.key)) return false;
  return !state.journalReview?.reviews?.[t.key]?.setup_grade;
}
export function revealDeckPnl() {
  const d = state.journalDeck, t = journalPageTrade();
  if (!d || !t) return;
  d.shown.push(t.key);
  renderJournal();
}

/** under the stats in the deck: what the P&L does, and the switch */
export function deckPnlNote() {
  if (!state.journalDeck || state.journalDeck.finished) return '';
  return deckPnlAlways()
    ? '<p class="hint jt-deck-pnl">P&amp;L shown up front in the deck · <button class="pos-link" data-action="setDeckPnl" data-arg="graded">Hide until I grade</button></p>'
    : '<p class="hint jt-deck-pnl">P&amp;L hidden until you grade · <button class="pos-link" data-action="setDeckPnl" data-arg="always">Always show</button></p>';
}

// ---------- the end ----------

export function renderDeckEnd() {
  const head = document.getElementById('jtHead'), body = document.getElementById('jtBody');
  if (!head || !state.journalDeck?.finished) return;
  const { done, skipped, weekly } = deckTally();
  const parts = [`${done} done`, `${skipped.length} skipped`, weekly ? `${weekly} saved for the weekly review` : ''].filter(Boolean).join(', ');
  head.innerHTML = `<div class="jt-head"><button class="pos-link" data-action="endReviewDeck">← Trades</button><span class="section-title" id="jtTitle">Review deck</span></div>`;
  document.getElementById('jtCharts').style.display = 'none';
  body.innerHTML = `<div class="jt-deck-end">
      <p class="setup-title" role="status">${skipped.length ? 'End of the deck' : 'All caught up'}: ${esc(parts)}.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${skipped.length ? `<button class="btn primary" data-action="reviewSkipped">Go through the ${skipped.length} skipped</button>` : ''}
        <button class="btn" data-action="deckBack">‹ Back</button>
        <button class="btn${skipped.length ? '' : ' primary'}" data-action="endReviewDeck">Back to trades</button>
      </div>
    </div>`;
}

/** ← and → move through the deck (shortcuts.js; never while typing), Esc leaves it */
export const deckOpen = () => !!state.journalDeck && state.journalView;

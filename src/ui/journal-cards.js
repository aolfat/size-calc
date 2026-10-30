// Phones' Trades tab (PHONE_MQ, docs/journal.md): the review progress card with the week's streak, the Up next card (the
// review deck's next trade: Skip or a left swipe moves on, Start review or a right swipe starts the deck on it), the stats
// line, and a card per trade: Open, then Closed grouped by the day they closed.
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fromReviewDay } from '../core/journal-labels.js';
import { holdWords, legWords, pnlBasis, pnlPct, tradesSummary } from '../core/journal.js';
import { nyParts } from '../core/journal-stats.js';
import { progressDay, reviewDays, reviewStreak, weekDots } from '../core/review-progress.js';
import { state } from '../state.js';
import { startReviewDeck } from './journal-deck.js';
import { reviewFrom, reviewQueue, savedForWeekly, setupGradeOf, setupsOf, toReview, tradePass } from './journal-review.js';
import {
  EXPIRED_TITLE, HISTORY_TITLE, VIA_TITLE, feeSubs, feeWords, isReviewed, journalAfterFees, journalTradeList, nameOf, onWords, pctTitleOf, pickBox,
  pnlClass, pnlTitle, px, renderJournal, restoreLink, reviewsRead, rowOpen, rTitleOf, setupChip, signed$, signedPct, signedR, untagged,
} from './journal.js';

const nyDay = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
/** 'YYYY-MM-DD' in words: 'Oct 28', or 'Tue · Oct 28' with the weekday */
export const dayWords = (day, weekday = false) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' } : {}) }).replace(', ', ' · ');
const today = () => nyParts(new Date().toISOString()).day;
export const unitWord = t => t.legs ? (t.entryQty === 1 ? 'spread' : 'spreads') : t.assetType === 'OPTION' || t.assetType === 'FUTURE' ? (t.entryQty === 1 ? 'ct' : 'cts') : 'shr';
export const tag = (cls, text, title = '') => `<span class="jtc-pill${cls ? ` ${cls}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${text}</span>`;
export const nowrap = parts => parts.filter(Boolean).map(p => `<span class="jtc-nowrap">${p}</span>`).join(' · '); // breaks between the parts, never inside one
/** whole dollars for the stats line: '−$56,764' */
const signedWhole$ = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
/** what's counted in a P&L total: not deleted, not from before your history, and an open trade only once it has exits */
export const counts = t => !t.deleted && t.status !== 'history' && (t.status !== 'open' || !!t.exits);
export const sum = list => list.filter(counts).reduce((s, t) => s + t.pnl, 0);

export const PENCIL = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z M13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- the review progress card: the day's trades, how many are done, the streak and the week ----------

/** the trades the deck counts (from the Review from day), by day; the day the card is about */
export function progress(list) {
  if (!reviewsRead()) return null;
  const from = reviewFrom(), now = today();
  const days = reviewDays(list.filter(t => fromReviewDay(t, from)), t => !!tradePass(t));
  const day = progressDay(days, now, from);
  if (!day) return null;
  const { total, left } = /** @type {{ total: number, left: number }} */ (days.get(day));
  return { day, now, total, left, ...reviewStreak(days, day, from), dots: weekDots(days, day, now) };
}

const DOT_WORDS = { done: 'reviewed', due: 'still to review', future: 'to come', none: 'no trades' };
export function progressHtml(p) {
  if (!p) return '';
  const done = p.total - p.left;
  const title = p.done ? 'Day reviewed' : p.day === p.now ? "Review today's trades" : `Review ${dayWords(p.day)}'s trades`;
  const sub = p.done ? `${p.streak}-day streak · nice work` : `${p.left} left · ${p.before ? `finish to make it a ${p.before + 1}-day streak` : 'finish to start a streak'}`;
  const dots = p.dots.map(d => `<span class="jrp-dot jrp-${d.state}${d.day === p.day ? ' jrp-focus' : ''}" title="${esc(`${dayWords(d.day, true)}: ${DOT_WORDS[d.state]}`)}">${d.label}</span>`).join('');
  return `<section class="jrp${p.done ? ' jrp-done' : ''}" aria-label="Review progress">
      <div class="jrp-row"><h3>${title}</h3><span class="jrp-count">${done}/${p.total}</span></div>
      <div class="jrp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${done}" aria-label="${done} of ${p.total} reviewed"><span style="width:${p.total ? Math.round(done / p.total * 100) : 0}%"></span></div>
      <div class="jrp-row"><span class="jrp-sub">${sub}</span><span class="jrp-week" aria-label="This week">${dots}</span></div>
    </section>`;
}

// ---------- Up next: the deck's next trade, one card on a stack ----------

/** the trade Up next shows: the one picked (Skip moves it on) while it still waits, else the newest waiting */
export function upNextOf(queue) {
  return queue.find(t => t.key === state.journalUpNext) || queue[0] || null;
}

/** the current stop as a fact: where it is now (Schwab's stop moved, or yours) and an arrow when it moved your way */
export function stopNow(t) {
  if (t.legs || t.stop === null || t.status === 'history') return { text: '—', up: false };
  const moved = t.movedTo !== null && t.stopSource !== 'yours';
  const now = moved ? t.movedTo : t.stop;
  return { text: px(now, t.assetType), up: moved && (t.direction === 'short' ? now < t.stop : now > t.stop) };
}
const UP = '<span class="journal-buy" aria-label="raised">↑</span>';

/** one figure tile: label, value */
const fig = (label, value, cls = '', title = '') => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd${cls ? ` class="${cls}"` : ''}>${value}</dd></div>`;
const wideFigs = t => [t.avgEntry, t.avgExit, t.stop].some(v => v !== null && v !== undefined && px(v, t.assetType).length > 8) ? ' jtc-stats-wide' : '';

/** what the trade is: its side, a spread's structure, expired, assigned, deleted, before your history */
export function sideTags(t) {
  const out = [];
  if (t.status === 'history') out.push(tag('jtc-warn', 'Before your history', HISTORY_TITLE));
  const side = { long: tag('jtc-long', `Long${onWords(t)}`), short: tag('jtc-short', `Short${onWords(t)}`), neutral: tag('', 'Neutral') }[t.bias];
  if (side) out.push(side);
  if (t.legs) out.push(tag('', esc(t.structure || `${t.spreadKind} spread`)));
  if (t.expired) out.push(tag('', 'expired', EXPIRED_TITLE));
  if (t.via) out.push(tag('', t.via, VIA_TITLE[t.via]));
  if (t.deleted) out.push(tag('jtc-warn', 'deleted'));
  return out.join('');
}

/** the setups as chips, an amber prompt when there's none, and the weekly mark */
export function setupTags(t) {
  const setups = setupsOf(t);
  const tags = setups.length ? setups.map(setupChip).join('') : untagged(t) ? tag('jtc-tagit', 'No setup: tag it') : '';
  const weekly = reviewsRead() && savedForWeekly(t) ? tag('', 'for weekly') : '';
  return tags || weekly ? `<div class="jtc-tags">${tags}${weekly}</div>` : '';
}

/** a spread's legs, or how many trades a merge holds */
const extraSub = t => t.legs ? esc(legWords(t.legs)) : t.kind === 'merged' ? `${t.parts.length} trades merged` : '';

/** the P&L at the top right and what's under it */
function pnlBlock(t, under) {
  const none = t.status === 'history' || (t.status === 'open' && !t.exits);
  return `<dl class="jtc-pnl"><div${none ? '' : pnlTitle(t)}><dt>P&amp;L</dt><dd class="${none ? 'jtc-none' : pnlClass(t.pnl)}">${none ? '—' : signed$(t.pnl)}${under}</dd></div></dl>`;
}
const pctOf = t => {
  const basis = pnlBasis(t), pct = pnlPct(t);
  return pct === null || basis === null ? '' : `<span class="jtc-pct" title="${esc(pctTitleOf(t, basis))}">${signedPct(pct)}</span>`;
};

/** '23 shr · Oct 29 · 7m': the size, the day it closed (or opened, while open), how long */
function deckSub(t) {
  const open = t.status === 'open';
  return nowrap([`${t.entryQty} ${unitWord(t)}`, nyDay(open ? t.openedAt : t.closedAt || t.openedAt), holdWords(open ? Date.now() - Date.parse(t.openedAt) : t.holdMs)]);
}

export function upNextHtml(queue, p) {
  if (!queue.length) {
    if (!p?.done) return '';
    const when = p.day === p.now ? 'today' : `on ${dayWords(p.day)}`;
    return `<section class="jun-done" role="status"><h3>✓ Day reviewed</h3><p>${p.streak}-day streak · ${p.total} trade${p.total === 1 ? '' : 's'} reviewed ${when}</p></section>`;
  }
  const t = /** @type {any} */ (upNextOf(queue)), at = queue.indexOf(t), key = esc(t.key), label = esc(t.label);
  const stop = stopNow(t), open = t.status === 'open';
  const under = open && !t.exits ? '<span class="pos-sub">no exits yet</span>' : t.r !== null ? `<span class="jtc-pct ${pnlClass(t.r)}" title="${esc(rTitleOf(t))}">${signedR(t.r)}</span>` : pctOf(t);
  return `<div class="jun-stack">
      <span class="jun-peek jun-peek-2" aria-hidden="true"></span><span class="jun-peek jun-peek-1" aria-hidden="true"></span>
      <article class="jun" id="jUpNext" data-key="${key}" aria-label="Up next: ${label}">
        <div class="jun-top"><span class="jun-eyebrow">Up next · ${at + 1} of ${queue.length}</span>${queue.length > 1 ? `<button class="jun-skip" data-action="skipUpNext" aria-label="Skip ${label}">Skip ›</button>` : ''}</div>
        <div class="jtc-head"><div class="jtc-id">
          <div class="jtc-name"><b>${label}</b>${sideTags(t)}</div>
          <div class="jtc-sub">${deckSub(t)}</div>${extraSub(t) ? `<div class="jtc-sub">${extraSub(t)}</div>` : ''}
        </div>${pnlBlock(t, under)}</div>
        ${setupTags(t)}
        <dl class="jtc-stats${wideFigs(t)}">
          ${fig('Entry', px(t.avgEntry, t.assetType))}
          ${fig(t.exits > 1 ? 'Avg exit' : 'Exit', t.avgExit === null ? '—' : px(t.avgExit, t.assetType))}
          ${fig('Stop', `${stop.text}${stop.up ? ` ${UP}` : ''}`)}
        </dl>
        <button class="jun-go" data-action="reviewUpNext" data-arg="${key}">${PENCIL}Start review</button>
        <div class="jun-hints" aria-hidden="true"><span class="jun-hint-left">← Swipe to skip</span><span class="jun-hint-right">Swipe to review →</span></div>
      </article>
    </div>`;
}

/** Skip (or a left swipe): the next trade waiting, round to the first after the last */
export function skipUpNext() {
  const queue = reviewQueue(journalTradeList());
  const at = queue.indexOf(/** @type {any} */ (upNextOf(queue)));
  state.journalUpNext = queue.length ? queue[(at + 1) % queue.length].key : '';
  renderJournal();
}

/** Start review (or a right swipe): the deck, starting on this trade and going round the rest */
export function reviewUpNext(key) {
  const queue = reviewQueue(journalTradeList()).map(t => t.key);
  const at = Math.max(0, queue.indexOf(key));
  startReviewDeck([...queue.slice(at), ...queue.slice(0, at)]);
}

/**
 * The swipe: a sideways drag moves the card with the finger (up and down still scroll: touch-action pan-y), past 90px it
 * goes, left to skip, right to start the review; anything shorter springs back. A drag never counts as a tap.
 */
export function bindUpNext() {
  const card = document.getElementById('jUpNext');
  if (!card || !card.querySelector) return;
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const hints = { left: card.querySelector('.jun-hint-left'), right: card.querySelector('.jun-hint-right') };
  let start = null, dx = 0, dragged = false;
  const paint = () => {
    card.style.transform = dx ? `translateX(${dx}px) rotate(${dx / 25}deg)` : '';
    if (hints.left) hints.left.style.opacity = dx < -40 ? '1' : '';
    if (hints.right) hints.right.style.opacity = dx > 40 ? '1' : '';
  };
  card.addEventListener('pointerdown', e => {
    if (e.button) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    dx = 0;
    dragged = false;
  });
  card.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const x = e.clientX - start.x, y = e.clientY - start.y;
    if (!dragged) {
      if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) { start = null; return; } // a scroll
      if (Math.abs(x) < 8) return;
      dragged = true;
      card.classList.add('jun-dragging');
      card.setPointerCapture?.(e.pointerId);
    }
    dx = x;
    paint();
  });
  const end = () => {
    if (!start) return;
    start = null;
    if (!dragged) return;
    card.classList.remove('jun-dragging');
    const key = card.dataset.key || '';
    if (dx < -90) {
      dx = -420;
      paint();
      setTimeout(skipUpNext, still ? 0 : 250);
    } else if (dx > 90) {
      dx = 0;
      paint();
      reviewUpNext(key);
    } else {
      dx = 0;
      paint();
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', () => { dx = 0; if (start) { start = null; card.classList.remove('jun-dragging'); paint(); } });
  // the tap that ends a drag isn't a tap on Start review or Skip
  card.addEventListener('click', e => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
}

// ---------- the stats line ----------

export function statsLine(trades, deleted) {
  const s = tradesSummary(trades);
  const deletedNote = deleted ? `${deleted} deleted <button class="pos-link" data-action="toggleDeletedTrades">${state.journalShowDeleted ? 'Hide them' : 'Show'}</button>` : '';
  if (!s.closed && !s.open && !s.history) return `<p class="hint journal-summary">No trades match.${deletedNote ? ` ${deletedNote}` : ''}</p>`;
  const avg = s.avgR !== null ? `<span title="${s.avgPct !== null ? `${signedPct(s.avgPct)} average` : ''}">Avg <b class="${pnlClass(s.avgR)}">${signedR(s.avgR)}</b></span>`
    : s.avgPct !== null ? `<span>Avg <b class="${pnlClass(s.avgPct)}">${signedPct(s.avgPct)}</b></span>` : '';
  const line = s.closed ? `<p class="jtc-statline"><span title="${esc(`${signed$(s.pnl)} ${feeWords()}`)}">Net <b class="${pnlClass(s.pnl)}">${signedWhole$(s.pnl)}</b></span><span title="${s.wins} of ${s.closed} won">Win <b>${s.winRate}%</b></span>${avg}</p>` : '';
  const notes = [
    s.closed && journalAfterFees() ? 'after fees' : '',
    s.closed && journalAfterFees() && s.fees ? `fees ${fmt$(s.fees)}` : '',
    s.closed && journalAfterFees() && s.feesMissing ? `<span class="journal-fees-missing">fees not in yet on ${s.feesMissing}</span>` : '',
    s.history ? `<span class="journal-fees-missing" title="${esc(HISTORY_TITLE)}">${s.history} from before your history</span>` : '',
    deletedNote,
  ].filter(Boolean);
  return `${line}${notes.length ? `<p class="hint journal-summary">${notes.join(' · ')}</p>` : ''}`;
}

// ---------- the cards ----------

/** Review this trade (amber, still to do), Reviewed with the grade and Edit (green, done), or a quiet Open trade */
function closedFoot(t) {
  if (t.deleted) return restoreLink(t) ? `<div class="jtc-foot">${restoreLink(t)}</div>` : '';
  const key = esc(t.key), label = esc(t.label);
  if (t.status !== 'history' && isReviewed(t)) {
    const g = setupGradeOf(t);
    return `<div class="jtc-foot jtc-foot-done"><span class="jtc-done" role="status">✓ Reviewed</span><span class="jtc-foot-end">${g ? `<span class="jtc-grade jtc-grade-${g.toLowerCase()}">Grade ${g}</span>` : ''}<button class="jtc-edit" data-action="openTradeRow" data-arg="${key}" aria-label="Edit the review of ${label}">Edit</button></span></div>`;
  }
  if (reviewsRead() && t.status !== 'history' && toReview(t)) return `<button class="jtc-go" data-action="openTradeRow" data-arg="${key}" aria-label="Review ${label}">${PENCIL}Review this trade</button>`;
  return `<div class="jtc-foot"><span></span><button class="jtc-link" data-action="openTradeRow" data-arg="${key}" aria-label="Open ${label}">Open trade ›</button></div>`;
}

/** the stop as words under a closed trade's figures: 'Stop $389.87 → $409.99' when it moved, 'yours' when you set it */
function stopLine(t) {
  if (t.legs || t.status === 'history' || t.stop === null) return '';
  const moved = t.movedTo !== null && t.stopSource !== 'yours' ? ` → ${px(t.movedTo, t.assetType)}` : '';
  return `<span class="jtc-stop">Stop <b>${px(t.stop, t.assetType)}${moved}</b>${t.stopSource === 'yours' ? ' <span class="pos-sub">yours</span>' : ''}</span>`;
}

export function closedCard(t) {
  const history = t.status === 'history';
  const reviewed = !t.deleted && !history && isReviewed(t);
  const todo = !t.deleted && !history && reviewsRead() && toReview(t);
  const pop = reviewed && state.journalJustReviewed === t.key ? ' jtc-pop' : '';
  const sub = history ? nowrap([`${t.entryQty} ${unitWord(t)}`, `closed ${nyDay(t.closedAt || t.openedAt)}`, 'bought earlier'])
    : nowrap([`${t.entryQty} ${unitWord(t)}`, nyDay(t.openedAt) === nyDay(t.closedAt) ? nyDay(t.openedAt) : `${nyDay(t.openedAt)} → ${nyDay(t.closedAt)}`, holdWords(t.holdMs)]);
  return `<article class="jtc${reviewed ? ' jtc-reviewed' : todo ? ' jtc-todo' : ''}${pop}${t.deleted ? ' journal-deleted' : ''}"${rowOpen(t)}${history ? ` title="${esc(HISTORY_TITLE)}"` : ''}>
    <div class="jtc-head">${state.journalSelecting || state.journalPicked.length ? pickBox(t) : ''}<div class="jtc-id">
      <div class="jtc-name">${nameOf(t)}${sideTags(t)}</div>
      <div class="jtc-sub">${sub}</div>${extraSub(t) ? `<div class="jtc-sub">${extraSub(t)}</div>` : ''}
    </div>${pnlBlock(t, history ? '' : pctOf(t) + feeSubs(t))}</div>
    ${setupTags(t)}
    <dl class="jtc-stats${wideFigs(t)}">
      ${fig('Entry', history ? '—' : px(t.avgEntry, t.assetType))}
      ${fig(t.exits > 1 ? 'Avg exit' : 'Exit', t.avgExit === null ? '—' : px(t.avgExit, t.assetType))}
      ${fig('R', t.r === null ? '—' : signedR(t.r), t.r === null ? '' : pnlClass(t.r), rTitleOf(t))}
    </dl>
    ${stopLine(t)}
    ${closedFoot(t)}
  </article>`;
}

export function openCard(t) {
  const sold = t.openQty !== t.entryQty;
  const stop = stopNow(t);
  const under = t.exits ? `<span class="jtc-pct-note">${pctOf(t) ? `${pctOf(t)} · ` : ''}so far</span>${feeSubs(t)}` : '<span class="jtc-pct-note">no exits yet</span>';
  const key = esc(t.key), label = esc(t.label), waiting = !t.deleted && reviewsRead() && toReview(t);
  const stopTitle = stop.up ? `Initial stop ${px(t.stop, t.assetType)}, moved to ${px(t.movedTo, t.assetType)}` : '';
  return `<article class="jtc jtc-is-open${t.deleted ? ' journal-deleted' : ''}"${rowOpen(t)}>
    <div class="jtc-head">${state.journalSelecting || state.journalPicked.length ? pickBox(t) : ''}<div class="jtc-id">
      <div class="jtc-name">${nameOf(t)}${sideTags(t)}</div>
      <div class="jtc-sub">${nowrap([sold ? `${t.openQty}/${t.entryQty} open` : `${t.entryQty} ${unitWord(t)}`, holdWords(Date.now() - Date.parse(t.openedAt))])}</div>${extraSub(t) ? `<div class="jtc-sub">${extraSub(t)}</div>` : ''}
    </div>${pnlBlock(t, under)}</div>
    ${setupTags(t)}
    <dl class="jtc-stats${wideFigs(t)}">
      ${fig('Entry', px(t.avgEntry, t.assetType))}
      ${fig('Avg exit', t.avgExit === null ? '—' : px(t.avgExit, t.assetType))}
      ${fig('Stop', `${stop.text}${stop.up ? ` ${UP}` : ''}`, '', stopTitle)}
    </dl>
    ${t.deleted ? (restoreLink(t) ? `<div class="jtc-foot">${restoreLink(t)}</div>` : '') : `<div class="jtc-foot"><span class="jtc-live">Live</span><button class="jtc-link${waiting ? ' jtc-link-todo' : ''}" data-action="openTradeRow" data-arg="${key}" aria-label="${waiting ? 'Review' : 'Open'} ${label}">${waiting ? 'Opening pass ›' : 'Open trade ›'}</button></div>`}
  </article>`;
}

/** the New York day a closed trade closed */
export const closeDay = t => nyParts(t.closedAt || t.openedAt).day;

/** Closed, a day at a time, newest first: the day, how many wait or that it's all reviewed, and its P&L */
export function closedDays(list) {
  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  for (const t of list) byDay.set(closeDay(t), [...(byDay.get(closeDay(t)) || []), t]);
  const now = today();
  return [...byDay.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).map(([day, trades]) => {
    const live = trades.filter(t => !t.deleted && t.status !== 'history');
    const waiting = reviewsRead() ? live.filter(toReview).length : 0;
    const status = waiting ? `<span class="jtc-day-todo">${waiting} to review</span>` : reviewsRead() && live.length && live.every(isReviewed) ? '<span class="jtc-day-done">All reviewed</span>' : '';
    const total = trades.some(counts) ? `<b class="${pnlClass(sum(trades))}">${signed$(sum(trades))}</b>` : '';
    return `<div class="jtc-day"><span>${day === now ? `Today · ${dayWords(day)}` : dayWords(day, true)}${status ? ` · ${status}` : ''}</span>${total}</div>${trades.map(closedCard).join('')}`;
  }).join('');
}

/**
 * The phone Trades tab: the progress card and Up next (while the list shows every trade or the ones to review, and not
 * while picking), the stats line, then Open and Closed; every trade stays in the list, the one Up next shows too
 */
export function phoneTradesHtml(trades, counted, deleted) {
  const all = journalTradeList();
  const deck = ['all', 'todo'].includes(state.journalReviewFilter) && !state.journalSelecting && !state.journalPicked.length;
  const queue = deck ? reviewQueue(all) : [];
  const p = deck ? progress(all) : null;
  const open = trades.filter(t => t.status === 'open'), closed = trades.filter(t => t.status !== 'open');
  const head = (title, n, word, list) => `<div class="jtc-group-head"><h3>${title} <span>${n}</span></h3>${list.some(counts) ? `<span class="jtc-total">${word} <b class="${pnlClass(sum(list))}">${signed$(sum(list))}</b></span>` : ''}</div>`;
  const html = `${progressHtml(p)}${upNextHtml(queue, p)}${statsLine(counted, deleted)}
    <div class="jtc-list">
      ${open.length ? `<section class="jtc-group">${head('Open', open.length, 'Taken so far', open)}${open.map(openCard).join('')}</section>` : ''}
      ${closed.length ? `<section class="jtc-group">${head('Closed', closed.length, 'Realized', closed)}${closedDays(closed)}</section>` : ''}
    </div>`;
  state.journalJustReviewed = ''; // the pop plays once
  return html;
}

// Phone gestures and chrome that make the app feel like an iOS one: the small title bar once the large title scrolls away, pull to refresh, and swiping back from a Journal trade page's left edge.
import { state } from '../state.js';
import { mq, PHONE_MQ } from '../lib/media.js';
import { effects } from './effects.js';
import { closeJournalTrade } from './journal-trade.js';
import { loadJournal } from './journal.js';
import { marketRefreshToday } from './market.js';
import { refreshPositions } from './positions.js';
import { refreshQuote } from './ticker.js';
import { viewLocked } from './sign-in-gate.js';

const EASE = 'cubic-bezier(.32,.72,0,1)'; // iOS's own curve, as the sheets use
const still = () => mq('(prefers-reduced-motion: reduce)');

// ---------- the small title bar ----------

/** phones: once the large title has scrolled under the top, a small centered one takes its place (the sticky quote bar wins on Size) */
export function updateTitleBar() {
  const bar = document.getElementById('titleBar');
  const title = document.getElementById('viewTitle');
  const sticky = document.getElementById('stickyBar').style.display === 'flex';
  const on = mq(PHONE_MQ) && !sticky && title.getBoundingClientRect().bottom < (bar.offsetHeight || 44);
  bar.classList.toggle('on', on);
  bar.setAttribute('aria-hidden', String(!on));
}

// ---------- pull to refresh ----------

/** how far the finger travels before a release refreshes */
export const PULL_TRIGGER = 110;
/** the indicator rides at half the finger's travel, up to this far */
const PULL_MAX = 80;

/** what a pull refreshes in the view you're on: the same as that view's own refresh button; null where there's nothing to refresh */
export function pullRefreshAction() {
  if (viewLocked()) return null; // the sign-in gate: nothing behind it to refresh
  if (state.positionsView) return () => refreshPositions(true);
  if (state.marketView) return () => marketRefreshToday();
  if (state.journalView) return state.journalTrade || !state.session ? null : () => loadJournal();
  if (state.utilsView) return null;
  return state.quoteData ? () => refreshQuote() : null;
}

/** paint the indicator for a pull of dy px (0 hides it) */
function paintPull(el, dy) {
  const pull = Math.min(PULL_MAX, Math.max(0, dy) / 2);
  el.style.transform = `translate(-50%, ${pull - 40}px) rotate(${Math.min(1, dy / PULL_TRIGGER) * 180}deg)`;
  el.style.opacity = String(Math.min(1, dy / PULL_TRIGGER));
  el.classList.toggle('armed', dy >= PULL_TRIGGER);
}

/**
 * Phones, at the very top of the page: pull down and let go past PULL_TRIGGER to refresh the view.
 * The page keeps its own bounce (no preventDefault); the indicator only follows. A gesture a chart claims, a sheet,
 * the simulator or an upward first move leaves it alone.
 */
export function attachPullRefresh(target = window) {
  const el = () => document.getElementById('pullRefresh');
  let mode = null, y0 = 0, x0 = 0, dy = 0, run = null; // mode: null, 'maybe', 'pull', 'busy'
  target.addEventListener('touchstart', e => {
    if (mode === 'busy') return;
    mode = null;
    if (e.touches.length !== 1 || !mq(PHONE_MQ) || window.scrollY > 0 || state.openSheetName || state.simState) return;
    run = pullRefreshAction();
    if (!run) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dy = 0; mode = 'maybe';
  }, { passive: true });
  target.addEventListener('touchmove', e => {
    if (mode !== 'maybe' && mode !== 'pull') return;
    if (e.defaultPrevented || e.touches.length !== 1) { mode = null; paintPull(el(), 0); return; } // a chart or a pinch has it
    const dx = e.touches[0].clientX - x0;
    dy = e.touches[0].clientY - y0;
    if (mode === 'maybe') {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (dy <= 0 || Math.abs(dx) > dy) { mode = null; return; }
      mode = 'pull';
      el().style.transition = 'none';
      el().classList.add('show');
    }
    paintPull(el(), dy);
  }, { passive: true });
  const end = () => {
    if (mode !== 'pull') { if (mode !== 'busy') mode = null; return; }
    const ind = el();
    ind.style.transition = '';
    if (dy < PULL_TRIGGER) { mode = null; paintPull(ind, 0); ind.classList.remove('show'); return; }
    mode = 'busy';
    effects.haptic();
    ind.classList.remove('armed');
    ind.classList.add('busy');
    ind.style.transform = `translate(-50%, ${PULL_MAX / 2 - 40}px)`;
    ind.style.opacity = '1';
    // at least a beat of spinner, so a fast answer still reads as a refresh; at most 15s, so a stuck one can't hold it
    Promise.all([
      Promise.race([Promise.resolve().then(run).catch(() => {}), effects.wait(15000)]),
      effects.wait(500),
    ]).then(() => {
      mode = null;
      ind.classList.remove('busy', 'show');
      paintPull(ind, 0);
    });
  };
  target.addEventListener('touchend', end);
  target.addEventListener('touchcancel', end);
}

// ---------- swipe back ----------

/** a touch this close to the left edge can start a swipe back */
export const EDGE = 24;

/**
 * Phones, on a Journal trade page: drag from the left edge to go back to the list, as in an iOS app.
 * The page follows the finger; let go past a third of the width (or with a quick flick) and it slides off and closes, else it springs back.
 * Listens in the capture phase so a chart under the edge never pans at the same time.
 */
export function attachSwipeBack(page) {
  let mode = null, x0 = 0, y0 = 0, t0 = 0, dx = 0;
  const reset = () => Object.assign(page.style, { transform: '', transition: '', boxShadow: '' });
  page.addEventListener('touchstart', e => {
    mode = null;
    if (e.touches.length !== 1 || !mq(PHONE_MQ) || !state.journalView || !state.journalTrade || state.openSheetName) return;
    if (e.touches[0].clientX > EDGE) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); dx = 0; mode = 'maybe';
  }, { capture: true, passive: true });
  page.addEventListener('touchmove', e => {
    if (mode !== 'maybe' && mode !== 'drag') return;
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (mode === 'maybe') {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (dx <= 0 || Math.abs(dy) > dx) { mode = null; return; } // up, down or left: the page scrolls as usual
      mode = 'drag';
      Object.assign(page.style, { transition: 'none', boxShadow: '-12px 0 24px -12px rgba(0,0,0,0.6)' });
    }
    e.preventDefault();
    e.stopPropagation(); // the page owns this drag: the chart underneath must not pan along
    page.style.transform = `translateX(${Math.max(0, dx)}px)`;
  }, { capture: true, passive: false });
  const end = () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    const w = window.innerWidth || 390;
    const flick = dx > 40 && dx / Math.max(1, Date.now() - t0) > 0.5;
    if (dx < w / 3 && !flick) {
      Object.assign(page.style, { transition: `transform 300ms ${EASE}`, transform: '' });
      effects.wait(300).then(() => { if (!page.style.transform) reset(); });
      return;
    }
    if (still()) { reset(); closeJournalTrade(); return; }
    Object.assign(page.style, { transition: `transform 240ms ${EASE}`, transform: 'translateX(100%)' });
    effects.wait(240).then(() => { reset(); if (state.journalTrade) closeJournalTrade(); });
  };
  page.addEventListener('touchend', end, true);
  page.addEventListener('touchcancel', end, true);
}

/** wire the phone gestures once at boot */
export function initNativeFeel() {
  attachPullRefresh(window);
  attachSwipeBack(document.getElementById('journalTradeSection'));
  updateTitleBar();
}

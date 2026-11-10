// Sharing a Journal trade (the trade page's Share): a card image (drawShareCard) with the entry, the stop, the exit, the
// result, the setup and the entry tactic, or the same in a line of text. No dollars and no size, like the other share cards.
// An open trade has no result yet: opening Share reads its price (a stock's or one contract's), and the card says where it
// stands now, in R against the stop, and how long it's been held so far.
import { holdWords, pnlPct } from '../core/journal.js';
import { stopWords } from '../core/order-plans.js';
import { fmtPositionPrice } from '../core/positions.js';
import { exitParts } from '../core/trade-page.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { marketDataHere } from '../services/bars.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { labelNames, setupsOf } from './journal-review.js';
import { journalPageTrade, renderJournalTrade } from './journal-trade.js';
import { SC } from './share-image.js';
import { readLegQuotes, tradierSymbol } from './sheet-quote.js';

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const sideOf = t => t.bias === 'neutral' ? 'neutral' : (t.bias || t.direction) === 'long' ? 'long' : 'short';
const tone = v => v > 0 ? SC.green : v < 0 ? SC.red : SC.text;
const clock = ms => `${inZone(ms, { hour: 'numeric', minute: '2-digit' })} ${zoneAbbr()}`;

/** how the stop was set, from the order plan the Trade at Schwab sheet kept ('LOD − 0.5× ATR(5m)'), else whose it is */
function stopHow(t) {
  const plan = state.orderPlanMatch?.get(t.key)?.[0];
  if (plan && t.stopSource !== 'yours') return stopWords(plan);
  return t.stopSource === 'yours' ? 'your stop' : t.stopSource === 'schwab' ? 'stop order' : '';
}

/** the symbol an open trade's price is read for: a stock's or one option contract's ('' for a spread or a future) */
export const sharePriceSymbol = t => t.status !== 'open' || t.legs || t.assetType === 'SPREAD' || t.assetType === 'FUTURE' ? '' : tradierSymbol(t.symbol);

/**
 * Everything the card and the text say about a trade: the stop, how far it was from the entry, how it was set and where it
 * moved; the exit; the result in R and %; the setups and entry tactics. An open trade instead has its price now (now: the
 * read from opening Share, { price, at }) in R and %, and what the part already closed made in R.
 */
export function tradeShareFacts(t, now = null) {
  const side = sideOf(t), open = t.status === 'open', x = exitParts(t);
  const hasStop = t.stop !== null && t.stop !== undefined && t.stop > 0;
  const entry = t.avgEntry, dir = t.direction === 'short' ? -1 : 1;
  // one unit's risk: to the (first) stop, or an option bought without one, its premium
  const per = hasStop ? dir * (entry - t.stop) : t.rBasis === 'premium' ? entry : null;
  const rOf = price => per && per > 0 ? dir * (price - entry) / per : null;
  const price = open && now?.price > 0 ? now.price : null;
  return {
    side, open, label: t.label, assetType: t.assetType,
    entry, opened: t.openedAt || '',
    hold: open ? (t.openedAt ? holdWords(Date.now() - Date.parse(t.openedAt)) : '') : holdWords(t.holdMs),
    stop: hasStop ? t.stop : null,
    stopAway: hasStop && entry > 0 ? Math.abs(entry - t.stop) / entry * 100 : null,
    stopHow: hasStop ? stopHow(t) : '', stopMoved: hasStop ? t.movedTo ?? null : null,
    premiumRisk: !hasStop && t.rBasis === 'premium',
    exit: t.avgExit ?? null, exitAvg: !!x?.avg, partClosed: open && !!x,
    exitR: open && x && t.avgExit !== null ? rOf(t.avgExit) : null,
    r: t.r ?? null, pct: open ? null : pnlPct(t),
    now: price, nowAt: price !== null ? now.at : null,
    nowR: price !== null ? rOf(price) : null, nowPct: price !== null && entry > 0 ? dir * (price - entry) / entry * 100 : null,
    setups: setupsOf(t).map(s => s.name), tactics: labelNames(t, 'tactic'),
  };
}

/** the stop's words after its price: '5.0% away', how it was set */
const stopNotes = f => [f.stopAway !== null ? `${f.stopAway.toFixed(1)}% away` : '', f.stopHow].filter(Boolean);

/** an open trade's last tile: where it stands now (in R when there's a risk to measure against), or that it's open */
function nowTile(f, p) {
  if (f.now === null) return { label: 'Status', value: 'Open', sub: 'no live price' };
  return f.nowR !== null
    ? { label: 'Now', value: signedR(f.nowR), color: tone(f.nowR), sub: `at ${p(f.now)} · ${signedPct(f.nowPct)} · ${clock(f.nowAt)}` }
    : { label: 'Now', value: signedPct(f.nowPct), color: tone(f.nowPct), sub: `at ${p(f.now)} · ${clock(f.nowAt)}` };
}

/** the card: the trade and its side up top, entry, stop, exit and result (an open trade: now), then the setup and the entry tactic */
export function tradeShareSpec(t, now = null) {
  const f = tradeShareFacts(t, now), p = v => px(v, f.assetType);
  const when = f.opened ? `${inZone(f.opened, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '')} ${zoneAbbr()}` : '';
  const stop = f.stop !== null
    ? { label: 'Stop', value: p(f.stop), color: SC.red, sub: [...stopNotes(f), f.stopMoved !== null ? `moved to ${p(f.stopMoved)}` : ''].filter(Boolean).join(' · ') }
    : { label: 'Stop', value: '—', color: SC.red, sub: f.premiumRisk ? 'risk = the premium' : 'no stop' };
  const exit = { label: f.exitAvg ? 'Avg exit' : 'Exit', value: f.exit !== null ? p(f.exit) : '—', color: SC.amber,
    sub: f.partClosed ? [f.exitR !== null ? signedR(f.exitR) : '', 'part closed'].filter(Boolean).join(' · ') : '' };
  const result = f.r !== null
    ? { label: 'Result', value: signedR(f.r), color: tone(f.r), sub: f.pct !== null ? signedPct(f.pct) : '' }
    : { label: 'Result', value: f.pct !== null ? signedPct(f.pct) : '—', color: tone(f.pct || 0), sub: 'no stop, so no R' };
  return {
    title: [{ t: `${f.label}  ` }, { t: f.side.toUpperCase(), c: f.side === 'long' ? SC.green : f.side === 'short' ? SC.red : SC.text2 }],
    sub: [f.open ? 'Open trade' : 'Closed trade', when && `opened ${when}`, f.hold && `held ${f.hold}${f.open ? ' so far' : ''}`].filter(Boolean).join(' · '),
    // an open trade: its exit only once part of it is closed, and where it stands now in place of the result
    stats: f.open
      ? [{ label: 'Entry', value: p(f.entry), color: SC.blue, sub: '' }, stop, ...(f.partClosed ? [exit] : []), nowTile(f, p)]
      : [{ label: 'Entry', value: p(f.entry), color: SC.blue, sub: '' }, stop, exit, result],
    details: [
      { label: 'Setup', value: f.setups.join(', ') },
      { label: 'Entry tactic', value: f.tactics.join(', ') },
    ],
  };
}

/** the same in a line, for a chat: 'Long $AAPL @ 100.02 · stop 95.00 (5.0% away, stop order) · exit 94.98 · −1.00R (−5.04%) · …' */
export function tradeShareText(t, now = null) {
  const f = tradeShareFacts(t, now), p = v => px(v, f.assetType).replace('$', '');
  const name = f.assetType === 'OPTION' || f.assetType === 'SPREAD' || f.assetType === 'FUTURE' ? f.label : `$${f.label}`;
  const notes = stopNotes(f);
  const stop = f.stop !== null ? `stop ${p(f.stop)}${notes.length ? ` (${notes.join(', ')})` : ''}${f.stopMoved !== null ? `, moved to ${p(f.stopMoved)}` : ''}`
    : f.premiumRisk ? 'risk = the premium' : 'no stop';
  const exit = f.exit === null ? '' : `${f.exitAvg ? 'avg exit' : 'exit'} ${p(f.exit)}${f.partClosed ? ` (part closed${f.exitR !== null ? `, ${signedR(f.exitR)}` : ''})` : ''}`;
  const result = f.open
    ? `still open${f.now !== null ? `, now ${p(f.now)} (${[f.nowR !== null ? signedR(f.nowR) : '', signedPct(f.nowPct)].filter(Boolean).join(', ')})` : ''}`
    : f.r !== null ? `${signedR(f.r)}${f.pct !== null ? ` (${signedPct(f.pct)})` : ''}` : f.pct !== null ? signedPct(f.pct) : '';
  const side = f.side === 'neutral' ? 'Neutral' : f.side === 'long' ? 'Long' : 'Short';
  return [`${side} ${name} @ ${p(f.entry)}`, stop, exit, result,
    f.setups.length ? `setup ${f.setups.join(', ')}` : '', f.tactics.length ? `entry tactic ${f.tactics.join(', ')}` : ''].filter(Boolean).join(' · ');
}

/**
 * An open trade's price, read once as Share opens (p.shareQuote: { loading } → { price, at } or { error }), so the card can be
 * drawn inside the tap (Safari's clipboard wants that). A contract's mid when it has a bid and ask, else its last.
 */
async function readSharePrice(p, t) {
  const sym = sharePriceSymbol(t);
  if (!sym || !marketDataHere()) { p.shareQuote = null; return; }
  p.shareQuote = { loading: true };
  try {
    const q = (await readLegQuotes([sym]))[sym];
    const price = !q ? 0 : t.assetType === 'OPTION' && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q.last || (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : 0);
    p.shareQuote = price > 0 ? { price, at: Date.now() } : { error: 'no price' };
  } catch(e) {
    p.shareQuote = { error: String(e?.message || e) };
  }
  if (state.journalTrade === p && p.shareOpen) renderJournalTrade();
}

/** the head's Share button opens or closes its choices; opening reads an open trade's price */
export function toggleJournalShare() {
  const p = state.journalTrade;
  if (!p) return;
  p.shareOpen = !p.shareOpen;
  const t = journalPageTrade();
  const reading = p.shareOpen && t ? readSharePrice(p, t) : null;
  renderJournalTrade();
  return reading;
}

function shareable() {
  const t = journalPageTrade();
  if (!t) return null;
  if (t.status === 'history' || !(t.avgEntry > 0)) { showError('Bought before your history: there\'s no entry to share.'); return null; }
  return t;
}
const nowOf = () => state.journalTrade?.shareQuote?.price ? state.journalTrade.shareQuote : null;
const closeChoices = () => { if (state.journalTrade?.shareOpen) { state.journalTrade.shareOpen = false; renderJournalTrade(); } };

/** the card image, copied (or downloaded where the clipboard can't take it) */
export function shareJournalTrade() {
  const t = shareable();
  if (!t) return;
  effects.shareCanvasToClipboard(effects.drawShareCard(tradeShareSpec(t, nowOf())), `${t.label.replace(/[^\w.-]+/g, '-')}-trade`);
  closeChoices();
}

/** the line of text, copied */
export function copyJournalTrade() {
  const t = shareable();
  if (!t) return;
  effects.copyPlainText(tradeShareText(t, nowOf()));
  closeChoices();
}

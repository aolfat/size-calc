// Sharing a Journal trade (the trade page's Share): a card image (drawShareCard) with the entry, the stop, the exit, the
// result, the setup and the entry tactic, or the same in a line of text. No dollars and no size, like the other share cards.
import { holdWords, pnlPct } from '../core/journal.js';
import { stopWords } from '../core/order-plans.js';
import { fmtPositionPrice } from '../core/positions.js';
import { exitParts } from '../core/trade-page.js';
import { inZone, zoneAbbr } from '../lib/zone.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError } from './feedback.js';
import { labelNames, setupsOf } from './journal-review.js';
import { journalPageTrade, renderJournalTrade } from './journal-trade.js';
import { SC } from './share-image.js';

const px = (p, assetType) => fmtPositionPrice(p, assetType === 'OPTION' || assetType === 'SPREAD' ? 'OPTION' : null);
const signedR = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const signedPct = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const sideOf = t => t.bias === 'neutral' ? 'neutral' : (t.bias || t.direction) === 'long' ? 'long' : 'short';

/** how the stop was set, from the order plan the Trade at Schwab sheet kept ('LOD − 0.5× ATR(5m)'), else whose it is */
function stopHow(t) {
  const plan = state.orderPlanMatch?.get(t.key)?.[0];
  if (plan && t.stopSource !== 'yours') return stopWords(plan);
  return t.stopSource === 'yours' ? 'your stop' : t.stopSource === 'schwab' ? 'stop order' : '';
}

/**
 * Everything the card and the text say about a trade: the stop, how far it was from the entry, how it was set and where it
 * moved; the exit; the result in R and %; the setups and entry tactics.
 */
export function tradeShareFacts(t) {
  const side = sideOf(t), open = t.status === 'open', x = exitParts(t);
  const hasStop = t.stop !== null && t.stop !== undefined && t.stop > 0;
  return {
    side, open, label: t.label, assetType: t.assetType,
    entry: t.avgEntry, opened: t.openedAt || '', hold: open ? '' : holdWords(t.holdMs),
    stop: hasStop ? t.stop : null,
    stopAway: hasStop && t.avgEntry > 0 ? Math.abs(t.avgEntry - t.stop) / t.avgEntry * 100 : null,
    stopHow: hasStop ? stopHow(t) : '', stopMoved: hasStop ? t.movedTo ?? null : null,
    premiumRisk: !hasStop && t.rBasis === 'premium',
    exit: t.avgExit ?? null, exitAvg: !!x?.avg, partClosed: open && !!x,
    r: t.r ?? null, pct: open && !x ? null : pnlPct(t),
    setups: setupsOf(t).map(s => s.name), tactics: labelNames(t, 'tactic'),
  };
}

/** the stop's words after its price: '5.0% away', how it was set */
const stopNotes = f => [f.stopAway !== null ? `${f.stopAway.toFixed(1)}% away` : '', f.stopHow].filter(Boolean);

/** the card: the trade and its side up top, entry, stop, exit and result, then the setup and the entry tactic */
export function tradeShareSpec(t) {
  const f = tradeShareFacts(t), p = v => px(v, f.assetType);
  const when = f.opened ? `${inZone(f.opened, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '')} ${zoneAbbr()}` : '';
  const tone = v => v > 0 ? SC.green : v < 0 ? SC.red : SC.text;
  const result = f.r !== null
    ? { label: 'Result', value: signedR(f.r), color: tone(f.r), sub: f.pct !== null ? signedPct(f.pct) : '' }
    : { label: 'Result', value: f.pct !== null ? signedPct(f.pct) : 'Open', color: tone(f.pct || 0), sub: f.open ? 'still open' : 'no stop, so no R' };
  return {
    title: [{ t: `${f.label}  ` }, { t: f.side.toUpperCase(), c: f.side === 'long' ? SC.green : f.side === 'short' ? SC.red : SC.text2 }],
    sub: [f.open ? 'Open trade' : 'Closed trade', when && `opened ${when}`, f.hold && `held ${f.hold}`].filter(Boolean).join(' · '),
    stats: [
      { label: 'Entry', value: p(f.entry), color: SC.blue, sub: '' },
      f.stop !== null
        ? { label: 'Stop', value: p(f.stop), color: SC.red, sub: [...stopNotes(f), f.stopMoved !== null ? `moved to ${p(f.stopMoved)}` : ''].filter(Boolean).join(' · ') }
        : { label: 'Stop', value: '—', color: SC.red, sub: f.premiumRisk ? 'risk = the premium' : 'no stop' },
      { label: f.exitAvg ? 'Avg exit' : 'Exit', value: f.exit !== null ? p(f.exit) : '—', color: SC.amber, sub: f.partClosed ? 'part closed, rest open' : f.exit === null ? 'still open' : '' },
      result,
    ],
    details: [
      { label: 'Setup', value: f.setups.join(', ') },
      { label: 'Entry tactic', value: f.tactics.join(', ') },
    ],
  };
}

/** the same in a line, for a chat: 'Long $AAPL @ 100.02 · stop 95.00 (5.0% away, stop order) · exit 94.98 · −1.01R (−5.04%) · …' */
export function tradeShareText(t) {
  const f = tradeShareFacts(t), p = v => px(v, f.assetType).replace('$', '');
  const name = f.assetType === 'OPTION' || f.assetType === 'SPREAD' || f.assetType === 'FUTURE' ? f.label : `$${f.label}`;
  const notes = stopNotes(f);
  const stop = f.stop !== null ? `stop ${p(f.stop)}${notes.length ? ` (${notes.join(', ')})` : ''}${f.stopMoved !== null ? `, moved to ${p(f.stopMoved)}` : ''}`
    : f.premiumRisk ? 'risk = the premium' : 'no stop';
  const exit = f.exit !== null ? `${f.exitAvg ? 'avg exit' : 'exit'} ${p(f.exit)}${f.partClosed ? ' (part closed)' : ''}` : 'still open';
  const result = f.r !== null ? `${signedR(f.r)}${f.pct !== null ? ` (${signedPct(f.pct)})` : ''}` : f.pct !== null ? signedPct(f.pct) : '';
  const side = f.side === 'neutral' ? 'Neutral' : f.side === 'long' ? 'Long' : 'Short';
  return [`${side} ${name} @ ${p(f.entry)}`, stop, exit, result,
    f.setups.length ? `setup ${f.setups.join(', ')}` : '', f.tactics.length ? `entry tactic ${f.tactics.join(', ')}` : ''].filter(Boolean).join(' · ');
}

/** the head's Share button opens or closes its choices */
export function toggleJournalShare() {
  const p = state.journalTrade;
  if (!p) return;
  p.shareOpen = !p.shareOpen;
  renderJournalTrade();
}

function shareable() {
  const t = journalPageTrade();
  if (!t) return null;
  if (t.status === 'history' || !(t.avgEntry > 0)) { showError('Bought before your history: there\'s no entry to share.'); return null; }
  return t;
}
const closeChoices = () => { if (state.journalTrade?.shareOpen) { state.journalTrade.shareOpen = false; renderJournalTrade(); } };

/** the card image, copied (or downloaded where the clipboard can't take it) */
export function shareJournalTrade() {
  const t = shareable();
  if (!t) return;
  effects.shareCanvasToClipboard(effects.drawShareCard(tradeShareSpec(t)), `${t.label.replace(/[^\w.-]+/g, '-')}-trade`);
  closeChoices();
}

/** the line of text, copied */
export function copyJournalTrade() {
  const t = shareable();
  if (!t) return;
  effects.copyPlainText(tradeShareText(t));
  closeChoices();
}

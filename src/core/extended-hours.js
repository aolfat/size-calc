// @ts-check
// pre/after-hours detection. Tradier's last trade print often freezes at the 15:59
// closing print, but the extended-session NBBO (bid/ask + their timestamps) keeps
// ticking — so consider both and use the fresher signal. Null during RTH / stale data.

/**
 * The Tradier quote fields extended-hours detection reads (epoch-ms dates).
 * @typedef {{ last?: number, bid?: number, ask?: number, trade_date?: number, bid_date?: number, ask_date?: number, close?: number, prevclose?: number }} Quote
 */

/** @param {Quote} q @returns {{ label: string, price: number, chg: number, chgPct: number } | null} */
export function extSession(q) {
  /** New York day plus PRE (4:00–9:30) / AH (16:00 on) window, or null outside both. @param {number} ms */
  const sessionOf = ms => {
    const [day, h, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)).split(/,\s*|:/);
    const mins = +h * 60 + +m;
    const win = mins >= 16 * 60 ? 'AH' : (mins >= 4 * 60 && mins < 9 * 60 + 30) ? 'PRE' : null;
    return win && { day, win };
  };
  // only while NOW is in an extended window, and only prints from that same window today:
  // at 11:00 a 9:20 pre-market quote is stale, the regular-session last wins
  const now = sessionOf(Date.now());
  if (!now) return null;
  /** @param {number | undefined} ms */
  const live = ms => { const s = ms ? sessionOf(ms) : null; return !!s && s.day === now.day && s.win === now.win; };
  /** @type {{ when: number, price: number }[]} */
  const cands = [];
  const { last = 0, bid = 0, ask = 0 } = q;
  if (last > 0 && q.trade_date && live(q.trade_date)) cands.push({ when: q.trade_date, price: last });
  if (bid > 0 && ask > 0 && ask >= bid) {
    const when = Math.max(q.bid_date || 0, q.ask_date || 0);
    const mid = (bid + ask) / 2;
    if (live(when) && (ask - bid) / mid < 0.05) cands.push({ when, price: mid }); // skip junk overnight spreads
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.when - a.when);
  const c = cands[0];
  const ref = now.win === 'AH' ? (q.close || q.prevclose || 0) : (q.prevclose || 0);
  if (!(ref > 0)) return null;
  return { label: now.win, price: c.price, chg: c.price - ref, chgPct: (c.price - ref) / ref * 100 };
}

// what sizing anchors on: the extended-session price when live, else the last print

/** @param {Quote | null | undefined} q @returns {number} */
export function effectivePrice(q) {
  if (!q) return 0;
  const ext = extSession(q);
  return ext ? ext.price : (q.last || q.ask || 0);
}

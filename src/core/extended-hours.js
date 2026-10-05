// pre/after-hours detection. Tradier's last trade print often freezes at the 15:59
// closing print, but the extended-session NBBO (bid/ask + their timestamps) keeps
// ticking — so consider both and use the fresher signal. Null during RTH / stale data.

export function extSession(q) {
  const day = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
  const minsOf = ms => {
    const [h, m] = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' })
      .format(new Date(ms)).split(':').map(Number);
    return h * 60 + m;
  };
  const today = day(Date.now());
  const winOf = ms => {
    if (!ms || day(ms) !== today) return null;
    const m = minsOf(ms);
    return m >= 16 * 60 ? 'AH' : (m >= 4 * 60 && m < 9 * 60 + 30) ? 'PRE' : null;
  };
  const cands = [];
  if (q.last > 0) {
    const w = winOf(q.trade_date);
    if (w) cands.push({ when: q.trade_date, price: q.last, win: w });
  }
  if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) {
    const when = Math.max(q.bid_date || 0, q.ask_date || 0);
    const w = winOf(when);
    const mid = (q.bid + q.ask) / 2;
    if (w && (q.ask - q.bid) / mid < 0.05) cands.push({ when, price: mid, win: w }); // skip junk overnight spreads
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.when - a.when);
  const c = cands[0];
  const ref = c.win === 'AH' ? (q.close || q.prevclose || 0) : (q.prevclose || 0);
  if (!(ref > 0)) return null;
  return { label: c.win, price: c.price, chg: c.price - ref, chgPct: (c.price - ref) / ref * 100 };
}

// what sizing anchors on: the extended-session price when live, else the last print

export function effectivePrice(q) {
  if (!q) return 0;
  const ext = extSession(q);
  return ext ? ext.price : (q.last || q.ask || 0);
}

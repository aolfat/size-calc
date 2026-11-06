// @ts-check
// Schwab's market data in Tradier's form: a Tradier URL turned into the Schwab /marketdata/v1 read that answers it, and Schwab's answer turned back into Tradier's JSON, so a Schwab login alone loads quotes, chains, charts and history.
import { wallClock, nyWallMs } from './format.js';
import { futuresDays } from './futures.js';
import { regularBar } from './extended-hours.js';

/** cash indexes Tradier names bare ('SPX') and Schwab with a $ ('$SPX') */
export const SCHWAB_INDEXES = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'XSP', 'DJX', 'DJI', 'COMPX', 'OEX', 'XEO', 'MRUT', 'VIX9D', 'VIX3M', 'VVIX', 'SOX', 'TNX', 'TYX', 'IRX', 'FVX']);

const OCC = /^([A-Z][A-Z0-9.]{0,5})(\d{6})([CP])(\d{8})$/;

/** a Tradier symbol as Schwab names it: an index gets its $, an option its root padded to six @param {string} sym */
export function toSchwabSymbol(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (SCHWAB_INDEXES.has(s)) return '$' + s;
  const m = OCC.exec(s);
  return m ? m[1].padEnd(6, ' ') + m[2] + m[3] + m[4] : s;
}

/** a Schwab symbol as Tradier names it: no $ on an index, no padding in an option @param {string} sym */
export function fromSchwabSymbol(sym) {
  const s = String(sym || '').trim().toUpperCase();
  if (s.startsWith('$')) return s.slice(1);
  return OCC.test(s.replace(/ /g, '')) ? s.replace(/ /g, '') : s;
}

/** @param {unknown} v @returns {number | null} a finite number; Schwab's -999 (no value) is none */
const num = v => typeof v === 'number' && Number.isFinite(v) && v !== -999 ? v : null;
/** @param {unknown} v @returns {number | null} a price: zero is none */
const price = v => { const n = num(v); return n !== null && n > 0 ? n : null; };

/**
 * What a Tradier market data URL asks for, and the Schwab read that answers it; null for anything Schwab can't stand in
 * for (the streaming session, a path this file doesn't know). body is a POST's form body (the Market tab's quote batches).
 * @param {string} url @param {string | null} [body] @param {number} [now]
 * @returns {{ kind: 'quotes', path: string, symbols: string[] } | { kind: 'expirations', path: string }
 *   | { kind: 'chain', path: string, symbol: string } | { kind: 'timesales', path: string, start: number, end: number, regular: boolean }
 *   | { kind: 'history', path: string, symbol: string, start: string, end: string } | null}
 */
export function schwabRequest(url, body = null, now = Date.now()) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const path = u.pathname.replace(/^\/v1(?=\/)/, '');
  const p = path === '/markets/quotes' && body ? new URLSearchParams(body) : u.searchParams;
  const sym = (p.get('symbol') || '').trim().toUpperCase();
  if (path === '/markets/quotes') {
    const symbols = [...new Set((p.get('symbols') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return null;
    const q = new URLSearchParams({ symbols: symbols.map(toSchwabSymbol).join(','), fields: 'quote,reference,regular,fundamental', indicative: 'false' });
    return { kind: 'quotes', path: '/quotes?' + q, symbols };
  }
  if (!sym) return null;
  if (path === '/markets/options/expirations') {
    return { kind: 'expirations', path: '/expirationchain?' + new URLSearchParams({ symbol: toSchwabSymbol(sym) }) };
  }
  if (path === '/markets/options/chains') {
    const exp = p.get('expiration') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
    const q = new URLSearchParams({ symbol: toSchwabSymbol(sym), contractType: 'ALL', strategy: 'SINGLE', includeUnderlyingQuote: 'false', fromDate: exp, toDate: exp });
    return { kind: 'chain', path: '/chains?' + q, symbol: sym };
  }
  if (path === '/markets/timesales') {
    const minutes = { '1min': 1, '5min': 5, '15min': 15 }[p.get('interval') || '5min'];
    const at = (/** @type {string} */ s) => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s); return m ? nyWallMs(m[1], m[2]) : NaN; };
    const start = at(p.get('start') || ''), end = Math.min(at(p.get('end') || ''), now);
    if (!minutes || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const regular = p.get('session_filter') === 'open';
    const q = new URLSearchParams({ symbol: toSchwabSymbol(sym), periodType: 'day', frequencyType: 'minute', frequency: String(minutes),
      startDate: String(start), endDate: String(end), needExtendedHoursData: regular ? 'false' : 'true' });
    return { kind: 'timesales', path: '/pricehistory?' + q, start, end, regular };
  }
  if (path === '/markets/history') {
    const start = p.get('start') || '', end = p.get('end') || '';
    if ((p.get('interval') || 'daily') !== 'daily' || ![start, end].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) return null;
    const q = new URLSearchParams({ symbol: toSchwabSymbol(sym), periodType: 'year', frequencyType: 'daily', frequency: '1',
      startDate: String(nyWallMs(start, '00:00')), endDate: String(Math.min(nyWallMs(end, '23:59'), now)) });
    return { kind: 'history', path: '/pricehistory?' + q, symbol: sym, start, end };
  }
  return null;
}

/**
 * One option in Tradier's form, from a Schwab quote (quote + reference) or a chain contract (one flat record); the
 * symbol carries the strike, side and expiration, so those never depend on which one it was.
 * @param {string} symbol Schwab's padded symbol @param {any} f the fields @param {any} [ref]
 */
function option(symbol, f, ref = {}) {
  const occ = fromSchwabSymbol(symbol), m = OCC.exec(occ);
  if (!m) return null;
  const iv = num(f.volatility);
  const greeks = { delta: num(f.delta), gamma: num(f.gamma), theta: num(f.theta), vega: num(f.vega), rho: num(f.rho),
    mid_iv: iv !== null && iv > 0 ? iv / 100 : null, smv_vol: iv !== null && iv > 0 ? iv / 100 : null, bid_iv: null, ask_iv: null };
  return {
    symbol: occ, description: String(f.description || ref.description || occ), type: 'option',
    last: price(f.lastPrice ?? f.last), bid: num(f.bidPrice ?? f.bid) ?? 0, ask: num(f.askPrice ?? f.ask) ?? 0,
    bidsize: num(f.bidSize) ?? 0, asksize: num(f.askSize) ?? 0,
    open: price(f.openPrice), high: price(f.highPrice), low: price(f.lowPrice), prevclose: price(f.closePrice), close: null,
    change: num(f.netChange), change_percentage: num(f.netPercentChange ?? f.percentChange),
    volume: num(f.totalVolume) ?? 0, open_interest: num(f.openInterest) ?? 0,
    trade_date: num(f.tradeTime ?? f.tradeTimeInLong), bid_date: num(f.quoteTime ?? f.quoteTimeInLong), ask_date: num(f.quoteTime ?? f.quoteTimeInLong),
    strike: Number(m[4]) / 1000, option_type: m[3] === 'C' ? 'call' : 'put',
    expiration_date: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`,
    root_symbol: m[1], underlying: fromSchwabSymbol(ref.underlying || f.underlying || f.optionRoot || m[1]),
    contract_size: num(f.multiplier ?? ref.multiplier) ?? 100,
    greeks: Object.values(greeks).some(v => v !== null) ? greeks : null,
  };
}

/**
 * One Schwab /quotes entry as Tradier's quote. last is the regular session's, as Tradier's is (its after-hours prints show
 * through extSession from the bid and ask); close is today's close once the session is over.
 * @param {any} entry @param {string} asked the symbol as the app asked for it @param {number} [now]
 */
export function quoteFromSchwab(entry, asked, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const q = entry.quote || {}, ref = entry.reference || {}, reg = entry.regular || {}, fund = entry.fundamental || {};
  if (entry.assetMainType === 'OPTION') return option(entry.symbol || toSchwabSymbol(asked), q, ref);
  const main = String(entry.assetMainType || '');
  const type = main === 'INDEX' ? 'index' : main === 'EQUITY' ? (entry.assetSubType === 'ETF' ? 'etf' : 'stock') : main.toLowerCase();
  const last = price(reg.regularMarketLastPrice) ?? price(q.lastPrice);
  const tradeDate = num(reg.regularMarketTradeTime) ?? num(q.tradeTime);
  const prevclose = price(q.closePrice);
  const clock = wallClock(now, 'America/New_York');
  const closed = last !== null && tradeDate !== null && wallClock(tradeDate, 'America/New_York').day === clock.day && clock.time >= '16:00';
  const change = num(reg.regularMarketNetChange) ?? num(q.netChange) ?? (last !== null && prevclose !== null ? last - prevclose : null);
  return {
    symbol: asked, description: String(ref.description || asked), type, exch: ref.exchange || '',
    last, bid: num(q.bidPrice) ?? 0, ask: num(q.askPrice) ?? 0, bidsize: num(q.bidSize) ?? 0, asksize: num(q.askSize) ?? 0,
    open: price(q.openPrice), high: price(q.highPrice), low: price(q.lowPrice), prevclose, close: closed ? last : null,
    change, change_percentage: num(reg.regularMarketPercentChange) ?? num(q.netPercentChange)
      ?? (change !== null && prevclose !== null ? change / prevclose * 100 : null),
    volume: num(q.totalVolume) ?? 0, average_volume: num(fund.avg10DaysVolume) ?? num(fund.avg1YearVolume) ?? 0,
    week_52_high: price(q['52WeekHigh']), week_52_low: price(q['52WeekLow']),
    trade_date: tradeDate, bid_date: num(q.bidTime), ask_date: num(q.askTime),
    realtime: typeof entry.realtime === 'boolean' ? entry.realtime : null,
  };
}

/**
 * Schwab's answer as the Tradier body the request would have had.
 * @param {NonNullable<ReturnType<typeof schwabRequest>>} req @param {any} body @param {number} [now]
 */
export function tradierBody(req, body, now = Date.now()) {
  if (req.kind === 'quotes') {
    const found = [], unmatched = [];
    for (const sym of req.symbols) {
      const q = body && typeof body === 'object' ? quoteFromSchwab(body[toSchwabSymbol(sym)], sym, now) : null;
      if (q) found.push(q); else unmatched.push(sym);
    }
    /** @type {any} */
    const quotes = {};
    if (found.length) quotes.quote = found.length === 1 ? found[0] : found;
    if (unmatched.length) quotes.unmatched_symbols = { symbol: unmatched.length === 1 ? unmatched[0] : unmatched };
    return { quotes };
  }
  if (req.kind === 'expirations') {
    const dates = [...new Set((Array.isArray(body?.expirationList) ? body.expirationList : [])
      .map((/** @type {any} */ e) => String(e?.expirationDate || '').slice(0, 10)).filter((/** @type {string} */ d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    return { expirations: dates.length ? { date: dates } : null };
  }
  if (req.kind === 'chain') {
    const out = [];
    for (const map of [body?.callExpDateMap, body?.putExpDateMap]) {
      for (const strikes of Object.values(map && typeof map === 'object' ? map : {})) {
        for (const list of Object.values(strikes && typeof strikes === 'object' ? strikes : {})) {
          for (const c of Array.isArray(list) ? list : []) {
            const o = c && typeof c.symbol === 'string' ? option(c.symbol, c, { underlying: req.symbol }) : null;
            if (o) out.push(o);
          }
        }
      }
    }
    out.sort((a, b) => a.strike - b.strike || a.option_type.localeCompare(b.option_type));
    return { options: out.length ? { option: out } : null };
  }
  /** @type {any[]} */
  const candles = Array.isArray(body?.candles) ? body.candles : [];
  if (req.kind === 'timesales') {
    const data = candles
      .filter(c => [c?.open, c?.high, c?.low, c?.close, c?.datetime].every(v => typeof v === 'number' && Number.isFinite(v)) && c.high >= c.low)
      .filter(c => c.datetime >= req.start && c.datetime <= req.end)
      .sort((a, b) => a.datetime - b.datetime)
      .map(c => {
        const { day, time } = wallClock(c.datetime, 'America/New_York');
        return { time: `${day}T${time}:00`, timestamp: Math.floor(c.datetime / 1000), price: c.close, open: c.open, high: c.high, low: c.low, close: c.close, volume: +c.volume || 0 };
      })
      .filter(b => !req.regular || regularBar(b.time));
    return { series: data.length ? { data } : null };
  }
  const days = futuresDays(body).filter(d => d.date >= req.start && d.date <= req.end);
  return { history: days.length ? { day: days } : null };
}

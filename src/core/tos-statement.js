// @ts-check
// thinkorswim's Account Statement CSV, pure: the futures fills in it, for the journal. Schwab's API has no futures (they
// sit with Schwab's futures firm), so a statement exported from thinkorswim (Monitor → Account Statement → Export to File)
// is how they come in. The file is sections stacked one after another ('Cash Balance', 'Futures Statements', 'Account
// Trade History', ...), each a title line, a header line and rows. Fills come from Futures Statements (one TRD row per
// execution: its order number, 'BOT +1 /MNQZ26:XCME @29874.00', and its fees); whether each opened or closed comes from
// Account Trade History (Pos Effect), matched on time, contract, side, quantity and price. Times are the clock thinkorswim
// showed, with no zone: they're read in a zone the caller picks (statementZone matches the file's stock fills against
// Schwab's own to find it). Stocks and options are left out: Schwab's API already brings them.
import { futuresSpec } from './futures.js';

/**
 * @typedef {{ id: string, orderId: string, wall: string, symbol: string, label: string, side: 'buy' | 'sell', qty: number,
 *   price: number, fee: number, instruction: string }} StatementFill a futures fill, its time still the file's wall clock
 *   ('2026-10-20T07:28:36'); fee is what it cost (positive)
 * @typedef {{ line: number, text: string, why: string }} Skipped
 */

/** one CSV line into cells: quotes, doubled quotes, and thinkorswim's ="1008…" (a number kept as text) undone. @param {string} line */
export function csvCells(line) {
  /** @type {string[]} */
  const out = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cell); cell = ''; }
    else cell += c;
  }
  out.push(cell);
  return out.map(s => s.trim().replace(/^=/, ''));
}

/** '$1,234.50', '(4.25)', '-0.36', '--' → a number, or NaN. @param {string} s */
const money = s => {
  const t = String(s || '').trim();
  if (!t || t === '--' || t === '~') return NaN;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const v = Number(t.replace(/[()$,+\-\s]/g, ''));
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
};

/** '10/20/26' and '07:28:36' → '2026-10-20T07:28:36', or ''. @param {string} date @param {string} time */
const wallOf = (date, time) => {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(date || '').trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time || '').trim());
  if (!d || !t) return '';
  const year = d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
  const p2 = (/** @type {string | number} */ n) => String(n).padStart(2, '0');
  return `${year}-${p2(d[1])}-${p2(d[2])}T${p2(t[1])}:${t[2]}:${t[3] || '00'}`;
};

/** the file's sections by title: each { header, rows: { cells, line }[] }. @param {string} text */
function sections(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  /** @type {Map<string, { header: string[], rows: { cells: string[], line: number }[] }>} */
  const out = new Map();
  /** @type {{ header: string[], rows: { cells: string[], line: number }[] } | null} */
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) { cur = null; continue; }
    const cells = csvCells(raw);
    const filled = cells.filter(Boolean);
    // a title: one cell on its own, a blank line or the file's start before it, and a header after it
    if (!cur && filled.length === 1 && cells.length <= 2 && lines[i + 1] && csvCells(lines[i + 1]).filter(Boolean).length > 2) {
      cur = { header: csvCells(lines[i + 1]).map(h => h.toLowerCase()), rows: [] };
      out.set(filled[0].toLowerCase(), cur);
      i++;
      continue;
    }
    if (cur) cur.rows.push({ cells, line: i + 1 });
  }
  return out;
}

/** a section row as { header name: cell }. @param {string[]} header @param {string[]} cells */
const named = (header, cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));

const DESCRIPTION = /^(BOT|SOLD)\s+([+-]?[\d,]+)\s+(\/[A-Z0-9]+)(?::[A-Z]+)?\s+@\s*([\d,]*\.?\d+)\s*$/i;

/** 'BUY' + 'TO OPEN' → the instruction the journal reads (closing ones can't open the other way); unknown effect stays neutral */
const instructionFor = (/** @type {'buy' | 'sell'} */ side, /** @type {string} */ effect) =>
  /OPEN/.test(effect) ? (side === 'buy' ? 'BUY_TO_OPEN' : 'SELL_TO_OPEN')
    : /CLOSE/.test(effect) ? (side === 'buy' ? 'BUY_TO_CLOSE' : 'SELL_TO_CLOSE')
      : side === 'buy' ? 'BUY' : 'SELL_SHORT';

/**
 * The futures fills in a thinkorswim Account Statement, plus what the file says about itself: the account's last 4
 * digits (never more), the dates it covers, and its stock fills (order number and wall time) for statementZone. A row
 * that can't be read, or a contract without a known point value, is skipped and named. Each fill's id is its order
 * number and its place among that order's fills, so the same fill exported again (another date range) has the same id.
 * @param {string} text
 * @returns {{ account: string, from: string, through: string, fills: StatementFill[], skipped: Skipped[],
 *   stockFills: { orderId: string, wall: string }[], error?: string }}
 */
export function parseTosStatement(text) {
  const first = String(text || '').replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  const head = /Account Statement for\s+(\S+).*?since\s+(\S+)\s+through\s+(\S+)/i.exec(first);
  const digits = head ? head[1].replace(/\D/g, '') : '';
  const base = { account: digits.slice(-4), from: head ? wallOf(head[2], '0:00').slice(0, 10) : '', through: head ? wallOf(head[3], '0:00').slice(0, 10) : '',
    fills: /** @type {StatementFill[]} */ ([]), skipped: /** @type {Skipped[]} */ ([]), stockFills: /** @type {{ orderId: string, wall: string }[]} */ ([]) };
  if (!head) return { ...base, error: "This isn't a thinkorswim Account Statement: its first line should say 'Account Statement for …'." };
  if (!base.account) return { ...base, error: "Can't find the account number on the statement's first line." };
  const parts = sections(text);
  const futures = parts.get('futures statements');
  if (!futures) return { ...base, error: 'This statement has no Futures Statements section: no futures trades in its dates, or it was exported without them.' };

  // whether each futures fill opened or closed: Account Trade History, by time, contract, side, quantity and price
  /** @type {Map<string, string[]>} */
  const effects = new Map();
  const history = parts.get('account trade history');
  for (const { cells } of history?.rows || []) {
    const r = named(history?.header || [], cells);
    if (!/FUTURE/i.test(r.type || r.spread || '')) continue;
    const [date, time] = String(r['exec time'] || '').split(/\s+/);
    const side = /^B/i.test(r.side) ? 'buy' : 'sell', qty = Math.abs(money(r.qty)), price = money(r.price);
    const k = `${wallOf(date, time)}|${String(r.symbol).toUpperCase()}|${side}|${qty}|${price}`;
    if (!effects.has(k)) effects.set(k, []);
    /** @type {string[]} */ (effects.get(k)).push(String(r['pos effect'] || '').toUpperCase());
  }

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const { cells, line } of futures.rows) {
    const r = named(futures.header, cells);
    if (String(r.type).toUpperCase() !== 'TRD') continue;
    const m = DESCRIPTION.exec(String(r.description || ''));
    const wall = wallOf(r['exec date'] || r['trade date'], r['exec time']);
    if (!m || !wall) { base.skipped.push({ line, text: r.description || cells.join(','), why: /\b(CALL|PUT)\b/i.test(r.description || '') ? "futures options aren't supported yet" : "couldn't read it" }); continue; }
    const symbol = m[3].toUpperCase(), spec = futuresSpec(symbol);
    if (!spec) { base.skipped.push({ line, text: r.description, why: `no point value for ${symbol} yet` }); continue; }
    const side = m[1].toUpperCase() === 'BOT' ? 'buy' : 'sell', qty = Math.abs(money(m[2])), price = money(m[4]);
    if (!(qty > 0) || !(price > 0)) { base.skipped.push({ line, text: r.description, why: "couldn't read the quantity or price" }); continue; }
    const ref = /^\d+$/.test(r['ref #']) ? r['ref #'] : `${wall}:${symbol}`;
    const n = (seen.get(ref) || 0) + 1;
    seen.set(ref, n);
    const fees = [money(r['misc fees']), money(r['commissions & fees'])].filter(Number.isFinite).reduce((a, b) => a + b, 0);
    const effect = effects.get(`${wall}|${symbol}|${side}|${qty}|${price}`)?.shift() || '';
    base.fills.push({
      id: `tos:${ref}:${n}`, orderId: `tos:${ref}`, wall, symbol, label: symbol, side, qty, price,
      fee: Math.round(-fees * 100) / 100, instruction: instructionFor(side, effect),
    });
  }

  // the stock fills' order numbers and times, which Schwab's API has too: they tell which zone the file's clock is in
  const cash = parts.get('cash balance');
  for (const { cells } of cash?.rows || []) {
    const r = named(cash?.header || [], cells);
    if (String(r.type).toUpperCase() !== 'TRD' || !/^\d+$/.test(r['ref #'])) continue;
    const wall = wallOf(r.date, r.time);
    if (wall) base.stockFills.push({ orderId: r['ref #'], wall });
  }
  return base;
}

/** the zone's offset from UTC at an instant, in ms. @param {string} zone @param {number} ms */
function offsetAt(zone, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - ms;
}

/** a wall-clock time ('2026-10-20T07:28:36') in a zone → epoch ms (daylight saving handled), or NaN. @param {string} wall @param {string} zone */
export function wallToMs(wall, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wall);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  try {
    const first = asUtc - offsetAt(zone, asUtc);
    return asUtc - offsetAt(zone, first);
  } catch {
    return NaN;
  }
}

/** the US zones thinkorswim's clock is likely in, by name; on a tie (Arizona is Pacific's clock all summer) the earlier wins */
export const STATEMENT_ZONES = [
  ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Los_Angeles', 'Pacific'],
  ['America/Phoenix', 'Arizona'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['UTC', 'UTC'],
];

/** 'Pacific', or the zone's own name. @param {string} zone */
export const zoneName = zone => STATEMENT_ZONES.find(([z]) => z === zone)?.[1] || zone;

/** a time this close to Schwab's own is the same fill (thinkorswim and the API can be a second or so apart) */
const SAME_FILL_MS = 90 * 1000;

/**
 * Which zone the file's times are in. thinkorswim prints its computer's clock with no zone, so the file's stock fills
 * are matched against the same orders in Schwab's API (order number = Schwab's orderId, the times real): the zone where
 * the most of them line up wins, the device's own zone first on a tie. With none to match, the device's zone (the app
 * likely runs where thinkorswim does).
 * @param {{ orderId: string, wall: string }[]} stockFills @param {{ orderId: string, time: string }[]} schwabFills
 * @param {string} deviceZone
 * @returns {{ zone: string, matched: number, checked: number }}
 */
export function statementZone(stockFills, schwabFills, deviceZone) {
  /** @type {Map<string, number[]>} */
  const times = new Map();
  for (const f of schwabFills) {
    const ms = Date.parse(f.time);
    if (!Number.isFinite(ms)) continue;
    if (!times.has(f.orderId)) times.set(f.orderId, []);
    /** @type {number[]} */ (times.get(f.orderId)).push(ms);
  }
  const checkable = stockFills.filter(f => times.has(f.orderId));
  const zones = [deviceZone, ...STATEMENT_ZONES.map(([z]) => z)].filter((z, i, a) => z && a.indexOf(z) === i);
  let best = { zone: deviceZone || 'America/New_York', matched: 0, checked: checkable.length };
  for (const zone of zones) {
    const matched = checkable.filter(f => {
      const ms = wallToMs(f.wall, zone);
      return /** @type {number[]} */ (times.get(f.orderId)).some(t => Math.abs(t - ms) <= SAME_FILL_MS);
    }).length;
    if (matched > best.matched) best = { zone, matched, checked: checkable.length };
  }
  return best;
}

/**
 * The fills as the journal keeps them: times read in the zone, the account's last 4 on each. Ready for schwab_records
 * as kind 'statement_fill' (record_id = the fill id).
 * @param {StatementFill[]} fills @param {string} account @param {string} zone
 */
export function statementRecords(fills, account, zone) {
  return fills.map(f => {
    const ms = wallToMs(f.wall, zone);
    const time = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
    const { wall, ...rest } = f;
    return { kind: 'statement_fill', record_id: f.id, account, entered_at: time, data: { ...rest, account, time, assetType: 'FUTURE', source: 'thinkorswim' } };
  });
}

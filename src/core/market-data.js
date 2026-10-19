// @ts-check
// Pure market-data operations: CSV parsing, grouping, filtering, sorting, and batched quote fetches.
// No DOM; exercised directly by tests/market.test.mjs.
/**
 * A CSV row (stock or ETF; returns are the period columns, ETFs add From open and 1Y), a theme group,
 * either one in a list, and a refreshed quote.
 * @typedef {{ ticker: string, name: string, group: string, returns: (number | null)[], category?: string,
 *   price?: number | null, volume?: number | null }} Row
 * @typedef {{ name: string, stocks: Row[], count: number, coverage: number[], returns: (number | null)[] }} Group
 * @typedef {{ name: string, ticker?: string, group?: string, returns: (number | null)[], stocks?: Row[] }} Listed
 * @typedef {{ price: number, change: number, fromOpen: number | null, volume: number | null, tradeDate: number | null }} Quote
 * A symbol's daily-close references for the longer periods (HISTORY_PERIODS order), the last close, and the New York day it was read.
 * @typedef {{ day: string, refs: (number | null)[], last: number | null }} History
 */
export const MarketData = (() => {
  const periods = ['today', '1w', '1m', '3m', '6m', 'ytd'];
  // The longer periods daily history fills, and where each sits in a row's returns (1Y is index 7, after ETFs' From open).
  const HISTORY_PERIODS = ['1w', '1m', '3m', '6m', 'ytd', '1y'];
  const HISTORY_INDEX = [1, 2, 3, 4, 5, 7];
  // A reference close older than this before its date means the symbol wasn't trading then (a new listing, a gap).
  const REF_GAP_DAYS = 10;
  const number = /** @param {unknown} value @returns {number | null} */ value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  /** @param {string} text @returns {Row[]} */
  function parseCsv(text) {
    /** @type {string[][]} */
    const records = [];
    /** @type {string[]} */
    let row = [];
    let field = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (ch === ',' || ch === '\n' || ch === undefined)) {
        row.push(field.replace(/\r$/, '')); field = '';
        if (ch !== ',') { if (row.some(value => value.trim())) records.push(row); row = []; }
      } else field += ch === undefined ? '' : ch;
    }
    if (quoted) throw new Error('Unclosed quote in the market CSV.');
    const columns = records.shift() || [];
    const required = ['ticker', 'name', 'group', ...periods.map(p => 'performance_' + p)];
    const indices = required.map(key => columns.indexOf(key));
    if (indices.some(i => i < 0)) throw new Error('Market CSV is missing required columns.');
    const categoryIndex = columns.indexOf('category');
    const extras = ['performance_open', 'performance_1y'].map(key => columns.indexOf(key));
    if (categoryIndex >= 0 && extras.some(i => i < 0)) throw new Error('ETF CSV is missing required columns.');
    const seen = new Set();
    // The stock export writes 0 where it has no return (a new listing's 3M, say); its real values carry decimals.
    const blankZero = categoryIndex < 0;
    return records.map(record => {
      const [ticker, name, group, ...values] = indices.map(i => (record[i] || '').trim());
      if (!ticker || !name || !group) throw new Error('Market CSV contains an incomplete stock mapping.');
      if (seen.has(ticker)) throw new Error('Duplicate ticker in market CSV: ' + ticker);
      seen.add(ticker);
      /** @type {Row} */
      const result = { ticker, name, group, returns: values.map(number).map(v => blankZero && v === 0 ? null : v) };
      if (categoryIndex >= 0) {
        result.category = (record[categoryIndex] || '').trim();
        if (!['group-etfs', 'sectors', 'equal-weight', 'countries'].includes(result.category)) throw new Error('Unknown ETF category: ' + result.category);
        result.returns.push(...extras.map(i => number(record[i])));
      }
      return result;
    });
  }
  /** @param {Row[]} rows @returns {Group[]} */
  function groups(rows) {
    /** @type {Map<string, Row[]>} */
    const buckets = new Map();
    rows.forEach(row => {
      const list = buckets.get(row.group);
      if (list) list.push(row); else buckets.set(row.group, [row]);
    });
    return [...buckets].map(([name, stocks]) => {
      const coverage = periods.map((_, i) => stocks.filter(s => Number.isFinite(s.returns[i])).length);
      return {
        name, stocks, count: stocks.length, coverage,
        returns: periods.map((_, i) => coverage[i] ? stocks.reduce((sum, s) => sum + (s.returns[i] ?? 0), 0) / coverage[i] : null),
      };
    });
  }
  /** @template {Listed} T @param {T[]} rows @param {string} query @returns {T[]} */
  function filter(rows, query) {
    const text = query.trim().toLowerCase();
    if (!text) return rows;
    const matches = /** @param {Listed} row */ row => [row.name, row.ticker, row.group].some(value => value && value.toLowerCase().includes(text));
    return rows.filter(row => matches(row) || row.stocks?.some(matches));
  }
  /** @template {Listed} T @param {T[]} rows @param {number | 'ticker'} period @param {string} direction @returns {T[]} */
  function sort(rows, period, direction) {
    return [...rows].sort((a, b) => {
      if (period === 'ticker') return (a.ticker || a.name).localeCompare(b.ticker || b.name) * (direction === 'asc' ? 1 : -1);
      const x = a.returns[period] ?? null, y = b.returns[period] ?? null;
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      return (x !== null && y !== null ? (x - y) * (direction === 'asc' ? 1 : -1) : 0)
        || (a.ticker || a.name).localeCompare(b.ticker || b.name);
    });
  }
  /** @param {any} payload @returns {Record<string, Quote>} */
  function quoteRows(payload) {
    const raw = payload?.quotes?.quote;
    /** @type {Record<string, Quote>} */
    const result = Object.create(null);
    (Array.isArray(raw) ? raw : raw ? [raw] : []).forEach(/** @param {any} q */ q => {
      const price = number(q.last), previous = number(q.prevclose);
      const change = number(q.change_percentage) ?? (price !== null && previous !== null && price > 0 && previous > 0 ? (price / previous - 1) * 100 : null);
      if (typeof q.symbol !== 'string' || price === null || !(price > 0) || change === null || q.type === 'option') return;
      const open = number(q.open);
      result[q.symbol] = { price, change, fromOpen: open !== null && open > 0 ? (price / open - 1) * 100 : null,
        volume: number(q.volume), tradeDate: number(q.trade_date) };
    });
    return result;
  }
  /** @param {Row[]} rows @param {Record<string, Quote>} quotes @returns {Row[]} */
  function withQuotes(rows, quotes) {
    return rows.map(row => {
      const quote = quotes[row.ticker];
      const returns = [quote?.change ?? null, ...row.returns.slice(1)];
      if (returns.length > 6) returns[6] = Number.isFinite(quote?.fromOpen) ? quote.fromOpen : null;
      return { ...row, price: quote?.price ?? null, volume: quote?.volume ?? null,
        returns };
    });
  }
  /** @param {string} day YYYY-MM-DD @param {{ days?: number, months?: number }} shift back by this much @returns {string} */
  function dayBefore(day, { days = 0, months = 0 }) {
    const [y, m, d] = day.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1 - months, 1));
    const lastOfMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    first.setUTCDate(Math.min(d, lastOfMonth) - days);
    return first.toISOString().slice(0, 10);
  }
  /** The day each longer period measures from, in HISTORY_PERIODS order (calendar, not session counts). @param {string} today */
  function referenceDays(today) {
    return [dayBefore(today, { days: 7 }), dayBefore(today, { months: 1 }), dayBefore(today, { months: 3 }),
      dayBefore(today, { months: 6 }), (Number(today.slice(0, 4)) - 1) + '-12-31', dayBefore(today, { months: 12 })];
  }
  /**
   * Each period's reference: the last daily close on or before its day, none when the history starts later or has a gap there.
   * @param {any[]} days Tradier's history days @param {string} today New York YYYY-MM-DD @returns {History}
   */
  function historyRefs(days, today) {
    const bars = (Array.isArray(days) ? days : [])
      .filter(bar => typeof bar?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bar.date) && (number(bar.close) ?? 0) > 0)
      .map(bar => ({ date: bar.date, close: Number(bar.close) })).sort((a, b) => a.date.localeCompare(b.date));
    const refs = referenceDays(today).map(ref => {
      let found = null;
      for (const bar of bars) { if (bar.date > ref) break; found = bar; }
      return found && found.date >= dayBefore(ref, { days: REF_GAP_DAYS }) ? found.close : null;
    });
    return { day: today, refs, last: bars.length ? bars[bars.length - 1].close : null };
  }
  /**
   * The longer periods from daily closes: the quote's price (else the last close) over each reference. A symbol without history
   * yet shows none, never the snapshot's figure.
   * @param {Row[]} rows @param {Record<string, History | undefined>} history @returns {Row[]}
   */
  function withHistory(rows, history) {
    return rows.map(row => {
      const entry = history[row.ticker], returns = [...row.returns];
      const price = row.price ?? entry?.last ?? null;
      HISTORY_INDEX.forEach((index, i) => {
        if (index >= returns.length) return;
        const ref = entry?.refs[i] ?? null;
        returns[index] = ref && price ? (price / ref - 1) * 100 : null;
      });
      return { ...row, returns };
    });
  }
  /**
   * GET each symbol's daily history one at a time, spaced for Tradier's per-minute limit, retrying timeouts, 429s and 5xx.
   * A symbol Tradier refuses (4xx) answers no days; auth failures and exhausted retries throw, keeping what onSymbol already got.
   * @param {string[]} symbols
   * @param {{ base: string, auth: Record<string, string>, start: string, end: string, signal?: AbortSignal,
   *   onSymbol: (symbol: string, days: any[]) => void, onRetry?: (info: { delay: number, status?: number, attempt: number }) => void,
   *   fetchImpl?: typeof fetch, retries?: number, spacing?: number, pause?: (ms: number, signal?: AbortSignal) => Promise<unknown> }} options
   */
  async function fetchHistories(symbols, { base, auth, start, end, signal, onSymbol, onRetry = () => {}, fetchImpl = fetch,
    retries = 2, spacing = 600, pause = waitForRefresh }) {
    for (let i = 0; i < symbols.length; i++) {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new Error('Refresh cancelled.');
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, {once:true});
        const timeout = setTimeout(cancel, 20000);
        /** @type {(Error & { status?: number, retryAfter?: number }) | undefined} */
        let failure;
        try {
          const url = base + '/markets/history?symbol=' + encodeURIComponent(symbols[i]) + '&interval=daily&start=' + start + '&end=' + end;
          const response = await fetchImpl(url, { headers: { ...auth }, signal: controller.signal });
          if (!response.ok) {
            const error = /** @type {Error & { status?: number, retryAfter?: number }} */ (new Error(response.status === 429 ? 'Tradier rate limit reached.'
              : response.status === 401 || response.status === 403 ? 'Check your Tradier API key and environment in Size.'
              : 'Tradier could not load daily history (' + response.status + ').'));
            error.status = response.status;
            if (response.status === 429) {
              const retry = Number(response.headers?.get('Retry-After'));
              error.retryAfter = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60000;
            }
            throw error;
          }
          const payload = await response.json();
          if (signal?.aborted) throw new Error('Refresh cancelled.');
          const days = payload?.history?.day;
          onSymbol(symbols[i], Array.isArray(days) ? days : days ? [days] : []);
        } catch (error) {
          if (signal?.aborted) throw new Error('Refresh cancelled.');
          failure = controller.signal.aborted ? new Error('Tradier timed out loading daily history.') : /** @type {Error & { status?: number, retryAfter?: number }} */ (error);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', cancel);
        }
        if (!failure) break;
        if (failure.status && failure.status !== 429 && failure.status < 500) {
          if (failure.status === 401 || failure.status === 403) throw failure;
          onSymbol(symbols[i], []); break;
        }
        if (attempt >= retries) throw failure;
        const delay = failure.retryAfter || 1000 * 2 ** attempt;
        onRetry({delay, status:failure.status, attempt:attempt + 1});
        await pause(delay, signal);
      }
      if (i + 1 < symbols.length) await pause(spacing, signal);
    }
    if (signal?.aborted) throw new Error('Refresh cancelled.');
  }
  /** @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
  function waitForRefresh(ms, signal) {
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', cancel); resolve(undefined); };
      const timer = setTimeout(finish, ms);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('Refresh cancelled.')); };
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once:true});
    });
  }
  /**
   * POST quotes in batches of 100, retrying timeouts, 429s and 5xx with backoff (Retry-After honored).
   * @param {string[]} symbols
   * @param {{ base: string, auth: Record<string, string>, signal?: AbortSignal, onProgress?: (done: number, total: number) => void,
   *   onRetry?: (info: { delay: number, status?: number, attempt: number }) => void, fetchImpl?: typeof fetch, retries?: number,
   *   pause?: (ms: number, signal?: AbortSignal) => Promise<unknown> }} options
   */
  async function fetchQuotes(symbols, { base, auth, signal, onProgress = () => {}, onRetry = () => {}, fetchImpl = fetch,
    retries = 2, pause = waitForRefresh }) {
    const result = Object.create(null);
    for (let i = 0; i < symbols.length; i += 100) {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new Error('Refresh cancelled.');
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, {once:true});
        const timeout = setTimeout(cancel, 20000);
        /** @type {(Error & { status?: number, retryAfter?: number }) | undefined} */
        let failure;
        try {
          const response = await fetchImpl(base + '/markets/quotes', {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ symbols: symbols.slice(i, i + 100).join(','), greeks: 'false' }).toString(),
            signal: controller.signal,
          });
          if (!response.ok) {
            const error = /** @type {Error & { status?: number, retryAfter?: number }} */ (new Error(response.status === 429 ? 'Tradier rate limit reached.'
              : response.status === 401 || response.status === 403 ? 'Check your Tradier API key and environment in Size.'
              : 'Tradier could not refresh quotes (' + response.status + ').'));
            error.status = response.status;
            if (response.status === 429) {
              const retry = response.headers?.get('Retry-After');
              const expiry = Number(response.headers?.get('X-Ratelimit-Expiry'));
              const after = retry ? Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0;
              const reset = expiry > Date.now() ? expiry - Date.now() : 60000;
              error.retryAfter = Math.max(1000, Number.isFinite(after) && after > 0 ? after : reset);
            }
            throw error;
          }
          const payload = await response.json();
          if (payload?.errors || !payload?.quotes) throw Object.assign(new Error('Tradier returned an invalid quote response.'), {status:422});
          if (signal?.aborted) throw new Error('Refresh cancelled.');
          Object.assign(result, quoteRows(payload));
        } catch (error) {
          if (signal?.aborted) throw new Error('Refresh cancelled.');
          failure = controller.signal.aborted ? new Error('Tradier timed out. Try refreshing again.') : /** @type {Error & { status?: number, retryAfter?: number }} */ (error);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', cancel);
        }
        if (!failure) break;
        if (attempt >= retries || (failure.status && failure.status !== 429 && failure.status < 500)) throw failure;
        const delay = failure.retryAfter || 1000 * 2 ** attempt;
        onRetry({delay, status:failure.status, attempt:attempt + 1});
        await pause(delay, signal);
      }
      onProgress(Math.min(i + 100, symbols.length), symbols.length);
      if (i + 100 < symbols.length) await pause(1250, signal);
    }
    if (signal?.aborted) throw new Error('Refresh cancelled.');
    return result;
  }
  return { HISTORY_PERIODS, HISTORY_INDEX, dayBefore, parseCsv, groups, filter, sort, quoteRows, withQuotes, referenceDays, historyRefs, withHistory, fetchHistories, fetchQuotes };
})();

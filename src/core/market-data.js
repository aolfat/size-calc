// @ts-check
// Pure market-data operations: CSV parsing, grouping, filtering, sorting, and batched quote fetches.
// No DOM; exercised directly by tests/market.test.mjs.
export const MarketData = (() => {
  const periods = ['today', '1w', '1m', '3m', '6m', 'ytd'];
  const number = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  function parseCsv(text) {
    const records = [];
    let row = [], field = '', quoted = false;
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
    return records.map(record => {
      const [ticker, name, group, ...values] = indices.map(i => (record[i] || '').trim());
      if (!ticker || !name || !group) throw new Error('Market CSV contains an incomplete stock mapping.');
      if (seen.has(ticker)) throw new Error('Duplicate ticker in market CSV: ' + ticker);
      seen.add(ticker);
      const result = { ticker, name, group, returns: values.map(number) };
      if (categoryIndex >= 0) {
        result.category = (record[categoryIndex] || '').trim();
        if (!['group-etfs', 'sectors', 'equal-weight', 'countries'].includes(result.category)) throw new Error('Unknown ETF category: ' + result.category);
        result.returns.push(...extras.map(i => number(record[i])));
      }
      return result;
    });
  }
  function groups(rows) {
    const buckets = new Map();
    rows.forEach(row => {
      if (!buckets.has(row.group)) buckets.set(row.group, []);
      buckets.get(row.group).push(row);
    });
    return [...buckets].map(([name, stocks]) => {
      const coverage = periods.map((_, i) => stocks.filter(s => Number.isFinite(s.returns[i])).length);
      return {
        name, stocks, count: stocks.length, coverage,
        returns: periods.map((_, i) => coverage[i] ? stocks.reduce((sum, s) => sum + (s.returns[i] ?? 0), 0) / coverage[i] : null),
      };
    });
  }
  function filter(rows, query) {
    const text = query.trim().toLowerCase();
    if (!text) return rows;
    const matches = row => [row.name, row.ticker, row.group].some(value => value && value.toLowerCase().includes(text));
    return rows.filter(row => matches(row) || row.stocks?.some(matches));
  }
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
  function quoteRows(payload) {
    const raw = payload?.quotes?.quote;
    const result = Object.create(null);
    (Array.isArray(raw) ? raw : raw ? [raw] : []).forEach(q => {
      const price = number(q.last), previous = number(q.prevclose);
      const change = number(q.change_percentage) ?? (price > 0 && previous > 0 ? (price / previous - 1) * 100 : null);
      if (typeof q.symbol !== 'string' || !(price > 0) || change === null || q.type === 'option') return;
      const open = number(q.open);
      result[q.symbol] = { price, change, fromOpen: open > 0 ? (price / open - 1) * 100 : null,
        volume: number(q.volume), tradeDate: number(q.trade_date) };
    });
    return result;
  }
  function withQuotes(rows, quotes) {
    return rows.map(row => {
      const quote = quotes[row.ticker];
      const returns = [quote?.change ?? null, ...row.returns.slice(1)];
      if (returns.length > 6) returns[6] = Number.isFinite(quote?.fromOpen) ? quote.fromOpen : null;
      return { ...row, price: quote?.price ?? null, volume: quote?.volume ?? null,
        returns };
    });
  }
  function waitForRefresh(ms, signal) {
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(finish, ms);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('Refresh cancelled.')); };
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once:true});
    });
  }
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
        let failure;
        try {
          const response = await fetchImpl(base + '/markets/quotes', {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ symbols: symbols.slice(i, i + 100).join(','), greeks: 'false' }).toString(),
            signal: controller.signal,
          });
          if (!response.ok) {
            const error = new Error(response.status === 429 ? 'Tradier rate limit reached.'
              : response.status === 401 || response.status === 403 ? 'Check your Tradier API key and environment in Size.'
              : 'Tradier could not refresh quotes (' + response.status + ').');
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
          failure = controller.signal.aborted ? new Error('Tradier timed out. Try refreshing again.') : error;
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
  return { parseCsv, groups, filter, sort, quoteRows, withQuotes, fetchQuotes };
})();

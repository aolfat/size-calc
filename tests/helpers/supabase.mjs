// A fake Supabase client over an in-memory schwab_records table and trades table, close enough to the real one for the
// journal tests: select(...).eq().in().order().limit() reads rows (records newest first when ordered), upsert(rows,
// { ignoreDuplicates }) inserts or replaces records by (user, kind, record id), insert / update().eq() / delete().in()
// write trades by id, and fail() makes every call answer with an error (failTrades() only the trades table's).
export function fakeRecords(seed = [], tradeSeed = []) {
  const key = r => `${r.user_id || 'user-1'}:${r.kind}:${r.record_id}`;
  const table = new Map(seed.map(r => [key(r), { user_id: 'user-1', ...r }]));
  const trades = new Map(tradeSeed.map(r => [r.id, { ...r }]));
  const writes = [];
  const tradeOps = [];
  const reads = [];
  let failure = null, tradesFailure = null;
  const answerFor = name => data => {
    const f = failure || (name === 'trades' ? tradesFailure : null);
    return f ? { data: null, error: { message: f.message }, status: f.status } : { data, error: null, status: 200 };
  };
  // a filter chain that runs fn(rows matching the filters) once awaited
  const chain = (rowsOf, fn) => {
    const filters = [];
    const q = {
      eq: (col, v) => { filters.push(r => r[col] === v); return q; },
      in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
      then: (resolve, reject) => Promise.resolve(fn(rowsOf().filter(r => filters.every(f => f(r))))).then(resolve, reject),
    };
    return q;
  };
  return {
    table, trades, writes, tradeOps, reads,
    rows: () => [...table.values()],
    fail(f = { status: 500, message: 'nope' }) { failure = f; },
    failTrades(f = { status: 404, message: 'relation "public.trades" does not exist' }) { tradesFailure = f; },
    from: name => {
      const answer = answerFor(name);
      const store = name === 'trades' ? trades : table;
      return {
        select: cols => {
          let ordered = false;
          reads.push({ table: name, cols });
          const q = chain(() => [...store.values()], rows => {
            rows = rows.map(r => ({ ...r }));
            if (ordered && name !== 'trades') rows.sort((a, b) => String(b.entered_at || '').localeCompare(String(a.entered_at || '')));
            return answer(rows);
          });
          q.order = () => { ordered = true; return q; };
          q.limit = () => q;
          return q;
        },
        upsert: async (rows, opts = {}) => {
          if (failure) return answer(null);
          for (const r of rows) {
            writes.push({ table: name, ignoreDuplicates: !!opts.ignoreDuplicates, ...r });
            if (opts.ignoreDuplicates && table.has(key(r))) continue;
            table.set(key(r), { ...r });
          }
          return answer(null);
        },
        insert: async rows => {
          const res = answer(null);
          if (res.error) return res;
          for (const r of rows) { tradeOps.push({ op: 'insert', ...r }); trades.set(r.id, { created_at: new Date().toISOString(), ...r }); }
          return res;
        },
        update: patch => chain(() => [...trades.values()], rows => {
          const res = answer(null);
          if (res.error) return res;
          for (const r of rows) { tradeOps.push({ op: 'update', id: r.id, ...patch }); Object.assign(trades.get(r.id), patch); }
          return res;
        }),
        delete: () => chain(() => [...trades.values()], rows => {
          const res = answer(null);
          if (res.error) return res;
          for (const r of rows) { tradeOps.push({ op: 'delete', id: r.id }); trades.delete(r.id); }
          return res;
        }),
      };
    },
  };
}

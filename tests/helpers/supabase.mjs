// A fake Supabase client over in-memory schwab_records, trade_reviews and trades tables, close enough to the real ones
// for the journal tests: select(...).eq().in().order().limit() reads rows (records newest first when ordered),
// upsert(rows, { ignoreDuplicates }) inserts or replaces by the table's key ((user, kind, record id), or (user, trade
// key)), insert / update().eq() / delete().in() write trades rows by id (logged in tradeOps), fail() makes every call
// answer with an error, and failTable(name) only that table's (a migration not applied yet).
export function fakeRecords(seed = [], reviewSeed = [], tradeSeed = []) {
  const keys = { schwab_records: r => `${r.user_id || 'user-1'}:${r.kind}:${r.record_id}`, trade_reviews: r => `${r.user_id || 'user-1'}:${r.trade_key}` };
  const table = new Map(seed.map(r => [keys.schwab_records(r), { user_id: 'user-1', ...r }]));
  const reviews = new Map(reviewSeed.map(r => [keys.trade_reviews(r), { user_id: 'user-1', ...r }]));
  const trades = new Map(tradeSeed.map(r => [r.id, { ...r }]));
  const tables = { schwab_records: table, trade_reviews: reviews, trades };
  const tradeOps = [];
  const broken = new Set();
  const writes = [];
  const reads = [];
  let failure = null;
  const answer = (data, name) => failure ? { data: null, error: { message: failure.message }, status: failure.status }
    : broken.has(name) ? { data: null, error: { message: `relation "public.${name}" does not exist` }, status: 404 } : { data, error: null, status: 200 };
  // update / delete: filters, then fn(the trades rows that match) once awaited
  const tradeChain = (name, fn) => {
    const filters = [];
    const q = {
      eq: (col, v) => { filters.push(r => r[col] === v); return q; },
      in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
      then: (resolve, reject) => {
        const res = answer(null, name);
        if (!res.error) fn([...trades.values()].filter(r => filters.every(f => f(r))));
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    table, reviews, trades, writes, reads, tradeOps,
    rows: () => [...table.values()],
    reviewRows: () => [...reviews.values()],
    fail(f = { status: 500, message: 'nope' }) { failure = f; },
    failTable(name) { broken.add(name); },
    from: name => ({
      insert: async rows => {
        const res = answer(null, name);
        if (res.error) return res;
        for (const r of rows) { tradeOps.push({ op: 'insert', ...r }); trades.set(r.id, { created_at: new Date().toISOString(), ...r }); }
        return res;
      },
      update: patch => tradeChain(name, rows => { for (const r of rows) { tradeOps.push({ op: 'update', id: r.id, ...patch }); Object.assign(trades.get(r.id), patch); } }),
      delete: () => tradeChain(name, rows => { for (const r of rows) { tradeOps.push({ op: 'delete', id: r.id }); trades.delete(r.id); } }),
      select: cols => {
        const filters = [];
        let ordered = false;
        reads.push({ table: name, cols });
        const q = {
          eq: (col, v) => { filters.push(r => r[col] === v); return q; },
          in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
          order: () => { ordered = true; return q; },
          limit: () => q,
          then: (resolve, reject) => {
            let rows = [...(tables[name] || table).values()].filter(r => filters.every(f => f(r))).map(r => ({ ...r }));
            if (ordered && name !== 'trades') rows.sort((a, b) => String(b.entered_at || '').localeCompare(String(a.entered_at || '')));
            return Promise.resolve(answer(rows, name)).then(resolve, reject);
          },
        };
        return q;
      },
      upsert: async (rows, opts = {}) => {
        if (failure || broken.has(name)) return answer(null, name);
        const t = tables[name] || table, key = keys[name] || keys.schwab_records;
        for (const r of rows) {
          writes.push({ table: name, ignoreDuplicates: !!opts.ignoreDuplicates, ...(opts.onConflict ? { onConflict: opts.onConflict } : {}), ...r });
          if (opts.ignoreDuplicates && t.has(key(r))) continue;
          t.set(key(r), { ...r });
        }
        return answer(null, name);
      },
    }),
  };
}

// A fake Supabase client over in-memory schwab_records and trade_reviews tables, close enough to the real ones for the
// journal tests: select(...).eq().in().order().limit() reads rows (newest first when ordered), upsert(rows,
// { ignoreDuplicates }) inserts or replaces by the table's key ((user, kind, record id), or (user, trade key)), fail()
// makes every call answer with an error, and failTable(name) only that table's (a migration not applied yet).
export function fakeRecords(seed = [], reviewSeed = []) {
  const keys = { schwab_records: r => `${r.user_id || 'user-1'}:${r.kind}:${r.record_id}`, trade_reviews: r => `${r.user_id || 'user-1'}:${r.trade_key}` };
  const table = new Map(seed.map(r => [keys.schwab_records(r), { user_id: 'user-1', ...r }]));
  const reviews = new Map(reviewSeed.map(r => [keys.trade_reviews(r), { user_id: 'user-1', ...r }]));
  const tables = { schwab_records: table, trade_reviews: reviews };
  const broken = new Set();
  const missingCols = {};
  const writes = [];
  const reads = [];
  let failure = null;
  const answer = (data, name) => failure ? { data: null, error: { message: failure.message }, status: failure.status }
    : broken.has(name) ? { data: null, error: { message: `relation "public.${name}" does not exist` }, status: 404 } : { data, error: null, status: 200 };
  return {
    table, reviews, writes, reads,
    rows: () => [...table.values()],
    reviewRows: () => [...reviews.values()],
    fail(f = { status: 500, message: 'nope' }) { failure = f; },
    failTable(name) { broken.add(name); },
    dropColumn(name, col) { (missingCols[name] ||= []).push(col); },
    from: name => ({
      select: cols => {
        const filters = [];
        const missing = (missingCols[name] || []).find(c => String(cols || '').split(',').includes(c));
        let ordered = false;
        reads.push({ table: name, cols });
        const q = {
          eq: (col, v) => { filters.push(r => r[col] === v); return q; },
          in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
          order: () => { ordered = true; return q; },
          limit: () => q,
          then: (resolve, reject) => {
            if (missing) return Promise.resolve({ data: null, error: { message: `column ${name}.${missing} does not exist` }, status: 400 }).then(resolve, reject);
            let rows = [...(tables[name] || table).values()].filter(r => filters.every(f => f(r))).map(r => ({ ...r }));
            if (ordered) rows.sort((a, b) => String(b.entered_at || '').localeCompare(String(a.entered_at || '')));
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

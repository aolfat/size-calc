// A fake Supabase client over one in-memory schwab_records table, close enough to the real one for the journal tests:
// select(...).eq().in().order().limit() reads rows (newest first when ordered), upsert(rows, { ignoreDuplicates })
// inserts or replaces by (user, kind, record id), and fail() makes every call answer with an error.
export function fakeRecords(seed = []) {
  const key = r => `${r.user_id || 'user-1'}:${r.kind}:${r.record_id}`;
  const table = new Map(seed.map(r => [key(r), { user_id: 'user-1', ...r }]));
  const writes = [];
  const reads = [];
  let failure = null;
  const answer = data => failure ? { data: null, error: { message: failure.message }, status: failure.status } : { data, error: null, status: 200 };
  return {
    table, writes, reads,
    rows: () => [...table.values()],
    fail(f = { status: 500, message: 'nope' }) { failure = f; },
    from: name => ({
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
            let rows = [...table.values()].filter(r => filters.every(f => f(r))).map(r => ({ ...r }));
            if (ordered) rows.sort((a, b) => String(b.entered_at || '').localeCompare(String(a.entered_at || '')));
            return Promise.resolve(answer(rows)).then(resolve, reject);
          },
        };
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
    }),
  };
}

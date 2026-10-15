// A fake Supabase client over in-memory schwab_records, trade_reviews, trades, bars_5m, trade_labels, journal_days and library_items tables, close enough to the real ones
// for the journal tests: select(...).eq().in().order().limit() reads rows (records newest first when ordered),
// upsert(rows, { ignoreDuplicates }) inserts or replaces by the table's key ((user, kind, record id), or (user, trade
// key)), insert / update().eq() / delete().in() write trades rows by id (logged in tradeOps), fail() makes every call
// answer with an error, failTable(name) only that table's (a migration not applied yet), and failColumn(name, col) only
// the reads and writes that name that column (a column a migration adds).
export function fakeRecords(seed = [], reviewSeed = [], tradeSeed = []) {
  const u = r => r.user_id || 'user-1';
  const keys = {
    schwab_records: r => `${u(r)}:${r.kind}:${r.record_id}`, trade_reviews: r => `${u(r)}:${r.trade_key}`, bars_5m: r => `${u(r)}:${r.symbol}:${r.day}`,
    trade_labels: r => `${u(r)}:${r.trade_key}:${r.kind}:${r.value}`, journal_days: r => `${u(r)}:${r.day}`, library_items: r => `${u(r)}:${r.id}`,
    trade_shots: r => `${u(r)}:${r.id}`,
  };
  const table = new Map(seed.map(r => [keys.schwab_records(r), { user_id: 'user-1', ...r }]));
  const reviews = new Map(reviewSeed.map(r => [keys.trade_reviews(r), { user_id: 'user-1', ...r }]));
  const trades = new Map(tradeSeed.map(r => [r.id, { ...r }]));
  const bars = new Map();
  const tables = { schwab_records: table, trade_reviews: reviews, trades, bars_5m: bars, settings: new Map(), trade_labels: new Map(), journal_days: new Map(), library_items: new Map(), trade_shots: new Map() };
  // Storage: files by bucket and path; signed links are fake https URLs
  const files = new Map();
  const storageOps = []; // settings: an account with none, for a session resumed on boot
  const tradeOps = [];
  const broken = new Set();
  const brokenCols = [];
  const colGone = (name, cols) => brokenCols.find(([n, c]) => n === name && cols.includes(c));
  const noColumn = (name, col) => ({ data: null, error: { message: `column ${name}.${col} does not exist` }, status: 400 });
  const writes = [];
  const reads = [];
  let failure = null;
  const answer = (data, name) => failure ? { data: null, error: { message: failure.message }, status: failure.status }
    : broken.has(name) ? { data: null, error: { message: `relation "public.${name}" does not exist` }, status: 404 } : { data, error: null, status: 200 };
  // update / delete: filters, then fn(the rows that match) once awaited; trades by default, any table by name
  const tradeChain = (name, fn) => {
    const filters = [];
    const q = {
      eq: (col, v) => { filters.push(r => r[col] === v); return q; },
      in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
      then: (resolve, reject) => {
        const res = answer(null, name);
        if (!res.error) fn([...(name === 'trades' ? trades : tables[name] || trades).values()].filter(r => filters.every(f => f(r))));
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    table, reviews, trades, bars, tables, writes, reads, tradeOps, files, storageOps,
    storage: {
      from: bucket => ({
        upload: async (path, blob, opts = {}) => {
          if (failure || broken.has('storage')) return { data: null, error: { message: failure ? failure.message : 'Bucket not found' } };
          storageOps.push({ op: 'upload', bucket, path, contentType: opts.contentType, upsert: opts.upsert, size: blob?.size });
          files.set(`${bucket}/${path}`, blob);
          return { data: { path }, error: null };
        },
        createSignedUrls: async (paths, seconds) => {
          storageOps.push({ op: 'sign', bucket, paths, seconds });
          return { data: paths.map(p => ({ path: p, signedUrl: files.has(`${bucket}/${p}`) ? `https://fake.storage.test/${bucket}/${p}?token=t&expires=${seconds}` : null, error: files.has(`${bucket}/${p}`) ? null : 'not found' })), error: null };
        },
        remove: async paths => {
          storageOps.push({ op: 'remove', bucket, paths });
          for (const p of paths) files.delete(`${bucket}/${p}`);
          return { data: [], error: null };
        },
      }),
    },
    rows: () => [...table.values()],
    reviewRows: () => [...reviews.values()],
    fail(f = { status: 500, message: 'nope' }) { failure = f; },
    failTable(name) { broken.add(name); },
    failColumn(name, col) { brokenCols.push([name, col]); },
    from: name => ({
      insert: async rows => {
        const res = answer(null, name);
        if (res.error) return res;
        if (name !== 'trades') { for (const r of rows) { writes.push({ table: name, op: 'insert', ...r }); tables[name].set(keys[name](r), { user_id: 'user-1', created_at: new Date().toISOString(), ...r }); } return res; }
        for (const r of rows) { tradeOps.push({ op: 'insert', ...r }); trades.set(r.id, { created_at: new Date().toISOString(), ...r }); }
        return res;
      },
      update: patch => tradeChain(name, rows => {
        if (name !== 'trades') { for (const r of rows) { writes.push({ table: name, op: 'update', id: r.id, ...patch }); Object.assign(r, patch); } return; }
        for (const r of rows) { tradeOps.push({ op: 'update', id: r.id, ...patch }); Object.assign(trades.get(r.id), patch); }
      }),
      delete: () => tradeChain(name, rows => {
        if (name !== 'trades') { const t = tables[name]; for (const [k, v] of [...t]) if (rows.includes(v)) { t.delete(k); writes.push({ table: name, op: 'delete', ...v }); } return; }
        for (const r of rows) { tradeOps.push({ op: 'delete', id: r.id }); trades.delete(r.id); }
      }),
      select: cols => {
        const filters = [];
        let ordered = false;
        reads.push({ table: name, cols });
        const q = {
          eq: (col, v) => { filters.push(r => r[col] === v); return q; },
          in: (col, list) => { const set = new Set(list); filters.push(r => set.has(r[col])); return q; },
          gte: (col, v) => { filters.push(r => String(r[col]) >= String(v)); return q; },
          order: () => { ordered = true; return q; },
          limit: () => q,
          then: (resolve, reject) => {
            let rows = [...(tables[name] || table).values()].filter(r => filters.every(f => f(r))).map(r => ({ ...r }));
            if (ordered && name !== 'trades') rows.sort((a, b) => String(b.entered_at || '').localeCompare(String(a.entered_at || '')));
            const gone = colGone(name, String(cols || '').split(','));
            return Promise.resolve(gone ? noColumn(name, gone[1]) : answer(rows, name)).then(resolve, reject);
          },
        };
        return q;
      },
      upsert: async (rows, opts = {}) => {
        if (failure || broken.has(name)) return answer(null, name);
        const gone = colGone(name, rows.flatMap(r => Object.keys(r)));
        if (gone) return noColumn(name, gone[1]);
        const t = tables[name] || table, key = keys[name] || keys.schwab_records;
        for (const r of rows) {
          writes.push({ table: name, ignoreDuplicates: !!opts.ignoreDuplicates, ...(opts.onConflict ? { onConflict: opts.onConflict } : {}), ...r });
          if (opts.ignoreDuplicates && t.has(key(r))) continue;
          t.set(key(r), { ...(t.get(key(r)) || {}), ...r }); // an upsert updates the columns it sends, like Postgres
        }
        return answer(null, name);
      },
    }),
  };
}

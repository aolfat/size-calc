// The journal as a Claude session sees it (docs/claude-access.md), pure: what claude_journal_read returns made into the
// app's own trades (src/core, the same keys and numbers the Journal shows), each trade's review in words, and a review
// you describe ({ setups: ['Lotto'], grade: 'D', ... }) turned into the changes claude_journal_save takes, the way the
// trade page would make them: names matched to your choices or added to your library, a day's market or the trade's own,
// and reviewed_at stamped once every required field is in. A day's review ({ grade: 'D', rules: { 'Follow your stops':
// 'broke' }, weekRules: { 'No trades before 9:45': 'kept' }, ... }) becomes the notebook's changes the same way, and a
// week's or month's review ({ parts: { 'Risk management': { grade: 'D' } }, rulesNext: [...], rulesKept: {...} }) its
// period_reviews row. Nothing here reads the network or the page.
import { createHash, randomUUID } from 'node:crypto';
import { fillWords, fillsFrom } from '../src/core/journal-records.js';
import { holdWords, journalTrades } from '../src/core/journal.js';
import { bothWords, buildLibrary, GRADES, PLAN_FOLLOWED, reviewState, sameParts, setupName, SINGLE, tradeSide } from '../src/core/journal-labels.js';
import { cleanDayRow, DAY_GRADES, DAY_TEXT, dayReviewState, dayTrades, FOCUS_KEPT, isDay, lastFocus, notebookLists, RULE_ANSWERS, reviewMissingWords, rulesForDay } from '../src/core/journal-notebook.js';
import { dailyPnl, nyParts, periodKey } from '../src/core/journal-stats.js';
import { cleanPeriodRow, gradeColumn, LEGACY_RULE_ID, MAX_PERIOD_NOTE, MAX_PERIOD_RULES, MAX_RULE, noteColumn, PERIOD_CATEGORIES, PERIOD_GRADES, periodMissingWords, periodReviewState, periodRules, periodTradeRows, previousPeriod, RULE_KEPT, ruleKeptOf, weekRulesFor, weekRuleTally } from '../src/core/journal-week.js';
import { cleanPlanRow, matchPlans, planLines } from '../src/core/order-plans.js';

/** label kinds a review sets, by the word a review uses for them */
export const LABEL_FIELDS = { sector: 'sector', setups: 'setup', tactics: 'tactic', tags: 'tag', mistakes: 'mistake' };
/** everything a review may say */
export const REVIEW_FIELDS = ['market', 'marketFor', ...Object.keys(LABEL_FIELDS), 'grade', 'plan', 'entryNote', 'exitNote', 'stop'];

/** a short handle for a trade key, 't' and 7 hex: easier to say than '6789|QQQ…|long|2026-…' */
export const handleOf = key => 't' + createHash('sha256').update(key).digest('hex').slice(0, 7);
/** the New York day a trade's market belongs to: the day it opened */
export const dayOf = t => t.openedAt ? nyParts(t.openedAt).day : '';

/**
 * The read made into the journal: trades newest first (deleted ones flagged), the library, each trade's review,
 * labels, day market and order plans (the Trade at Schwab sheet's, matched as the Journal does) by key, each day's
 * notebook row and your rules, and each week's and month's review by 'unit|key'.
 * @param {{ records: any[], trades: any[], reviews: any[], labels: any[], days: any[], library: any[], order_plans?: any[], periods?: any[] }} data
 * @param {{ now?: number }} [opts]
 */
export function journalFrom(data, opts = {}) {
  const reviews = {}, labels = {}, days = {}, notebook = {}, periods = {};
  for (const p of data.periods || []) { const row = cleanPeriodRow(p); if (row) periods[`${row.unit}|${row.period_key}`] = row; }
  for (const r of data.reviews || []) reviews[r.trade_key] = { ...r, stop: r.stop === null || r.stop === undefined ? null : Number(r.stop) };
  for (const l of data.labels || []) (labels[l.trade_key] ||= []).push({ kind: l.kind, value: l.value, set_by: l.set_by, links: l.links || [] });
  for (const d of data.days || []) {
    const day = String(d.day).slice(0, 10);
    if (d.market) days[day] = d.market;
    notebook[day] = cleanDayRow(d);
  }
  const records = data.records || [];
  const fills = fillsFrom(records);
  const trades = journalTrades(fills, records, reviews, { now: opts.now ?? Date.now(), saved: data.trades || [] });
  const plans = matchPlans(trades, (data.order_plans || []).map(cleanPlanRow).filter(Boolean));
  return { trades, fills, reviews, labels, days, notebook, rules: notebookLists(data.library || []).rules, periods, plans, rows: data.library || [], lib: buildLibrary(data.library || []) };
}

/** where a trade's review stands (core reviewState) */
export const stateOf = (j, t) => reviewState(j.reviews[t.key], j.labels[t.key] || [], j.days[dayOf(t)]);

/**
 * Trades to list: by symbol (the underlying or the contract), by the New York day they opened or closed, open or still to
 * review; newest first, at most limit.
 * @param {ReturnType<typeof journalFrom>} j @param {{ symbol?: string, day?: string, todo?: boolean, open?: boolean, limit?: number, deleted?: boolean }} [f]
 */
export function findTrades(j, f = {}) {
  const sym = (f.symbol || '').trim().toUpperCase();
  return j.trades.filter(t => (f.deleted || !t.deleted)
    && (!sym || t.symbol.toUpperCase().startsWith(sym) || t.label.toUpperCase().includes(sym))
    && (!f.day || dayOf(t) === f.day || (!!t.closedAt && nyParts(t.closedAt).day === f.day))
    && (!f.open || t.status === 'open')
    && (!f.todo || (t.status !== 'history' && !stateOf(j, t).reviewed)))
    .slice(0, f.limit || 20);
}

/** a trade by its key or its handle */
export const tradeBy = (j, ref) => j.trades.find(t => t.key === ref || handleOf(t.key) === ref) || null;

const money = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const price = v => v === null || v === undefined ? '—' : Number(v).toFixed(2);
const et = iso => { const p = nyParts(iso); return `${p.day} ${p.time} ET`; };

/** one line per trade: handle, name, side, size, prices, P&L, when, where its review stands */
export function tradeLine(j, t) {
  const st = stateOf(j, t);
  const review = t.status === 'history' ? 'before your history' : st.reviewed ? 'reviewed' : `missing ${st.missing.join(', ')}`;
  return [handleOf(t.key), t.label, t.bias || t.direction, `${t.entryQty}`, `${price(t.avgEntry)} → ${t.avgExit === null ? 'open' : price(t.avgExit)}`,
    t.status === 'open' ? 'open' : money(t.pnl), et(t.openedAt), review, t.deleted ? 'deleted' : ''].filter(Boolean).join(' · ');
}

/** a label kind's values on a trade, in its side's words */
const labelWords = (j, t, kind) => (j.labels[t.key] || []).filter(l => l.kind === kind).map(l => j.lib.nameOf(kind, l.value, tradeSide(t)));

/** the whole trade: its numbers, fills and review */
export function tradeDetail(j, t) {
  const st = stateOf(j, t), rv = j.reviews[t.key] || {};
  const ids = new Set([...(t.fillIds || []), ...(t.legs || []).flatMap(l => l.fillIds || [])]);
  const fills = j.fills.filter(f => ids.has(f.id)).sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  const marketName = st.market ? j.lib.nameOf('market', st.market) : '—';
  return [
    `${t.label} (${handleOf(t.key)})`,
    `key: ${t.key}`,
    `side: ${t.bias || t.direction}${t.structure ? ` · ${t.structure}` : ''} · status: ${t.status}${t.deleted ? ' (deleted)' : ''}`,
    `qty: ${t.entryQty}${t.openQty ? ` (${t.openQty} open)` : ''} · entry ${price(t.avgEntry)} · exit ${t.avgExit === null ? '—' : price(t.avgExit)} · P&L ${t.status === 'open' ? `${money(t.pnl)} so far` : money(t.pnl)} (before fees)`,
    `stop: ${t.stop === null ? 'none' : `${price(t.stop)} (${t.stopSource})`} · risk ${t.risk === null ? '—' : money(t.risk)} · R ${t.r === null ? '—' : t.r}`,
    `opened ${et(t.openedAt)}${t.closedAt ? ` · closed ${et(t.closedAt)} · held ${holdWords(t.holdMs)}` : ''}`,
    'fills:',
    ...fills.map(f => `  ${et(f.time)} · ${fillWords(f)} ${f.qty} ${f.label} @ ${price(f.price)}`),
    'review:',
    `  market: ${marketName}${st.marketOwn ? ' (this trade only)' : st.market ? ` (the day's, ${dayOf(t)})` : ''}`,
    ...Object.entries(LABEL_FIELDS).map(([field, kind]) => `  ${field}: ${labelWords(j, t, kind).join(', ') || '—'}`),
    `  grade: ${rv.setup_grade || '—'} · plan followed: ${rv.plan_followed || '—'}`,
    `  entry note: ${rv.entry_note || '—'}`,
    `  exit note: ${rv.note || '—'}`,
    `  ${st.reviewed ? 'reviewed' : `missing: ${st.missing.join(', ')}`}`,
    ...(j.plans?.get(t.key) ? ['order plan:', ...planLines(j.plans.get(t.key), t).map(l => `  ${l}`)] : []),
  ].join('\n');
}

/** your choices of each kind (or one), with their keys: what a review's names are matched against */
export function choicesText(j, only = '') {
  const kinds = ['market', 'sector', 'setup', 'level', 'action', 'pattern', 'tactic', 'tag', 'mistake'].filter(k => !only || k === only);
  return kinds.map(k => `${k}: ${j.lib.choices(k).map(i => `${bothWords(i.name, i.short)} [${i.key}]`).join(', ') || '—'}`).join('\n');
}

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * An item of a kind by its key or its name (either side's words, or both), merges followed; hidden ones count, since
 * they're still yours. null when there's none.
 * @param {ReturnType<typeof buildLibrary>} lib @param {string} kind @param {string} ref
 */
export function findItem(lib, kind, ref) {
  const want = norm(ref);
  if (!want) return null;
  const items = lib.byKind[kind] || [];
  const hit = items.find(i => i.key === ref) || items.find(i => [i.name, i.short, bothWords(i.name, i.short)].some(n => n && norm(n) === want))
    || (kind === 'setup' ? items.find(i => ['long', 'short', 'both'].some(s => norm(lib.nameOf('setup', i.key, /** @type {any} */ (s))) === want)) : null);
  return hit ? lib.item(kind, hit.key) : null;
}

/**
 * Names made into keys the way + New does: an item of a kind by its key or name, added to your library when it's new (a
 * setup that isn't one becomes a pattern of that name and the setup made of it). library is the rows to save, said what
 * was added, lib the library with them.
 * @param {{ rows: any[], lib: ReturnType<typeof buildLibrary> }} j @param {{ newId?: () => string }} [opts]
 */
export function librarian(j, opts = {}) {
  const newId = opts.newId || randomUUID;
  const rows = [...j.rows];
  const out = { library: /** @type {any[]} */ ([]), said: /** @type {string[]} */ ([]), lib: j.lib, itemKey };
  const add = row => { rows.push(row); out.library.push(row); out.lib = buildLibrary(rows); };
  /** @param {string} kind @param {string} ref @returns {string} */
  function itemKey(kind, ref) {
    const hit = findItem(out.lib, kind, ref);
    if (hit) return hit.key;
    const name = String(ref).trim().slice(0, 80);
    if (!name) throw new Error(`a ${kind} needs a name`);
    if (kind === 'setup') {
      const pattern = itemKey('pattern', name);
      const parts = { pattern };
      const same = out.lib.choices('setup').find(i => sameParts(out.lib.parts(i.key), parts));
      if (same) return same.key;
      const row = { id: newId(), kind: 'setup', name: setupName(out.lib, parts), settings: parts };
      add(row);
      out.said.push(`New setup in My setups: ${row.name}.`);
      return `mine:${row.id}`;
    }
    const row = { id: newId(), kind, name, settings: {} };
    add(row);
    out.said.push(`New ${kind} in your choices: ${name}.`);
    return `mine:${row.id}`;
  }
  return out;
}

/**
 * A review turned into the changes claude_journal_save takes. Labels: each kind the review names is set to exactly
 * those (a name not among your choices is added to your library; a setup that isn't one becomes a pattern of that name
 * and the setup made of it, as + New setup does). market goes on the day unless the day already has another (then this
 * trade's own), or marketFor: 'trade' says so. Fields left out stay as they are; null clears one.
 * @param {ReturnType<typeof journalFrom>} j @param {any} t a trade @param {Record<string, any>} input
 * @param {{ now?: () => string, newId?: () => string }} [opts]
 * @returns {{ changes: { library: any[], reviews: any[], labels_remove: any[], labels_add: any[], days: any[] }, said: string[], after: ReturnType<typeof reviewState> }}
 */
export function planReview(j, t, input, opts = {}) {
  const now = opts.now || (() => new Date().toISOString()), newId = opts.newId || randomUUID;
  const unknown = Object.keys(input).filter(k => !REVIEW_FIELDS.includes(k));
  if (unknown.length) throw new Error(`a review takes ${REVIEW_FIELDS.join(', ')}; not ${unknown.join(', ')}`);
  if (t.status === 'history') throw new Error("a trade from before your history can't be reviewed");
  const names = librarian(j, { newId }), { library, said, itemKey } = names;

  const labels = (j.labels[t.key] || []).map(l => ({ ...l }));
  const labels_add = [], labels_remove = [];
  for (const [field, kind] of Object.entries(LABEL_FIELDS)) {
    if (!(field in input)) continue;
    const raw = input[field];
    const list = raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw];
    if (SINGLE.has(kind) && list.length > 1) throw new Error(`one ${kind} per trade`);
    const want = [...new Set(list.map(ref => itemKey(kind, ref)))];
    const have = labels.filter(l => l.kind === kind);
    for (const l of have) if (!want.includes(names.lib.resolve(kind, l.value))) { labels_remove.push({ trade_key: t.key, kind, value: l.value }); labels.splice(labels.indexOf(l), 1); }
    for (const k of want) if (!have.some(l => names.lib.resolve(kind, l.value) === k)) { labels_add.push({ trade_key: t.key, kind, value: k }); labels.push({ kind, value: k, set_by: 'you' }); }
  }

  const rv = { ...(j.reviews[t.key] || {}) }, fields = {};
  const field = (col, v) => { if ((rv[col] ?? null) !== v) { fields[col] = v; rv[col] = v; } };
  if ('grade' in input) {
    const g = input.grade === null ? null : String(input.grade).trim().toUpperCase();
    if (g !== null && !GRADES.includes(g)) throw new Error(`grade: ${GRADES.join(', ')}`);
    field('setup_grade', g);
  }
  if ('plan' in input) {
    const p = input.plan === null ? null : norm(input.plan);
    if (p !== null && !PLAN_FOLLOWED.some(([k]) => k === p)) throw new Error('plan: yes, partly or no');
    field('plan_followed', p);
  }
  for (const [name, col] of [['entryNote', 'entry_note'], ['exitNote', 'note']]) {
    if (!(name in input)) continue;
    const text = input[name] === null ? '' : String(input[name]).trim();
    if (text.length > 5000) throw new Error(`${name}: 5000 characters at most`);
    field(col, text || null);
  }
  if ('stop' in input) {
    const s = input.stop === null ? null : Number(input.stop);
    if (s !== null && !(s > 0)) throw new Error('stop: a price above 0, or null');
    field('stop', s);
  }

  const days = [];
  const day = dayOf(t);
  let dayMarket = j.days[day] ?? null;
  if ('market' in input) {
    if (input.marketFor !== undefined && input.marketFor !== 'day' && input.marketFor !== 'trade') throw new Error("marketFor: 'day' or 'trade'");
    const m = input.market === null ? null : itemKey('market', input.market);
    // the trade's own: asked for, or it already has one, or the day already says something else
    const clash = m !== null && !!dayMarket && dayMarket !== m;
    const own = input.marketFor === 'trade' || (input.marketFor !== 'day' && (!!rv.market || clash));
    if (own) {
      field('market', m);
      if (clash && !input.marketFor && !(j.reviews[t.key] || {}).market) said.push(`${day} is already ${names.lib.nameOf('market', dayMarket)}, so ${names.lib.nameOf('market', m)} is this trade's own.`);
    } else {
      if (rv.market) field('market', null); // back to the day's
      if (dayMarket !== m) {
        days.push({ day, market: m });
        dayMarket = m;
        if (m) said.push(`Market ${names.lib.nameOf('market', m)} for every trade on ${day}.`);
      }
    }
  }

  const after = reviewState(rv, labels, dayMarket);
  if (after.reviewed !== !!rv.reviewed_at) field('reviewed_at', after.reviewed ? now() : null);
  const reviews = Object.keys(fields).length ? [{ trade_key: t.key, fields }] : [];
  return { changes: { library, reviews, labels_remove, labels_add, days }, said, after };
}

/** a day's review, in the words a review uses, and the journal_days column each one goes in */
export const DAY_FIELDS = { grade: 'grade', rules: 'rules', weekRules: 'week_rules', wentWell: 'went_well', workOn: 'work_on', note: 'note', focusNext: 'focus_next', focusKept: 'focus_kept' };

const dayRow = (j, day) => j.notebook[day] || cleanDayRow(null);
/** one of a list of rules by its text (any case), its number in the list (1, '2') or its id */
const ruleByRef = (list, ref) => list.find((r, i) => r.id === ref || norm(r.text) === norm(ref) || String(i + 1) === String(ref).trim());
/** the rules a day's week holds you to */
const weekRulesOfDay = (j, day) => weekRulesFor(j.periods, day).rules;

/**
 * A day's review (the notebook's post-market half) turned into the changes claude_journal_save takes: the grade, each
 * rule kept or broke (by its name or key; only the rules that apply to the day, as the page asks), each of this week's
 * rules kept or broke (by its text or number, the ones last week's review set), the notes and tomorrow's focus. Only what changed is sent; null clears a field or a rule's answer. reviewed_at is stamped once the
 * grade, every rule and a guided note are in, as the page does, and cleared if one comes off.
 * @param {ReturnType<typeof journalFrom>} j @param {string} day @param {Record<string, any>} input
 * @param {{ now?: () => string }} [opts]
 */
export function planDay(j, day, input, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  if (!isDay(day)) throw new Error('a day as YYYY-MM-DD');
  const unknown = Object.keys(input).filter(k => !(k in DAY_FIELDS));
  if (unknown.length) throw new Error(`a day's review takes ${Object.keys(DAY_FIELDS).join(', ')}; not ${unknown.join(', ')}`);
  const row = dayRow(j, day), after = { ...row, rules: { ...row.rules }, week_rules: { ...row.week_rules } }, fields = {};
  const field = (col, v) => { if ((after[col] ?? null) !== v) { fields[col] = v; after[col] = v; } };

  if ('grade' in input) {
    const g = input.grade === null ? null : String(input.grade).trim().toUpperCase();
    if (g !== null && !DAY_GRADES.includes(g)) throw new Error(`grade: ${DAY_GRADES.join(', ')}`);
    field('grade', g);
  }
  if ('rules' in input) {
    const raw = input.rules;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("rules: an object, { 'Follow your stops': 'broke' }");
    const applying = rulesForDay(j.rules, day, row);
    const changed = {};
    for (const [ref, answer] of Object.entries(raw)) {
      const rule = applying.find(r => r.key === ref || norm(r.name) === norm(ref));
      if (!rule) throw new Error(`${ref} isn't one of ${day}'s rules: ${applying.map(r => r.name).join(', ') || 'none'}`);
      const a = answer === null ? null : norm(answer);
      if (a !== null && !RULE_ANSWERS.some(([k]) => k === a)) throw new Error(`${rule.name}: kept or broke, or null`);
      if ((after.rules[rule.key] ?? null) === a) continue;
      changed[rule.key] = a;
      if (a) after.rules[rule.key] = a; else delete after.rules[rule.key];
    }
    if (Object.keys(changed).length) fields.rules = changed;
  }
  if ('weekRules' in input) {
    const raw = input.weekRules;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("weekRules: an object, { 'No trades before 9:45': 'kept' }");
    const list = weekRulesOfDay(j, day);
    const changed = {};
    for (const [ref, answer] of Object.entries(raw)) {
      const rule = ruleByRef(list, ref);
      if (!rule) throw new Error(`${ref} isn't one of this week's rules: ${list.map((r, i) => `${i + 1}. ${r.text}`).join(' ') || 'none (last week\'s review set none)'}`);
      const a = answer === null ? null : norm(answer);
      if (a !== null && !RULE_ANSWERS.some(([k]) => k === a)) throw new Error(`${rule.text}: kept or broke, or null`);
      if ((after.week_rules[rule.id] ?? null) === a) continue;
      changed[rule.id] = a;
      if (a) after.week_rules[rule.id] = a; else delete after.week_rules[rule.id];
    }
    if (Object.keys(changed).length) fields.week_rules = changed;
  }
  for (const name of ['wentWell', 'workOn', 'note', 'focusNext']) {
    if (!(name in input)) continue;
    const col = DAY_FIELDS[name], max = DAY_TEXT[col];
    const text = input[name] === null ? '' : String(input[name]).trim();
    if (text.length > max) throw new Error(`${name}: ${max} characters at most`);
    field(col, text || null);
  }
  if ('focusKept' in input) {
    const k = input.focusKept === null ? null : norm(input.focusKept);
    if (k !== null && !FOCUS_KEPT.some(([key]) => key === k)) throw new Error('focusKept: yes, partly or no');
    field('focus_kept', k);
  }

  const st = dayReviewState(after, rulesForDay(j.rules, day, after), weekRulesOfDay(j, day));
  if (st.reviewed !== !!row.reviewed_at) field('reviewed_at', st.reviewed ? now() : null);
  const notebook = Object.keys(fields).length ? [{ day, fields }] : [];
  return { changes: { library: [], reviews: [], labels_remove: [], labels_add: [], days: [], notebook }, after: st };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** the whole day: its market, realized P&L, the trades it touched, and its review in words, with what's missing */
export function dayDetail(j, day) {
  const row = dayRow(j, day), applying = rulesForDay(j.rules, day, row), week = weekRulesOfDay(j, day), st = dayReviewState(row, applying, week);
  const pnl = dailyPnl(j.trades).get(day), trades = dayTrades(j.trades, day), last = lastFocus(j.notebook, day);
  const or = v => v || '—';
  return [
    `${day} (${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]})`,
    `market: ${row.market ? j.lib.nameOf('market', row.market) : '—'}`,
    `P&L: ${pnl ? `${money(pnl.pnl)} · ${pnl.trades} trade${pnl.trades === 1 ? '' : 's'} with an exit` : 'no exits'}`,
    'trades:',
    ...(trades.length ? trades.map(t => `  ${tradeLine(j, t)}`) : ['  —']),
    'review:',
    `  grade: ${or(row.grade)}`,
    '  rules:',
    ...(applying.length ? applying.map(r => `    ${r.name}: ${or(row.rules[r.key])}`) : ['    —']),
    ...(week.length ? ["  this week's rules (from last week's review):", ...week.map((r, i) => `    ${i + 1}. ${r.text}: ${or(row.week_rules[r.id])}`)] : []),
    ...(last ? [`  last focus (${last.day}): ${last.text} · kept: ${or(row.focus_kept)}`] : []),
    `  went well: ${or(row.went_well)}`,
    `  work on: ${or(row.work_on)}`,
    `  more notes: ${or(row.note)}`,
    `  tomorrow's focus: ${or(row.focus_next)}`,
    `  ${st.reviewed ? 'reviewed' : `missing: ${reviewMissingWords(st)}`}`,
  ].join('\n');
}

/** a week's or month's review, in the words a review uses: parts by their name or key, each { grade, note } */
export const PERIOD_FIELDS = { parts: '', wentWell: 'went_well', workOn: 'work_on', note: 'note', rulesNext: 'rules_next', rulesKept: 'rules_kept', rulesNote: 'rules_note' };

/** a period's key: a week by its Monday (from any of its days), a month as YYYY-MM. @param {string} unit @param {string} ref */
function periodOf(unit, ref) {
  if (unit === 'week') { if (!isDay(ref)) throw new Error('a week by any of its days, YYYY-MM-DD'); return periodKey(ref, 'week'); }
  if (unit === 'month') { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ref))) throw new Error('a month as YYYY-MM'); return ref; }
  throw new Error('week or month');
}
const periodRow = (j, unit, key) => j.periods[`${unit}|${key}`] || cleanPeriodRow({ unit, period_key: key });

/**
 * A week's or month's review turned into the changes claude_journal_save takes, as the review under the calendar would
 * make them: each part's grade (A+ to F) and note, the overall notes, the rules for the next one (the whole list; a rule
 * already on it keeps its id), Kept it? on each of the rules the period before set (by text or number) and how they went.
 * Only what changed is sent; null clears one. reviewed_at is stamped once every part has a grade, the rules are set and
 * the last one's rules are answered, as the page does, and cleared if one comes off.
 * @param {ReturnType<typeof journalFrom>} j @param {string} unit week | month @param {string} ref any day of the week, or YYYY-MM
 * @param {Record<string, any>} input @param {{ now?: () => string }} [opts]
 */
export function planPeriod(j, unit, ref, input, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const key = periodOf(unit, ref);
  const unknown = Object.keys(input).filter(k => !(k in PERIOD_FIELDS));
  if (unknown.length) throw new Error(`a ${unit}'s review takes ${Object.keys(PERIOD_FIELDS).join(', ')}; not ${unknown.join(', ')}`);
  const row = periodRow(j, unit, key), after = { ...row, rules_kept: { ...row.rules_kept } }, fields = {};
  const prev = j.periods[`${unit}|${previousPeriod(unit, key)}`] || null;
  const field = (col, v) => { if ((after[col] ?? null) !== v) { fields[col] = v; after[col] = v; } };
  const text = (name, v, max) => {
    const s = v === null ? '' : String(v).trim();
    if (s.length > max) throw new Error(`${name}: ${max} characters at most`);
    return s || null;
  };

  if ('parts' in input) {
    const raw = input.parts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("parts: an object, { 'Risk management': { grade: 'D', note: '...' } }");
    for (const [ref, v] of Object.entries(raw)) {
      const part = PERIOD_CATEGORIES.find(([k, name]) => k === ref || norm(name) === norm(ref));
      if (!part) throw new Error(`${ref} isn't a part: ${PERIOD_CATEGORIES.map(([, name]) => name).join(', ')}`);
      const [k, name] = part;
      const extra = Object.keys(v || {}).filter(x => x !== 'grade' && x !== 'note');
      if (!v || typeof v !== 'object' || extra.length) throw new Error(`a part takes grade, note; not ${extra.join(', ') || typeof v}`);
      if ('grade' in v) {
        const g = v.grade === null ? null : String(v.grade).trim().toUpperCase();
        if (g !== null && !PERIOD_GRADES.includes(g)) throw new Error(`grade: ${PERIOD_GRADES.join(', ')}`);
        field(gradeColumn(k), g);
      }
      if ('note' in v) field(noteColumn(k), text(`${name} note`, v.note, MAX_PERIOD_NOTE));
    }
  }
  for (const name of ['wentWell', 'workOn', 'note']) if (name in input) field(PERIOD_FIELDS[name], text(name, input[name], MAX_PERIOD_NOTE));
  if ('rulesNext' in input) {
    const raw = input.rulesNext === null ? [] : input.rulesNext;
    if (!Array.isArray(raw)) throw new Error("rulesNext: a list, ['No trades before 9:45', 'Size down after a loss']");
    const texts = raw.map((v, i) => text(`rulesNext ${i + 1}`, v, MAX_RULE)).filter(Boolean);
    if (texts.length > MAX_PERIOD_RULES) throw new Error(`rulesNext: ${MAX_PERIOD_RULES} rules at most`);
    const had = periodRules(row).filter(r => r.id !== LEGACY_RULE_ID);
    const list = texts.map(t => ({ id: had.find(r => norm(r.text) === norm(t))?.id || randomUUID(), text: t }));
    if (JSON.stringify(list) !== JSON.stringify(periodRules(row))) { fields.rules_next = after.rules_next = list; field('rule_next', list[0]?.text || null); }
  }
  if ('rulesKept' in input) {
    const raw = input.rulesKept;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error("rulesKept: an object, { 'No trades before 9:45': 'partly' }");
    const list = periodRules(prev);
    const changed = {};
    for (const [ref, answer] of Object.entries(raw)) {
      const rule = ruleByRef(list, ref);
      if (!rule) throw new Error(`${ref} isn't one of the rules last ${unit} set: ${list.map((r, i) => `${i + 1}. ${r.text}`).join(' ') || 'none'}`);
      const k = answer === null ? null : norm(answer);
      if (k !== null && !RULE_KEPT.some(([v]) => v === k)) throw new Error(`${rule.text}: yes, partly or no, or null`);
      if (ruleKeptOf(after, rule.id) === k) continue;
      if (rule.id === LEGACY_RULE_ID) { field('rule_kept', k); continue; }
      changed[rule.id] = k;
      if (k) after.rules_kept[rule.id] = k; else delete after.rules_kept[rule.id];
    }
    if (Object.keys(changed).length) fields.rules_kept = changed;
  }
  if ('rulesNote' in input) field('rules_note', text('rulesNote', input.rulesNote, MAX_PERIOD_NOTE));

  const st = periodReviewState(after, prev);
  if (st.reviewed !== !!row.reviewed_at) field('reviewed_at', st.reviewed ? now() : null);
  const periods = Object.keys(fields).length ? [{ unit, key, fields }] : [];
  return { key, changes: { library: [], reviews: [], labels_remove: [], labels_add: [], days: [], notebook: [], periods }, after: st };
}

/** the whole week or month: its P&L (the exits taken in it), its trades, the rules the last one set (how the days checked each, Kept it?, how they went), each part's grade and note and the rules for the next one, with what's missing */
export function periodDetail(j, unit, key) {
  const prev = j.periods[`${unit}|${previousPeriod(unit, key)}`], row = periodRow(j, unit, key), st = periodReviewState(row, prev);
  const asked = periodRules(prev), next = periodRules(row), today = nyParts(new Date().toISOString()).day;
  const tally = r => {
    if (unit !== 'week' || r.id === LEGACY_RULE_ID) return '';
    const t = weekRuleTally(j.notebook, key, r.id, today);
    return ` · days: kept ${t.kept}, broke ${t.broke}${t.open ? `, ${t.open} not checked` : ''}`;
  };
  const rows = periodTradeRows(j.trades, unit, key), closed = rows.filter(r => r.pnl !== null);
  const pnl = Math.round(closed.reduce((n, r) => n + r.pnl, 0) * 100) / 100;
  const title = unit === 'week' ? `Week of ${key}` : new Date(`${key}-01T12:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const or = v => v || '—';
  return [
    title,
    `P&L: ${closed.length ? `${money(pnl)} · ${closed.length} trade${closed.length === 1 ? '' : 's'} with an exit` : 'no exits'}`,
    'trades:',
    ...(rows.length ? rows.map(r => `  ${tradeLine(j, r.trade)}${r.partial ? ` · ${money(r.pnl)} this ${unit}` : ''}`) : ['  —']),
    'review:',
    ...(asked.length ? [`  this ${unit}'s rules (set last ${unit}):`, ...asked.map((r, i) => `    ${i + 1}. ${r.text}${tally(r)} · kept: ${or(ruleKeptOf(row, r.id))}`), `  how they went: ${or(row.rules_note)}`] : []),
    '  parts:',
    ...PERIOD_CATEGORIES.map(([k, name]) => `    ${name}: ${or(row[gradeColumn(k)])}${row[noteColumn(k)] ? ` · ${row[noteColumn(k)]}` : ''}`),
    `  went well: ${or(row.went_well)}`,
    `  work on: ${or(row.work_on)}`,
    `  more notes: ${or(row.note)}`,
    `  rules for next ${unit}:${next.length ? '' : ' —'}`,
    ...next.map((r, i) => `    ${i + 1}. ${r.text}`),
    `  ${st.reviewed ? 'reviewed' : `missing: ${periodMissingWords(st, unit)}`}`,
  ].join('\n');
}

/** whether a plan changes anything */
export const changesAnything = c => Object.values(c).some(list => list.length);

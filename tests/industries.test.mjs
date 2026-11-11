// Run with: node --test
// Industry groups and sectors (core/industries.js, services/industries.js, ui/journal-industry.js): every trade's stock
// looked up in the Market tab's universe, never typed. Every group has its sector; an option, a spread and a leveraged fund
// read on their underlying; the sector SPDRs are their sector. On the trade page, in More filters and in Stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { app } from './helpers/app.mjs';
import { fakeRecords } from './helpers/supabase.mjs';
import { industryMap, industryOf, industryWords, SECTOR_FUNDS, SECTOR_OF, SECTORS, stockOf } from '../src/core/industries.js';
import { applyFilters, filterChoices, filterField, NONE } from '../src/core/journal-filters.js';
import { MarketData } from '../src/core/market-data.js';
import { UNIVERSE_FILE } from '../src/services/industries.js';

const CSV = readFileSync(UNIVERSE_FILE, 'utf8');
const MAP = industryMap(MarketData.parseCsv(CSV));

test('core: every industry group in the universe has one of the eleven sectors, and none is left over', () => {
  const groups = new Set(MAP.values());
  assert.deepEqual([...groups].filter(g => !SECTOR_OF[g]), [], 'a group the map is missing');
  assert.deepEqual(Object.keys(SECTOR_OF).filter(g => !groups.has(g)), [], 'a group the universe no longer has');
  assert.deepEqual([...new Set(Object.values(SECTOR_OF))].sort(), [...SECTORS].sort());
  assert.deepEqual([...new Set(Object.values(SECTOR_FUNDS))].sort(), [...SECTORS].sort(), 'a SPDR per sector');
});

test('core: a trade reads on its stock: a stock, an option, a spread and a fund on its underlying; a SPDR its sector; no future', () => {
  const nvda = { ticker: 'NVDA', industry: 'Semiconductors', sector: 'Technology' };
  assert.deepEqual(industryOf({ symbol: 'NVDA', assetType: 'EQUITY' }, MAP), nvda);
  assert.deepEqual(industryOf({ symbol: 'NVDA  261218C00245000', assetType: 'OPTION' }, MAP), nvda);
  assert.deepEqual(industryOf({ symbol: 'NVDA', assetType: 'SPREAD', legs: [] }, MAP), nvda);
  assert.deepEqual(industryOf({ symbol: 'NVDL', assetType: 'EQUITY', setupOn: 'NVDA' }, MAP), nvda, 'a leveraged fund reads on its underlying');
  assert.deepEqual(industryOf({ symbol: 'XLE', assetType: 'EQUITY' }, MAP), { ticker: 'XLE', industry: '', sector: 'Energy' });
  assert.deepEqual(industryOf({ symbol: 'ERX', assetType: 'EQUITY', setupOn: 'XLE' }, MAP)?.sector, 'Energy', 'a fund on a SPDR');
  assert.equal(industryOf({ symbol: 'SPY', assetType: 'EQUITY' }, MAP), null, 'an ETF the universe has no group for');
  assert.equal(industryOf({ symbol: '/MESZ26', assetType: 'FUTURE' }, MAP), null);
  assert.equal(stockOf({ symbol: '/MESZ26', assetType: 'FUTURE' }), '');
  assert.equal(industryWords(industryOf({ symbol: 'AA', assetType: 'EQUITY' }, MAP)), 'Aluminum · Basic Materials');
  assert.equal(industryWords(industryOf({ symbol: 'XLE', assetType: 'EQUITY' }, MAP)), 'Energy');
  assert.equal(industryWords(null), '');
});

test('core: Sector and Industry group filter on the stock; a ticker the universe lacks is Not listed', () => {
  const trades = [
    { key: 'n', symbol: 'NVDA', assetType: 'EQUITY', status: 'closed' },
    { key: 'o', symbol: 'AMD   261218C00150000', assetType: 'OPTION', status: 'closed' },
    { key: 'x', symbol: 'XOM', assetType: 'EQUITY', status: 'closed' },
    { key: 's', symbol: 'SPY', assetType: 'EQUITY', status: 'closed' },
  ];
  const ctx = { grade: () => '', plan: () => '', market: () => '', labels: () => [], nameOf: (k, v) => v, industryOf: t => industryOf(t, MAP) };
  const keys = filters => applyFilters(trades, filters, ctx).map(t => t.key).join(',');
  assert.equal(filterField('stockSector').label, 'Sector');
  assert.equal(filterField('sector').label, 'Sector strength', 'the review label is how the sector did');
  assert.equal(keys([{ field: 'stockSector', values: ['Technology'] }]), 'n,o');
  assert.equal(keys([{ field: 'stockSector', values: [NONE] }]), 's');
  assert.equal(keys([{ field: 'industry', values: ['Oil & Gas Integrated'] }]), 'x');
  assert.deepEqual(filterChoices(trades, [], 'stockSector', ctx).map(c => `${c.name} ${c.count}`), ['Technology 2', 'Energy 1', 'Not listed 1'], 'in the sectors\' order');
  assert.deepEqual(filterChoices(trades, [], 'industry', ctx).map(c => `${c.name} ${c.count}`), ['Semiconductors 2', 'Oil & Gas Integrated 1', 'Not listed 1'], 'most used first, by its own words');
});

const SESSION = { user: { id: 'user-1', email: 'me@example.com' } };
let n = 0;
const order = (instruction, time, qty, price, symbol) => { const id = ++n; return { kind: 'order', record_id: String(id), account: '6789', entered_at: time, data: {
  orderId: id, enteredTime: time, status: 'FILLED',
  orderLegCollection: [{ legId: 1, instruction, quantity: qty, instrument: { symbol, assetType: 'EQUITY' } }],
  orderActivityCollection: [{ activityType: 'EXECUTION', activityId: 9000 + id, executionLegs: [{ legId: 1, quantity: qty, price, time }] }] } }; };
const ROWS = [
  order('BUY', '2026-10-01T14:30:00Z', 100, 100, 'AAPL'), order('SELL', '2026-10-01T18:00:00Z', 100, 102, 'AAPL'),
  order('BUY', '2026-10-02T14:00:00Z', 50, 180, 'NVDA'), order('SELL', '2026-10-02T17:00:00Z', 50, 183, 'NVDA'),
  order('BUY', '2026-10-02T15:00:00Z', 20, 50, 'NVDL'), order('SELL', '2026-10-02T18:00:00Z', 20, 49, 'NVDL'),
  order('BUY', '2026-10-03T15:00:00Z', 10, 500, 'SPY'), order('SELL', '2026-10-03T18:00:00Z', 10, 501, 'SPY'),
];
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };

async function journal({ fail = false } = {}) {
  const asked = [];
  const fetch = async url => {
    asked.push(String(url));
    if (String(url) !== UNIVERSE_FILE || fail) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => CSV };
  };
  const a = await app({ width: 1500, fetch, supabase: fakeRecords(ROWS), session: SESSION });
  a.run("setView('journal')");
  await a.run('loadJournal()');
  await settle();
  const key = sym => a.run(`journalTradeList().find(t => t.symbol === '${sym}').key`);
  return { ...a, asked, key, list: () => a.elements.get('journalSection').innerHTML };
}

test('the trade page names the stock\'s industry group and sector, beside the sector strength too; a fund names its underlying', async () => {
  const a = await journal();
  a.run(`openJournalTrade('${a.key('NVDA')}')`);
  await settle();
  const head = a.elements.get('jtHead').innerHTML, body = a.elements.get('jtBody').innerHTML;
  assert.match(head, /<span class="jt-industry"[^>]*>Semiconductors · Technology<\/span>/);
  assert.match(body, /Sector <span class="jr-sub">Semiconductors · Technology<\/span>/, 'beside the strength chips');
  a.run(`openJournalTrade('${a.key('NVDL')}')`);
  await settle();
  assert.match(a.elements.get('jtHead').innerHTML, /class="jt-industry"[^>]*>NVDA: Semiconductors · Technology</);
  a.run(`openJournalTrade('${a.key('SPY')}')`);
  await settle();
  assert.doesNotMatch(a.elements.get('jtHead').innerHTML, /jt-industry/, 'SPY has no group');
  assert.equal(a.asked.filter(u => u === UNIVERSE_FILE).length, 1, 'read once');
});

test('More filters: Sector and Industry group once the universe is read; Stats break results down by both', async () => {
  const a = await journal();
  assert.match(a.list(), /<option value="stockSector">Sector<\/option><option value="industry">Industry group<\/option>/);
  a.run("addJournalFilter('industry')");
  const block = a.list().split('class="jf-filter')[1].split('class="jf-foot"')[0];
  assert.match(block, /data-arg2="Semiconductors">Semiconductors <b>2<\/b>/, 'NVDA and NVDL');
  assert.match(block, /data-arg2="Consumer Electronics">Consumer Electronics <b>1<\/b>/);
  assert.match(block, /data-arg2="none">Not listed <b>1<\/b>/);
  a.run("toggleJournalFilterValue('industry', 'Semiconductors')");
  assert.deepEqual(a.run('benchKeys()').map(k => k.split('|')[1]).sort(), ['NVDA', 'NVDL']);
  a.run("clearJournalFilters(); setJournalTab('stats')");
  const stats = a.list();
  assert.match(stats, /By sector<\/div>[^]*?1 closed trade on a ticker the universe doesn't list[^]*?<b>Technology<\/b>[^]*?<td>3<\/td>/, 'SPY left out');
  assert.match(stats, /By industry group<\/div>[^]*?<b>Semiconductors<\/b>[^]*?<td>2<\/td>/);
});

test('without the universe: no industry filters, Stats says why, and the trade page carries on', async () => {
  const a = await journal({ fail: true });
  assert.doesNotMatch(a.list(), /value="stockSector"|value="industry"/);
  a.run("setJournalTab('stats')");
  assert.match(a.list(), /Industry groups couldn't load: Could not load the industry groups\./);
  a.run(`openJournalTrade('${a.key('NVDA')}')`);
  await settle();
  assert.doesNotMatch(a.elements.get('jtHead').innerHTML, /jt-industry/);
});

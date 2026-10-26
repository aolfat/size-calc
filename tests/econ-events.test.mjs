// Run with: node --test
// The economic calendar (core/econ-events.js): the releases on their New York days, in time order, weekdays only, the
// 2025 shutdown's moves and gaps as they happened, and the times' words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';

const json = (run, code) => JSON.parse(run(`JSON.stringify(${code})`));

test('a day\'s releases in time order: a rate decision brings its press conference; the minutes say their meeting', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, "econEvents('2026-10-28').map(e => [e.time, e.name, e.impact])"), [['14:00', 'Fed rate decision', 'high'], ['14:30', 'Fed press conference', 'high']]);
  assert.deepEqual(json(run, "econEvents('2026-09-16').map(e => e.note)"), ['with projections', ''], 'the meetings with projections say so');
  assert.deepEqual(json(run, "econEvents('2026-10-14').map(e => [e.time, e.short, e.note])"), [['08:30', 'CPI', 'Sep'], ['14:00', 'Beige Book', '']]);
  assert.deepEqual(json(run, "econEvents('2026-10-29').map(e => [e.short, e.note])"), [['PCE', 'Sep'], ['GDP', 'Q3']]);
  assert.deepEqual(json(run, "econEvents('2026-11-18').map(e => [e.name, e.note, e.impact])"), [['FOMC minutes', 'Oct 28 meeting', 'medium']]);
  assert.deepEqual(json(run, "econEvents('2026-10-26')"), []);
  assert.equal(run("econImpact(econEvents('2026-10-14'))"), 'high', 'the loudest one');
  assert.equal(run("econImpact(econEvents('2026-11-18'))"), 'medium');
  assert.equal(run("econImpact([])"), '');
});

test('the shutdown\'s dates as they came out: moved releases, cancelled ones gone, two months together', async () => {
  const { run } = await app();
  assert.deepEqual(json(run, "econEvents('2025-10-24').map(e => [e.short, e.note])"), [['CPI', 'Sep']], 'September CPI came late');
  assert.deepEqual(json(run, "econEvents('2025-11-20').map(e => e.short)"), ['Jobs']);
  assert.deepEqual(json(run, "econEvents('2025-10-30')"), [], 'Q3 advance GDP was cancelled');
  assert.deepEqual(json(run, "econEvents('2026-01-22').map(e => [e.time, e.note])"), [['10:00', 'Oct and Nov']]);
});

test('every release is on a weekday inside the schedule; times read like a clock', async () => {
  const { run } = await app();
  const days = json(run, `(() => { const out = []; for (let t = Date.parse(ECON_FROM + 'T12:00:00Z'); t <= Date.parse(ECON_TO + 'T12:00:00Z'); t += 864e5) { const d = new Date(t).toISOString().slice(0, 10); if (econEvents(d).length) out.push([d, new Date(t).getUTCDay()]); } return out; })()`);
  assert.ok(days.length > 150, `${days.length} days`);
  assert.deepEqual(days.filter(([, w]) => w === 0 || w === 6), [], 'no weekends');
  assert.equal(run("econCovers('2027-12-31')"), true);
  assert.equal(run("econCovers('2028-01-03')"), false);
  assert.deepEqual(json(run, "['08:30', '10:00', '12:15', '14:00'].map(econTime)"), ['8:30 am', '10:00 am', '12:15 pm', '2:00 pm']);
});

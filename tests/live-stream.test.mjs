// Run with: node --test
// Live (docs/calculator.md): the price streams from Tradier's socket and folds into the quote; phones and tablets go live
// on every Load and stay on until you tap Live; the quote polls only while the stream is down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './helpers/app.mjs';
import { applyStreamEvent, parseStreamData, subscribeMessage } from '../src/core/stream.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
const QUOTE = sym => ({ symbol: sym, type: 'stock', last: 100, bid: 99.98, ask: 100.02, low: 98, high: 102, open: 99, prevclose: 99, change: 1, change_percentage: 1.01, volume: 1000 });
// 11:00 New York on a weekday: regular hours
const RTH = Date.parse('2026-10-27T15:00:00Z');

test('stream frames: one event per line, junk skipped; events fold into the REST quote', () => {
  const evs = parseStreamData('{"type":"trade","symbol":"SPY","price":"101.5","cvol":"5000","date":"' + RTH + '"}\nnot json\n{"type":"quote","symbol":"SPY","bid":101.4,"ask":101.6}\n{"symbol":"SPY"}\n');
  assert.deepEqual(evs.map(e => e.type), ['trade', 'quote']);
  let q = QUOTE('SPY');
  q = applyStreamEvent(q, evs[0]);
  assert.deepEqual([q.last, q.volume, q.trade_date, q.change, q.change_percentage], [101.5, 5000, RTH, 2.5, 2.53]);
  q = applyStreamEvent(q, evs[1]);
  assert.deepEqual([q.bid, q.ask], [101.4, 101.6]);
  const high = applyStreamEvent(q, { type: 'trade', symbol: 'SPY', price: '103', date: String(RTH) });
  assert.equal(high.high, 103, 'a regular-hours trade widens the day');
  const after = applyStreamEvent(q, { type: 'trade', symbol: 'SPY', price: '104', date: String(Date.parse('2026-10-27T21:00:00Z')) });
  assert.deepEqual([after.last, after.high], [104, 102], 'an after-hours print moves last, not the day\'s range');
  const sum = applyStreamEvent(q, { type: 'summary', symbol: 'SPY', open: '99.5', high: '105', low: '97', prevClose: '100' });
  assert.deepEqual([sum.open, sum.high, sum.low, sum.prevclose, sum.change], [99.5, 105, 97, 100, 1.5]);
  assert.equal(applyStreamEvent(q, { type: 'trade', symbol: 'QQQ', price: '1' }), q, 'another symbol changes nothing');
  assert.equal(applyStreamEvent(q, { type: 'trade', symbol: 'SPY', price: '0' }), q, 'a zero price changes nothing');
  assert.deepEqual(JSON.parse(subscribeMessage(['SPY'], 'sid')), { symbols: ['SPY'], sessionid: 'sid', linebreak: true, filter: ['trade', 'quote', 'summary'], validOnly: true });
});

// a fake socket per open; the network answers quotes, the stream session, and nothing else of note
async function setup({ width = 390, storage, sandbox = false, session = true } = {}) {
  const urls = [], sockets = [];
  const fetch = async (url, init = {}) => {
    urls.push((init.method || 'GET') + ' ' + url);
    if (url.includes('/markets/events/session')) return session ? json({ stream: { url: 'https://stream.tradier.com/v1/markets/events', sessionid: 'sid-' + urls.length } }) : json({}, 401);
    const sym = url.match(/symbols=([^&]+)/)?.[1];
    if (sym) return json({ quotes: { quote: QUOTE(decodeURIComponent(sym)) } });
    return json({});
  };
  const h = await app({ width, fetch, storage, clock: true, now: RTH, timers: 'fake' });
  globalThis.setInterval = () => 1; // a running interval reads as on
  h.api.effects.openSocket = url => { const ws = { url, readyState: 0, sent: [], send(m) { this.sent.push(m); }, close() { this.closed = true; } }; sockets.push(ws); return ws; };
  h.elements.get('apiKey').value = 'test-key';
  if (sandbox) h.elements.get('apiEnv').value = 'sandbox';
  const load = async sym => { h.elements.get('ticker').value = sym; await h.run('fetchQuote()'); await settle(); };
  const open = ws => { ws.readyState = 1; ws.onopen(); };
  return { ...h, urls, sockets, load, open, polls: () => urls.filter(u => u.startsWith('GET') && u.includes('/markets/quotes?symbols=')).length };
}

test('on a phone a Load goes live with no countdown; the price streams in and the quote stops polling', async () => {
  const s = await setup();
  await s.load('AAPL');
  assert.equal(s.state.liveAlways, true);
  assert.match(s.elements.get('liveBtn').innerHTML, /Live · tap: stop/);
  assert.ok(s.urls.includes('POST https://api.tradier.com/v1/markets/events/session'));
  assert.equal(s.sockets.length, 1);
  assert.equal(s.sockets[0].url, 'wss://ws.tradier.com/v1/markets/events');
  s.open(s.sockets[0]);
  assert.deepEqual(JSON.parse(s.sockets[0].sent[0]).symbols, ['AAPL']);
  s.sockets[0].onmessage({ data: `{"type":"trade","symbol":"AAPL","price":"101.25","date":"${RTH}"}` });
  assert.equal(s.state.quoteData.last, 101.25);
  assert.equal(s.elements.get('qPrice').textContent, '$101.25', 'drawn at once');
  s.sockets[0].onmessage({ data: `{"type":"trade","symbol":"AAPL","price":"101.30","date":"${RTH}"}` });
  assert.equal(s.elements.get('qPrice').textContent, '$101.25', 'the next draw waits out the throttle');
  await s.advance(300);
  assert.equal(s.elements.get('qPrice').textContent, '$101.30');
  const before = s.polls();
  for (let i = 0; i < 6; i++) await s.run('alwaysTick()');
  await settle();
  assert.equal(s.polls(), before, 'no quote polling while the stream flows');
  assert.match(s.elements.get('lastUpdated').textContent, /streaming/);
});

test('a tap stops it for that ticker; a Load of another starts it again', async () => {
  const s = await setup();
  await s.load('AAPL');
  s.run('toggleLive()');
  assert.equal(s.state.liveAlways, false);
  assert.equal(s.sockets[0].closed, true, 'the socket closes');
  assert.equal(s.elements.get('liveBtn').innerHTML, '⚡ Live');
  await s.load('AAPL');
  assert.equal(s.state.liveAlways, false, 'stays off for AAPL');
  await s.load('TSLA');
  assert.equal(s.state.liveAlways, true, 'on for TSLA');
});

test('a new Load while live tells the open socket the new symbol, and old symbol events are ignored', async () => {
  const s = await setup();
  await s.load('AAPL');
  s.open(s.sockets[0]);
  await s.load('TSLA');
  await s.run('alwaysTick()');
  assert.equal(s.sockets.length, 1, 'same socket');
  assert.deepEqual(JSON.parse(s.sockets[0].sent.at(-1)).symbols, ['TSLA']);
  s.sockets[0].onmessage({ data: '{"type":"trade","symbol":"AAPL","price":"50"}' });
  assert.equal(s.state.quoteData.last, 100);
});

test('when the socket drops the quote polls every 2s, and the stream is tried again later', async () => {
  const s = await setup();
  await s.load('AAPL');
  s.open(s.sockets[0]);
  s.sockets[0].onclose();
  assert.equal(s.state.liveSocket, null);
  const before = s.polls();
  for (let i = 0; i < 4; i++) { await s.run('alwaysTick()'); await settle(); }
  assert.equal(s.polls() - before, 2, 'every other second');
  assert.equal(s.sockets.length, 1, 'no new socket inside the wait');
  await s.advance(16000);
  await s.run('alwaysTick()');
  await settle();
  assert.equal(s.sockets.length, 2, 'tried again');
});

test('backgrounding closes the stream and coming back opens it again', async () => {
  const s = await setup();
  await s.load('AAPL');
  s.open(s.sockets[0]);
  s.run('pauseLive()');
  assert.equal(s.sockets[0].closed, true);
  assert.match(s.elements.get('liveBtn').innerHTML, /paused/);
  s.run('resumeLive()');
  await settle();
  assert.equal(s.sockets.length, 2);
  assert.match(s.elements.get('liveBtn').innerHTML, /tap: stop/);
});

test('desktop starts with a tap; the setting turns the phone default off; a sandbox key polls with no stream', async () => {
  const desk = await setup({ width: 1280 });
  await desk.load('AAPL');
  assert.equal(desk.state.liveAlways, false);
  assert.ok(!desk.state.liveInterval, 'not live');

  const off = await setup({ storage: new Map([['live_mobile', '0']]) });
  await off.load('AAPL');
  assert.ok(!off.state.liveInterval, 'the setting leaves it to a tap');
  off.run("setLiveDefault('on')");
  assert.equal(off.storage.get('live_mobile'), '1');
  assert.equal(off.elements.get('liveDefaultOn').classList.contains('active'), true);

  const sand = await setup({ sandbox: true });
  await sand.load('AAPL');
  assert.equal(sand.state.liveAlways, true);
  assert.ok(!sand.urls.some(u => u.includes('/events/session')), 'no stream session');
  assert.equal(sand.sockets.length, 0);
});

test('a refused stream session falls back to polling', async () => {
  const s = await setup({ session: false });
  await s.load('AAPL');
  assert.equal(s.sockets.length, 0);
  assert.equal(s.state.liveSocket, null);
  const before = s.polls();
  await s.run('alwaysTick(); alwaysTick()');
  await settle();
  assert.equal(s.polls() - before, 1);
});

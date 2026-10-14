// Journal spike: Settings → Schwab trading → Download Schwab history. One file with your positions, the last 59 days
// of orders, and TRADE transactions over several ranges (to learn how far back Schwab goes), account numbers masked.
// Temporary: it exists so the journal's importer is built against real data, and goes once the importer is in.
import { scrubAccounts, spanOf, maskAccount } from '../core/schwab-history.js';
import { schwabAccount, schwabConnected, schwabPositions, schwabRecentOrders, schwabTransactions } from '../services/schwab.js';
import { state } from '../state.js';
import { effects } from './effects.js';
import { showError, showToast } from './feedback.js';

const DAY = 86400000;
export const HISTORY_RANGES = [30, 60, 90, 180, 365]; // days of transactions to try

/** run one read, keeping its answer or its error, never stopping the rest */
async function attempt(fn) {
  try { return { ok: true, data: await fn() }; } catch(e) { return { ok: false, status: e?.status || 0, error: String(e?.message || e) }; }
}

/** read everything and build the export, account numbers masked. Pure apart from the Schwab reads. */
export async function buildSchwabHistory(now = Date.now()) {
  const acct = schwabAccount();
  const reads = {};
  reads.positions = await attempt(() => schwabPositions());
  reads.orders_59d = await attempt(() => schwabRecentOrders(now));
  for (const days of HISTORY_RANGES) reads[`transactions_${days}d`] = await attempt(() => schwabTransactions(now - days * DAY, now));
  const summary = {};
  for (const [name, r] of Object.entries(reads)) {
    if (!r.ok) { summary[name] = `failed (${r.status || 'no answer'}): ${r.error}`; continue; }
    if (!Array.isArray(r.data)) { summary[name] = 'ok'; continue; }
    const s = spanOf(r.data, name.startsWith('orders') ? ['enteredTime', 'closeTime'] : ['tradeDate', 'time', 'settlementDate']);
    summary[name] = `${s.count} rows${s.first ? `, ${s.first.slice(0, 10)} to ${s.last.slice(0, 10)}` : ''}`;
  }
  return scrubAccounts({
    app: 'size-calc', kind: 'schwab-history', exported: new Date(now).toISOString(),
    account: acct ? maskAccount('0000' + acct.last4) : '', summary, reads,
  });
}

export async function downloadSchwabHistory() {
  if (!schwabConnected()) { showError('Log in to Schwab first.'); return; }
  if (state.historyBusy) return;
  state.historyBusy = true;
  const btn = document.getElementById('schwabHistoryBtn');
  btn.disabled = true;
  btn.textContent = 'Reading Schwab…';
  try {
    const out = await buildSchwabHistory();
    effects.downloadText(`schwab-history-${out.exported.slice(0, 10)}.json`, JSON.stringify(out, null, 2));
    showToast('Downloaded. It has your trades but not your account number.');
  } catch(e) {
    showError("Couldn't build the Schwab history file. " + (e?.message || ''));
  } finally {
    state.historyBusy = false;
    btn.disabled = false;
    btn.textContent = 'Download Schwab history';
  }
}

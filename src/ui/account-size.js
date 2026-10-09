// Account size from Schwab: the selected account's value (liquidation value) goes into the account size once per New York day,
// on the first Schwab read of the day (boot, focus, a Positions refresh, a login or account switch). A typed number holds until the next day.
import { state } from '../state.js';
import { fmt$ } from '../core/format.js';
import { store } from '../lib/store.js';
import { schwabAccount, schwabBalances, schwabConnected } from '../services/schwab.js';
import { showToast } from './feedback.js';
import { recalcAll, riskDollars, riskFollowsDollars, syncFromDollar } from './risk.js';

const nyDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const mask = last4 => '••' + last4;
const dollars = v => '$' + v.toLocaleString('en-US');

/** the last update: { day, hash, value, at }, device-local like the login */
function lastUpdate() { try { return JSON.parse(store.get('schwab_acct_size') || 'null'); } catch(e) { return null; } }

export function accountSizeFromSchwab() { return store.get('schwab_acct_source') !== 'manual'; }

/** whether this account's value still has to go in today */
function due(now = Date.now()) {
  if (!accountSizeFromSchwab() || !schwabConnected()) return false;
  const last = lastUpdate();
  return !last || last.hash !== schwabAccount().hash || last.day !== nyDay(now);
}

/** an account read that already happened (Positions): use it when today's update is still due */
export function applyAccountValue(account, now = Date.now()) {
  if (!due(now)) return;
  const value = Math.round(Number(account?.currentBalances?.liquidationValue) || 0);
  if (value <= 0) return; // nothing to size off; the next read tries again
  const acct = schwabAccount();
  store.set('schwab_acct_size', JSON.stringify({ day: nyDay(now), hash: acct.hash, value, at: now }));
  const input = /** @type {HTMLInputElement} */ (document.getElementById('accountSize'));
  if (Math.round(parseFloat(input.value) || 0) !== value) {
    // a $ chip keeps its dollars; otherwise the risk % holds and the max loss follows the account
    const keepUsd = riskFollowsDollars();
    input.value = String(value);
    if (keepUsd) syncFromDollar(); else recalcAll();
    showToast(`Account size ${dollars(value)} from Schwab ${mask(acct.last4)}. Max loss ${fmt$(riskDollars())}.`);
  }
  updateAccountSourceUi();
}

/** read the account when today's update is due; Positions, when open, reads it anyway and applies it there */
export async function dailyAccountSize(now = Date.now()) {
  if (!due(now) || state.positionsView || state.acctSizeBusy) return;
  state.acctSizeBusy = true;
  try {
    applyAccountValue(await schwabBalances(), now);
  } catch(e) {
    // quiet: the next focus or read tries again
  } finally {
    state.acctSizeBusy = false;
  }
}

export function setAccountSizeSource(source) {
  store.set('schwab_acct_source', source === 'manual' ? 'manual' : 'schwab');
  if (source !== 'manual') store.del('schwab_acct_size'); // switching back on updates now
  updateAccountSourceUi();
  dailyAccountSize();
}

const when = ms => {
  const d = new Date(ms);
  return nyDay(ms) === nyDay(Date.now()) ? 'at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : `on ${d.getMonth() + 1}/${d.getDate()}`;
};

/** the source switch in the risk sheet: shown while logged in to Schwab */
export function updateAccountSourceUi() {
  const acct = schwabConnected() ? schwabAccount() : null;
  document.getElementById('acctSourceRow').style.display = acct ? '' : 'none';
  if (!acct) return;
  const on = accountSizeFromSchwab();
  for (const [id, active] of [['acctSrcSchwab', on], ['acctSrcManual', !on]]) {
    document.getElementById(id).classList.toggle('active', active);
    document.getElementById(id).setAttribute('aria-pressed', String(active));
  }
  const last = lastUpdate();
  document.getElementById('acctSourceNote').textContent = !on ? 'Account size stays at what you type.'
    : last && last.hash === acct.hash ? `Set to ${dollars(last.value)} from Schwab ${mask(acct.last4)} ${when(last.at)}. Updates once a day; a number you type holds until then.`
    : `Takes the Schwab ${mask(acct.last4)} account value once a day.`;
}

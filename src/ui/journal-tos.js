// The Import sheet's thinkorswim statement upload (state.tosImport): pick an Account Statement CSV, see the futures fills
// it holds (how many are new, the fees, which zone its clock was read in, anything skipped), then save them to your
// account as statement fills. Schwab's API has no futures, so this is how they reach the journal (core/tos-statement.js).
import { fmt$, marketEscape as esc } from '../core/format.js';
import { fillsFrom } from '../core/journal-records.js';
import { parseTosStatement, statementRecords, statementZone, STATEMENT_ZONES, zoneName } from '../core/tos-statement.js';
import { saveStatementFills } from '../services/journal.js';
import { state } from '../state.js';
import { showError, showToast } from './feedback.js';
import { loadJournal, renderImportSheet } from './journal.js';

/** a statement bigger than this isn't one (a year of trading is well under 1 MB) */
const MAX_BYTES = 5 * 1024 * 1024;

const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };

/** fill ids already kept from earlier statements */
const keptIds = () => new Set((state.journalRecords || []).filter(r => r.kind === 'statement_fill').map(r => r.record_id));

/** 'Oct 20' from a wall time or day. @param {string} wall */
const dayWords = wall => {
  const d = new Date(`${wall.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
};

export function pickTosStatement() { document.getElementById('tosStatementInput')?.click?.(); }

/** the file picked: read it and show what it holds. @param {HTMLInputElement} el */
export async function tosStatementChosen(el) {
  const file = el?.files?.[0];
  if (!file) return;
  if (el) el.value = ''; // picking the same file again still reads it
  if (file.size > MAX_BYTES) { state.tosImport = { name: file.name, error: "That file is too big to be a thinkorswim statement." }; renderImportSheet(); return; }
  let text = '';
  try { text = await file.text(); } catch { state.tosImport = { name: file.name, error: "Couldn't read that file." }; renderImportSheet(); return; }
  const parsed = parseTosStatement(text);
  if (parsed.error) { state.tosImport = { name: file.name, error: parsed.error }; renderImportSheet(); return; }
  const schwab = fillsFrom(state.journalRecords || []).filter(f => !f.id.startsWith('tos:')).map(f => ({ orderId: f.orderId, time: f.time }));
  const z = statementZone(parsed.stockFills, schwab, deviceZone());
  state.tosImport = { name: file.name, parsed, zone: z.zone, matched: z.matched, checked: z.checked, busy: false, error: '' };
  renderImportSheet();
}

/** the zone the file's times are read in, changed by hand. @param {HTMLSelectElement} el */
export function setTosZone(el) {
  if (!state.tosImport?.parsed || !el?.value) return;
  state.tosImport.zone = el.value;
  state.tosImport.matched = 0;
  renderImportSheet();
}

export function clearTosStatement() { state.tosImport = null; renderImportSheet(); }

export async function saveTosStatement() {
  const t = state.tosImport;
  if (!t?.parsed || t.busy) return;
  const kept = keptIds();
  const fresh = t.parsed.fills.filter(f => !kept.has(f.id));
  if (!fresh.length) { clearTosStatement(); showToast('Nothing new: every futures fill in that statement is already kept.'); return; }
  t.busy = true;
  renderImportSheet();
  try {
    await saveStatementFills(statementRecords(fresh, t.parsed.account, t.zone));
  } catch(e) {
    t.busy = false;
    renderImportSheet();
    showError(`Couldn't save the futures fills: ${String(e?.message || e)}`);
    return;
  }
  const old = t.parsed.fills.length - fresh.length;
  state.tosImport = null;
  renderImportSheet();
  showToast(`Saved ${fresh.length} futures fill${fresh.length === 1 ? '' : 's'}${old ? `, ${old} already kept` : ''}.`);
  if (state.journalView) loadJournal();
}

/** the Import sheet's section: the picker, or what the picked statement holds */
export function tosSectionHtml() {
  const t = state.tosImport;
  const input = `<input type="file" id="tosStatementInput" accept=".csv,text/csv" hidden data-change="tosStatementChosen" />`;
  const how = `<details class="hint-details"><summary>How to export it</summary><p class="hint">In thinkorswim desktop: Monitor → Account Statement, set the dates, then the menu at the top right → Export to File. Times in the file are your computer's clock; the app works out the zone from the stock fills Schwab's API also has.</p></details>`;
  const head = `<div class="sheet-label">thinkorswim statement <span class="sheet-status">futures</span></div>`;
  if (!t || (!t.parsed && !t.error)) {
    return `${head}<p class="hint">Schwab's API has no futures, so they come from thinkorswim's Account Statement (CSV). Stocks and options in it are left out: the Schwab import already has them. Importing a statement again only adds what's new.</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn" data-action="pickTosStatement">Choose statement (CSV)</button></div>${how}${input}`;
  }
  if (t.error) {
    return `${head}<p class="hint" role="alert" style="color:var(--amber)">${esc(t.name)}: ${esc(t.error)}</p>
      <div class="row" style="align-items:center;gap:8px;"><button class="btn" data-action="pickTosStatement">Choose another file</button></div>${how}${input}`;
  }
  const p = t.parsed, kept = keptIds();
  const fresh = p.fills.filter(f => !kept.has(f.id)).length;
  const symbols = [...new Set(p.fills.map(f => f.symbol))];
  const fees = p.fills.reduce((n, f) => n + f.fee, 0);
  const walls = p.fills.map(f => f.wall).sort();
  const span = walls.length ? (dayWords(walls[0]) === dayWords(walls[walls.length - 1]) ? dayWords(walls[0]) : `${dayWords(walls[0])} to ${dayWords(walls[walls.length - 1])}`) : '';
  const zoneLine = t.matched ? `Times read as ${esc(zoneName(t.zone))} time: ${t.matched} of ${t.checked} stock fills match Schwab's.`
    : `Times read as ${esc(zoneName(t.zone))} time${t.checked ? `: none of the ${t.checked} stock fills matched Schwab's, so check it` : ", this device's zone"}.`;
  const zones = [...STATEMENT_ZONES.map(([z]) => z), t.zone].filter((z, i, a) => a.indexOf(z) === i);
  const select = `<select id="tosZone" class="tos-zone" data-change="setTosZone" aria-label="Zone the file's times are in">${zones.map(z => `<option value="${esc(z)}"${z === t.zone ? ' selected' : ''}>${esc(zoneName(z))}</option>`).join('')}</select>`;
  const skipped = p.skipped.length
    ? `<p class="hint" style="color:var(--amber)">Skipped ${p.skipped.length}: ${p.skipped.slice(0, 5).map(s => `${esc(s.text)} (${esc(s.why)})`).join('; ')}${p.skipped.length > 5 ? '; …' : ''}</p>` : '';
  const summary = p.fills.length
    ? `<p class="hint"><b>${p.fills.length} futures fill${p.fills.length === 1 ? '' : 's'}</b> · ${esc(symbols.join(', '))} · ${esc(span)} · fees ${fmt$(fees)} · account ••${esc(p.account)}</p>
      <p class="hint">${fresh === p.fills.length ? 'All new.' : fresh ? `${fresh} new, ${p.fills.length - fresh} already kept.` : 'All already kept.'}</p>`
    : `<p class="hint">No futures fills in this statement${p.through ? ` (${esc(dayWords(p.from))} to ${esc(dayWords(p.through))})` : ''}.</p>`;
  return `${head}<p class="hint">${esc(t.name)}</p>${summary}${skipped}
    ${p.fills.length ? `<div class="row" style="align-items:center;gap:8px;flex-wrap:wrap;"><span class="hint">${zoneLine}</span>${select}</div>` : ''}
    <div class="row" style="align-items:center;gap:8px;">
      ${fresh ? `<button class="btn primary" data-action="saveTosStatement"${t.busy ? ' disabled' : ''}>${t.busy ? 'Saving…' : `Save ${fresh} fill${fresh === 1 ? '' : 's'}`}</button>` : ''}
      <button class="btn" data-action="clearTosStatement"${t.busy ? ' disabled' : ''}>${fresh ? 'Cancel' : 'Done'}</button>
    </div>${input}`;
}

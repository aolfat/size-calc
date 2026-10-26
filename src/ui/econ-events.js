// The economic calendar in the Journal (core/econ-events.js has the dates): a calendar cell's dot (red high impact, amber
// medium) and its hover card (desktop pointers only: phones tap through to the day page), the day page's Economic events
// row, and the words for today's line and the cells' labels. New York times, like the rest of the journal.
import { marketEscape as esc } from '../core/format.js';
import { econCovers, econEvents, econImpact, econTime } from '../core/econ-events.js';

const fullDay = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** the cell's dot: nothing on a quiet day */
export function econDot(day) {
  const impact = econImpact(econEvents(day));
  return impact ? `<span class="jc-ev jc-ev-${impact}" aria-hidden="true"></span>` : '';
}

/** the hover card beside a cell's button: the day, each release's time, impact and name, how many */
export function econPopHtml(day) {
  const list = econEvents(day);
  if (!list.length) return '';
  const rows = list.map(e => `<li><span class="ev-time">${econTime(e.time)}</span><span class="ev-dot ev-${e.impact}"></span><span class="ev-name">${esc(e.name)}${e.note ? `<span class="ev-note">${esc(e.note)}</span>` : ''}</span></li>`).join('');
  return `<div class="jc-pop" aria-hidden="true"><div class="ev-head">${esc(fullDay(day))}</div><ul class="ev-list">${rows}</ul><div class="ev-foot">${list.length} event${list.length === 1 ? '' : 's'} · New York time</div></div>`;
}

/** for a cell's label: ', CPI 8:30 am, Fed rate decision 2:00 pm, Fed press conference 2:30 pm' */
export function econWords(day) {
  const list = econEvents(day);
  return list.length ? `, ${list.map(e => `${e.name} ${econTime(e.time)}`).join(', ')}` : '';
}

/** today's line: ' · CPI 8:30 am · FOMC 2:00 pm', the high-impact ones (the press conference rides with its decision) */
export function econTodayWords(day) {
  const list = econEvents(day).filter(e => e.impact === 'high' && e.kind !== 'presser');
  return list.map(e => ` · ${e.short} ${econTime(e.time)}`).join('');
}

/** the day page's row: each release with its time, or none; nothing past the schedule's last day */
export function econDayRow(day) {
  if (!econCovers(day)) return '';
  const list = econEvents(day);
  const body = list.length
    ? `<ul class="ev-list ev-day">${list.map(e => `<li><span class="ev-time">${econTime(e.time)}</span><span class="ev-dot ev-${e.impact}" role="img" aria-label="${e.impact} impact"></span><span class="ev-name">${esc(e.name)}${e.note ? `<span class="ev-note">${esc(e.note)}</span>` : ''}</span></li>`).join('')}</ul>`
    : '<p class="hint nb-empty">No major releases.</p>';
  return `<div class="jr-row"><div class="jr-label">Economic events <span class="jr-sub">New York time</span></div><div>${body}</div></div>`;
}

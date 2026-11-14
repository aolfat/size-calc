// The Journal's period head, shared by the calendar and a day's notebook page: the dates' name in a pill with thin ‹ › inside it.
import { marketEscape as esc } from '../core/format.js';

/** a thin chevron, the pill's ‹ or › (the month picker's year arrows too) @param {number} dir */
export const chevron = dir => `<svg viewBox="0 0 7 12" aria-hidden="true"><path d="${dir < 0 ? 'M6 1 1 6l5 5' : 'M1 1l5 5-5 5'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * The head over a span of days: its name in a pill with thin ‹ › inside it (owner's pick from a design study: no down
 * arrow, no This month or Stats › beside it). A step that can't go greys out in place, so nothing moves. The name is
 * the button: `name` gives it its action (the calendar's month picker, `panel`), `pick` lays the phone's own date picker
 * over it (a week's or a day's name, on a touch screen), `open` makes it open Filters (your own dates); else it's just
 * the name. `sub` goes under the pill (Year to date's span), `lead` over it (a day page's way back and Today), `end`
 * after it (the desktop calendar's modes and review).
 * `step`: prev and next are each arrow's action attributes, word what they step through ('month with trades', read
 * 'Earlier month with trades'), and the Off flags grey out the ones that can't go.
 * @param {{ title: string, sub?: string, name?: string, pick?: string, open?: string, panel?: string, lead?: string, end?: string, cls?: string,
 *   step?: { prev: string, next: string, word: string, prevOff?: boolean, nextOff?: boolean } | null }} o
 */
export function periodHead({ title, sub = '', name = '', pick = '', open = '', panel = '', step = null, lead = '', end = '', cls = '' }) {
  const words = `<span class="jc-title">${esc(title)}</span>`;
  const label = name ? `<button class="jc-pill-name" ${name}>${words}</button>`
    : pick ? `<label class="jc-pill-name jc-picks">${words}${pick}</label>`
    : open ? `<button class="jc-pill-name" ${open}>${words}</button>` : `<span class="jc-pill-name">${words}</span>`;
  const off = b => b ? ' disabled' : '';
  const pill = !step ? `<div class="jc-pill">${label}</div>`
    : `<div class="jc-pill jc-pill-steps"><button class="jc-pill-step" ${step.prev} aria-label="Earlier ${esc(step.word)}"${off(step.prevOff)}>${chevron(-1)}</button>${label}<button class="jc-pill-step" ${step.next} aria-label="Later ${esc(step.word)}"${off(step.nextOff)}>${chevron(1)}</button></div>`;
  return `<div class="jc-head jc-period${panel ? ' jc-picking' : ''}${cls ? ` ${cls}` : ''}">${lead ? `<div class="jc-lead">${lead}</div>` : ''}<div class="jc-pillrow">${pill}${sub ? `<span class="jc-sub">${esc(sub)}</span>` : ''}</div>${panel}${end}</div>`;
}

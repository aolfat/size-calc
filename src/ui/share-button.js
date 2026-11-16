// The one share button (owner request: the same everywhere, like the logo): the share icon in a small square, on every place
// that copies a card image (a Journal trade's card, row and page, Positions, the shares answer, pinned cards).
import { marketEscape as esc } from '../core/format.js';

/** the share icon: a box with an arrow up out of it */
export const SHARE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 10.5H6.5A1.5 1.5 0 0 0 5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * the share button: the icon alone, named for screen readers by label ('Share AAPL as an image'), its title saying what a tap does.
 * act: its action attributes as markup, 'data-action="sharePinned" data-arg="…"' (written out where it's used, so the action check finds it; the arg escaped there)
 * @param {string} act @param {string} label @param {string} [title]
 */
export function shareIconButton(act, label, title = 'Share: copy a card image') {
  return `<button class="share-btn" ${act} aria-label="${esc(label)}" title="${esc(title)}">${SHARE_ICON}</button>`;
}

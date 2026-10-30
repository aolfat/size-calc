// @ts-check
// Panes that scroll on their own (the desktop Journal's rail, list, panel and review) keep their place through a redraw
// that replaces them: each [data-scroll] element's scrollTop is read before and put back after, while its key matches.

/**
 * Read every [data-scroll] pane's place under root, run redraw, then put each back on the pane with the same name and key
 * (a new key, say another tab, starts at the top).
 * @param {ParentNode | null} root @param {() => void} redraw
 */
export function keepScroll(root, redraw) {
  /** @type {Map<string, number>} */
  const at = new Map();
  const panes = root?.querySelectorAll ? [...root.querySelectorAll('[data-scroll]')] : [];
  for (const el of panes) at.set(String(/** @type {HTMLElement} */ (el).dataset.scroll), /** @type {HTMLElement} */ (el).scrollTop || 0);
  redraw();
  const after = root?.querySelectorAll ? [...root.querySelectorAll('[data-scroll]')] : [];
  for (const el of after) {
    const top = at.get(String(/** @type {HTMLElement} */ (el).dataset.scroll));
    if (top) /** @type {HTMLElement} */ (el).scrollTop = top;
  }
}

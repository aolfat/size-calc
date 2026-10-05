// Event delegation: markup names an action, and one listener per event type on the root runs it.
//
//   click     <button data-action="setMode" data-arg="options">
//   input     <input data-input="recalcAll">
//   change    <input data-change="sharesQtyChanged">
//   Enter     <input data-enter="submitTicker">
//
// Handlers receive (element, event). The nearest element carrying the attribute wins, so a chip
// inside a clickable bar runs only the chip's action. Rendered templates use the same attributes,
// so freshly rendered cards and rows work without wiring anything up.

/** @typedef {(el: HTMLElement, event: Event) => unknown} Handler */

/**
 * @param {Document | HTMLElement} root
 * @param {Record<string, Handler>} handlers
 */
export function delegate(root, handlers) {
  const run = (/** @type {string} */ attr, /** @type {Event} */ event) => {
    const target = /** @type {HTMLElement | null} */ (event.target);
    const el = target && target.closest ? /** @type {HTMLElement | null} */ (target.closest(`[data-${attr}]`)) : null;
    if (!el) return;
    const name = el.dataset[attr] || '';
    const handler = handlers[name];
    if (handler) handler(el, event);
    else console.warn(`No handler for data-${attr}="${name}"`);
  };
  root.addEventListener('click', e => run('action', e));
  root.addEventListener('input', e => run('input', e));
  root.addEventListener('change', e => run('change', e));
  root.addEventListener('keydown', e => { if (/** @type {KeyboardEvent} */ (e).key === 'Enter') run('enter', e); });
}

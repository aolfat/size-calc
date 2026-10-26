// @ts-check
// Text boxes that grow with what you type: a <textarea class="grow"> is as tall as its text, never shorter than its rows.

/** @param {HTMLTextAreaElement} box */
export function growBox(box) {
  if (!box?.style || !('scrollHeight' in box)) return;
  const holder = /** @type {HTMLElement | null} */ (box.parentElement);
  const held = holder ? holder.style.minHeight : '';
  if (holder) holder.style.minHeight = `${holder.offsetHeight}px`; // the page keeps its height while the box is measured, so it doesn't jump
  box.style.height = 'auto'; // back to its rows, so deleting text shrinks it
  box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`; // border-box: add the borders back
  if (holder) holder.style.minHeight = held;
}

/** every growing box under root, after it was drawn */
export function growBoxes(/** @type {ParentNode | null | undefined} */ root) {
  root?.querySelectorAll?.('textarea.grow').forEach(box => growBox(/** @type {HTMLTextAreaElement} */ (box)));
}

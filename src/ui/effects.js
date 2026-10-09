// Side effects behind one seam: clipboard text, share images, the returns simulator, reloading the page, and waiting.
// Callers go through `effects`, so tests can observe or replace one without patching the module that owns it.
import { copyPlainText } from './copy-text.js';
import { drawShareCard, shareCanvasToClipboard } from './share-image.js';
import { openSim } from './sim.js';

/** after signing out, start over from a clean page */
export function reloadPage() { location.reload(); }

/** a pause between reads of Schwab @param {number} ms */
export function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

export const effects = { copyPlainText, drawShareCard, shareCanvasToClipboard, openSim, reloadPage, wait };

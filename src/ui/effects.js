// Side effects behind one seam: clipboard text, share images, the returns simulator, reloading the page, waiting, file downloads, and shrinking a screenshot.
// Callers go through `effects`, so tests can observe or replace one without patching the module that owns it.
import { copyPlainText } from './copy-text.js';
import { drawShareCard, shareCanvasToClipboard } from './share-image.js';
import { openSim } from './sim.js';
import { prepareImage, readClipboardImages } from './image-prep.js';

/** after signing out, start over from a clean page */
export function reloadPage() { location.reload(); }

/** a pause between reads of Schwab @param {number} ms */
export function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/** save text as a file the browser downloads @param {string} name @param {string} text */
export function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const effects = { copyPlainText, drawShareCard, shareCanvasToClipboard, openSim, reloadPage, wait, downloadText, prepareImage, readClipboardImages };

// Side effects behind one seam: clipboard text, share images, the returns simulator, and reloading the page.
// Callers go through `effects`, so tests can observe or replace one without patching the module that owns it.
import { copyPlainText } from './copy-text.js';
import { drawShareCard, shareCanvasToClipboard } from './share-image.js';
import { openSim } from './sim.js';

/** after signing out, start over from a clean page */
export function reloadPage() { location.reload(); }

export const effects = { copyPlainText, drawShareCard, shareCanvasToClipboard, openSim, reloadPage };

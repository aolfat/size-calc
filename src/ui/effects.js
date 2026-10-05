// Side effects behind one seam: clipboard text, share images, and the returns simulator.
// Callers go through `effects`, so tests can observe or replace one without patching the module that owns it.
import { copyPlainText } from './copy-text.js';
import { drawShareCard, shareCanvasToClipboard } from './share-image.js';
import { openSim } from './sim.js';

export const effects = { copyPlainText, drawShareCard, shareCanvasToClipboard, openSim };

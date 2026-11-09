// Side effects behind one seam: clipboard text, share images, the returns simulator, reloading the page, waiting, file downloads,
// shrinking a screenshot, loading the chart library, opening a WebSocket, and a haptic tap.
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

/** Lightweight Charts, loaded the first time a trade page draws a chart (tests swap in a fake) */
export function loadChartLibrary() { return import('../../vendor/lightweight-charts.js'); }

/** a WebSocket (Live's streaming quotes; tests swap in a fake) @param {string} url */
export function openSocket(url) { return new WebSocket(url); }

/**
 * A light tap felt in the hand, for a moment that lands (a stop set, a step, a refresh).
 * Android has vibrate; iOS gives the web no haptics API, but Safari (iOS 18 and later) plays its own tick when a
 * checkbox switch flips, so a hidden one is flipped. Its click never reaches the page's own handlers.
 * Call it from a tap or a release: iOS only plays it inside a user gesture.
 */
export function haptic() {
  try {
    if (typeof navigator.vibrate === 'function') { navigator.vibrate(8); return; }
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    label.appendChild(input);
    label.addEventListener('click', e => e.stopPropagation());
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch { /* no haptics here: nothing to feel */ }
}

export const effects = { copyPlainText, drawShareCard, shareCanvasToClipboard, openSim, reloadPage, wait, downloadText, prepareImage, readClipboardImages, loadChartLibrary, openSocket, haptic };

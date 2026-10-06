// @ts-check
// Chart viewport: which slice of a bar series is on screen, zoomed and panned in bar units.

/**
 * count = bars on screen, offset = bars hidden past the right edge (0 = the latest bar is showing).
 * Both stay fractional so small pinch and drag steps add up; viewRange rounds for drawing.
 * @typedef {{ count: number, offset: number }} ChartView
 */

export const MIN_VIEW_BARS = 10;

/** @param {ChartView} view @param {number} n @returns {ChartView} */
export function clampView(view, n) {
  const count = Math.min(n, Math.max(Math.min(MIN_VIEW_BARS, n), view.count));
  const offset = Math.min(n - count, Math.max(0, view.offset));
  return { count, offset };
}

/** Bar indexes on screen, [start, end). @param {ChartView} view @param {number} n @returns {{ start: number, end: number }} */
export function viewRange(view, n) {
  const v = clampView(view, n);
  const end = n - Math.round(v.offset);
  return { start: Math.max(0, end - Math.round(v.count)), end };
}

/**
 * Zoom by `factor` (> 1 shows fewer bars), holding the bar under `anchor` (0 = left edge, 1 = right) in place.
 * @param {ChartView} view @param {number} n @param {number} factor @param {number} anchor @returns {ChartView}
 */
export function zoomView(view, n, factor, anchor) {
  const v = clampView(view, n);
  const right = 1 - Math.min(1, Math.max(0, anchor));
  const pivot = n - v.offset - right * v.count;
  const count = clampView({ count: v.count / factor, offset: 0 }, n).count;
  return clampView({ count, offset: n - pivot - right * count }, n);
}

/** Pan by `bars`; positive moves back in time. @param {ChartView} view @param {number} n @param {number} bars @returns {ChartView} */
export function panView(view, n, bars) {
  const v = clampView(view, n);
  return clampView({ count: v.count, offset: v.offset + bars }, n);
}

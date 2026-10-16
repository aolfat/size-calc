// A fake Lightweight Charts (vendor/lightweight-charts.js never loads in tests): the calls the app makes, recorded.
//
//   const lib = fakeCharts();  // pass as app({ charts: lib })
//   lib.charts[0].series[0].data, .lines, .markers; lib.charts[0].range; lib.charts[0].hover({ logical: 3 })
export function fakeCharts() {
  const charts = [];
  const lib = {
    charts,
    CandlestickSeries: 'Candlestick', LineSeries: 'Line', HistogramSeries: 'Histogram',
    ColorType: { Solid: 'solid' }, CrosshairMode: { Normal: 0 }, LineStyle: { Solid: 0, Dashed: 2 },
    createChart(container, options) {
      const crosshair = [];
      const chart = {
        container, options, series: [], scales: {}, range: null, fitted: false, removed: false,
        addSeries(type, opts = {}) {
          const s = {
            type, options: opts, data: [], lines: [],
            setData(d) { s.data = d; },
            applyOptions(o) { Object.assign(s.options, o); },
            createPriceLine(o) { const line = { options: o }; s.lines.push(line); return line; },
            removePriceLine(line) { s.lines = s.lines.filter(l => l !== line); },
            priceScale: () => ({ applyOptions(o) { s.scale = o; } }),
          };
          chart.series.push(s);
          return s;
        },
        timeScale: () => ({
          fitContent() { chart.fitted = true; chart.range = null; },
          setVisibleLogicalRange(r) { chart.range = r; chart.fitted = false; },
        }),
        priceScale: id => ({ applyOptions(o) { chart.scales[id] = { ...chart.scales[id], ...o }; } }),
        subscribeCrosshairMove(fn) { crosshair.push(fn); },
        applyOptions(o) { Object.assign(chart.options, o); },
        remove() { chart.removed = true; },
        hover(param) { for (const fn of crosshair) fn(param); },
      };
      charts.push(chart);
      return chart;
    },
    createSeriesMarkers(series, markers) {
      series.markers = markers;
      return { setMarkers(m) { series.markers = m; } };
    },
  };
  return lib;
}

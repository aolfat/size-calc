export function expChat(expStr) { // 2026-09-18 → 9/18
  const p = (expStr || '').split('-');
  return p.length === 3 ? +p[1] + '/' + +p[2] : expStr;
}

export function fmtFuturesPrice(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 10 }); }

export function marketEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

export function fmtLev(l) { return (l < 0 ? '−' : '') + Math.abs(l) + 'x'; }

export function fmtDayVol(v) {
  if (!(v > 0)) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(0) + 'M';
  return '$' + (v / 1e3).toFixed(0) + 'k';
}

export function fmt$(v) { return '$' + Number(v).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

export function fmtN(v, d=2) { return Number(v).toFixed(d); }

// ---------- 5-min chart ----------

export function dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}

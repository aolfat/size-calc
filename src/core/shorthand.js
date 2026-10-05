export function parseQuickStr(str) {
  const s = str.trim();
  if (!s) return null;
  // order-free tokens: ticker, strike, expiry (m/d, m.d, m/d/yy), call/put
  const tokens = s.split(/\s+/);
  const isAlpha = t => /^[A-Za-z]{1,5}$/.test(t);
  const isDate = t => {
    const m = t.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/);
    return m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31;
  };
  const alphaCount = tokens.filter(isAlpha).length;
  let ticker = null, optType = null, dateTok = null, pair = null, spread = false, creditSpread = false;
  const nums = [];
  for (const raw of tokens) {
    const t = raw.replace(/^\$/, '');
    const low = t.toLowerCase();
    if ((low === 'cds' || low === 'pds' || low === 'ccs' || low === 'pcs') && !spread) { spread = true; creditSpread = low[1] === 'c'; optType = low[0] === 'c' ? 'call' : 'put'; continue; }
    if ((low === 'call' || low === 'put') && !optType) { optType = low; continue; }
    // bare c/p means the type only when another word can be the ticker (C and P are real tickers)
    if ((low === 'c' || low === 'p') && alphaCount > 1 && !optType) { optType = low === 'c' ? 'call' : 'put'; continue; }
    if (t.includes('/') && isDate(t) && !dateTok) { dateTok = t; continue; }
    // a strike pair (105/115) is anything slashed that can't be a date
    if (!pair && /^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(t) && !isDate(t)) { pair = t.split('/').map(Number); continue; }
    if (isAlpha(t) && !ticker) { ticker = t.toUpperCase(); continue; }
    // a strike can carry its type: 245c, 580.5p
    const suffixed = t.match(/^(\d+(?:\.\d+)?)([cp])$/i);
    if (suffixed && nums.length < 2) {
      const type = suffixed[2].toLowerCase() === 'c' ? 'call' : 'put';
      if (optType && optType !== type) return null;
      optType = type; nums.push(parseFloat(suffixed[1])); continue;
    }
    if (/^\d+(\.\d+)?$/.test(t)) {
      // a dotted number (9.18) is a date unless one is already set, then it's a strike
      if (t.includes('.') && !dateTok && isDate(t)) { dateTok = t; continue; }
      if (nums.length < 2) { nums.push(parseFloat(t)); continue; }
    }
    if (isDate(t) && !dateTok) { dateTok = t; continue; } // dotted with year: 9.18.26
    return null; // unrecognized token
  }
  if (!ticker || !dateTok) return null;
  optType = optType || 'call';
  let strike, strike2 = null;
  if (spread) {
    const pr = pair || (nums.length === 2 ? nums : null);
    if (!pr || pr[0] === pr[1] || !(pr[0] > 0) || !(pr[1] > 0)) return null;
    const lo = Math.min(pr[0], pr[1]), hi = Math.max(pr[0], pr[1]);
    strike = optType === 'call' ? lo : hi;  // near leg first: debit buys it, credit sells it
    strike2 = optType === 'call' ? hi : lo; // the further-out leg
  } else {
    if (pair) return null; // a strike pair needs cds/pds to say which spread
    if (!nums.length) return null;
    strike = nums[0];
  }
  const parts = dateTok.split(/[\/.]/).map(Number);
  const month = parts[0];
  const day = parts[1];
  let year = parts.length > 2 ? parts[2] : new Date().getFullYear();
  if (year < 100) year += 2000;
  const expDate = new Date(year, month - 1, day);
  const yyyy = expDate.getFullYear();
  const mm = String(expDate.getMonth() + 1).padStart(2, '0');
  const dd = String(expDate.getDate()).padStart(2, '0');
  const expStr = `${yyyy}-${mm}-${dd}`;
  const typeChar = optType === 'call' ? 'C' : 'P';
  const mkOcc = k => `${ticker}${yyyy.toString().slice(2)}${mm}${dd}${typeChar}${String(Math.round(k * 1000)).padStart(8, '0')}`;
  const occ = mkOcc(strike);
  if (spread) {
    return { ticker, strike, strike2, optType, spread: true, credit: creditSpread, expStr, occ, occ2: mkOcc(strike2),
      display: `${ticker} $${strike}/$${strike2} ${optType} ${creditSpread ? 'credit' : 'debit'} spread ${expStr}` };
  }
  return { ticker, strike, optType, expStr, occ, display: `${ticker} $${strike} ${optType} ${expStr}` };
}

// the ticker field is the one search box: a symbol loads its quote, shorthand pins a contract

export function isShorthand(v) { return v.trim().split(/\s+/).length > 1; }

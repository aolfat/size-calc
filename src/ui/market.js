import { state } from '../state.js';
import { marketEscape } from '../core/format.js';
import { store } from '../lib/store.js';
import { baseUrl, headers } from '../services/tradier.js';
import { updateChartVisibility } from './daily.js';
import { showToast } from './feedback.js';
import { stopLive } from './live.js';
import { setQuoteVisible } from './shares.js';
import { openSheet } from './sheets.js';
import { updateStickyBar } from './sticky-bar.js';
import { fetchQuote } from './ticker.js';
import { setMode, setView } from './views.js';
import { MarketData } from '../core/market-data.js';

// ---------- market pulse ----------

export const MARKET_FILE = 'data/market-universe-2026-09-16.csv';

export const MARKET_ETF_FILE = 'data/market-etfs-2026-09-16.csv';

export const MARKET_PERIODS = ['Today', '1W', '1M', '3M', '6M', 'YTD', 'From open', '1Y'];

export const MARKET_CATEGORIES = [
  { id:'themes', name:'Theme Tracker', description:'146 industry groups' },
  { id:'group-etfs', name:'Group ETFs', description:'Thematic, industry and asset class funds' },
  { id:'sectors', name:'S&P Sectors', description:'Sector, growth and value funds' },
  { id:'equal-weight', name:'Equal Weight', description:'Equal-weight index and sector funds' },
  { id:'countries', name:'Country ETFs', description:'Country, regional and global funds' },
];

export function marketPct(value) { return value === null ? '—' : (value > 0 ? '+' : '') + (Math.abs(value) < 0.005 ? 0 : value).toFixed(2) + '%'; }

export function marketTone(value) { return value === null || Math.abs(value) < 0.005 ? 'market-neutral' : value > 0 ? 'market-positive' : 'market-negative'; }

export function marketAllRows() { return [...state.marketState.stocks, ...state.marketState.etfs]; }

export function marketRefreshScope() {
  const category = MARKET_CATEGORIES.find(item => item.id === state.marketState.category);
  const theme = category.id === 'themes';
  const rows = theme ? state.marketState.group ? state.marketState.stocks.filter(row => row.group === state.marketState.group) : state.marketState.stocks
    : state.marketState.etfs.filter(row => row.category === category.id);
  return {id:theme && state.marketState.group ? 'group:' + state.marketState.group : category.id,
    label:state.marketState.group || category.name, rows, interval:theme && !state.marketState.group ? 180000 : 30000};
}

export function marketQuoteSymbols() { return [...new Set(marketRefreshScope().rows.map(row => row.ticker))]; }

export function marketCachedSnapshot(scope = marketRefreshScope()) {
  const own = state.marketState.snapshots[scope.id];
  const parent = scope.id.startsWith('group:') ? state.marketState.snapshots.themes : null;
  return parent && (!own || parent.fetchedAt > own.fetchedAt) ? parent : own || null;
}

export function marketColumns() { return state.marketState.category === 'themes' ? [0,1,2,3,4,5] : [6,0,1,2,3,4,7]; }

export function marketPeriodHelp(period) {
  const meanings = ['Change from the previous session close', 'One-week return', 'One-month return', 'Three-month return',
    'Six-month return', 'Year-to-date return', 'Change from the session open', 'One-year return, separate from year to date'];
  const quotePeriod = period === 0 || period === 6;
  const source = quotePeriod && state.marketState.quoteMode && marketCachedSnapshot()
    ? 'Uses the latest fetched Tradier quotes; prices may be delayed.'
    : 'Uses the imported Sep 16, 2026 snapshot.';
  return meanings[period] + '. ' + source + (quotePeriod ? '' : ' Quote refreshes do not update this period.');
}

export function marketRows() {
  const scope = marketRefreshScope(), cached = marketCachedSnapshot(scope);
  return state.marketState.quoteMode && cached ? MarketData.withQuotes(scope.rows, cached.quotes) : scope.rows;
}

export function marketCacheKey() { return 'market_quotes_v3_' + document.getElementById('apiEnv').value; }

export function marketSetCategory(category) {
  if (!MARKET_CATEGORIES.some(item => item.id === category)) return;
  state.marketState.category = category; state.marketState.scope = 'groups'; state.marketState.group = ''; state.marketState.limit = 100;
  if (!marketColumns().includes(state.marketState.period)) state.marketState.period = 2;
  document.getElementById('marketNotice').hidden = true;
  marketClearSearch();
  marketScheduleRefresh();
}

export function marketReadCache() {
  state.marketState.environment = document.getElementById('apiEnv').value;
  state.marketState.key = document.getElementById('apiKey').value.trim();
  state.marketState.snapshots = Object.create(null);
  state.marketState.retryAt = 0; state.marketState.failures = 0; state.marketState.authBlocked = false;
  try {
    const cached = JSON.parse(store.get(marketCacheKey()) || store.get('market_quotes_v2_' + state.marketState.environment) || 'null');
    if (!cached || (!cached.scopes && !cached.quotes)) return;
    const scopes = MARKET_CATEGORIES.map(category => [category.id, category.id === 'themes' ? state.marketState.stocks : state.marketState.etfs.filter(row => row.category === category.id)]);
    MarketData.groups(state.marketState.stocks).forEach(group => scopes.push(['group:' + group.name, group.stocks]));
    scopes.forEach(([id, rows]) => {
      const snapshot = cached.scopes ? cached.scopes[id] : id.startsWith('group:') ? null : cached;
      if (!snapshot || !Number.isFinite(snapshot.fetchedAt) || snapshot.fetchedAt <= 0 || snapshot.fetchedAt > Date.now() || !snapshot.quotes) return;
      const quotes = Object.create(null);
      rows.forEach(({ticker}) => {
        const q = snapshot.quotes[ticker];
        if (q && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.change)) quotes[ticker] = q;
      });
      if (Object.keys(quotes).length) state.marketState.snapshots[id] = {fetchedAt:snapshot.fetchedAt, quotes};
    });
  } catch(e) {}
}

export async function loadMarket() {
  if (state.marketState.loading) return;
  if (state.marketState.stocks.length) {
    if (state.marketState.environment !== document.getElementById('apiEnv').value) marketReadCache();
    renderMarket(); marketScheduleRefresh(); return;
  }
  state.marketState.loading = true; state.marketState.error = '';
  renderMarket();
  try {
    const [stocks, etfs] = await Promise.all([MARKET_FILE, MARKET_ETF_FILE].map(async file => {
      const response = await fetch(file);
      if (!response.ok) throw new Error('Could not load the market universe. Check your connection and retry.');
      return MarketData.parseCsv(await response.text());
    }));
    if (!stocks.length || MARKET_CATEGORIES.slice(1).some(category => !etfs.some(row => row.category === category.id))) throw new Error('The market universe is incomplete.');
    state.marketState.stocks = stocks; state.marketState.etfs = etfs;
    marketReadCache();
  } catch(error) { state.marketState.error = error.message || 'Could not load market data.'; }
  finally { state.marketState.loading = false; renderMarket(); marketScheduleRefresh(); }
}

export function marketSetScope(scope) {
  state.marketState.scope = scope; state.marketState.group = ''; state.marketState.limit = 100;
  marketClearSearch();
  marketScheduleRefresh();
}

export function marketOpenGroup(name) {
  state.marketState.scope = 'stocks'; state.marketState.group = name; state.marketState.limit = 100;
  marketClearSearch();
  marketScheduleRefresh();
  document.getElementById('marketContent').scrollIntoView({ block:'nearest', behavior:'smooth' });
}

export function marketSearchChanged() { state.marketState.limit = 100; renderMarket(); }

export function marketClearSearch() { document.getElementById('marketSearch').value = ''; renderMarket(); }

export function marketSetDisplay(display) { state.marketState.display = display; renderMarket(); }

export function marketSetPeriod(period, toggle) {
  if (!marketColumns().includes(period)) return;
  state.marketState.direction = toggle && state.marketState.sort === 'performance' && state.marketState.period === period && state.marketState.direction === 'desc' ? 'asc' : 'desc';
  state.marketState.sort = 'performance';
  state.marketState.period = period; state.marketState.limit = 100; renderMarket();
}

export function marketSortTicker() {
  state.marketState.direction = state.marketState.sort === 'ticker' && state.marketState.direction === 'asc' ? 'desc' : 'asc';
  state.marketState.sort = 'ticker'; renderMarket();
}

export function marketShowMore() { state.marketState.limit += 100; renderMarket(); }

export function marketSetAuto(enabled) {
  state.marketState.auto = enabled;
  store.set('market_auto_refresh', enabled ? '1' : '0');
  if (!enabled) marketAbortRefresh();
  else { state.marketState.quoteMode = true; state.marketState.authBlocked = false; }
  renderMarket(); marketScheduleRefresh();
}

export function marketToggleAuto() { marketSetAuto(!state.marketState.auto); }

export function marketUseSnapshot() { state.marketState.quoteMode = false; marketSetAuto(false); }

export function marketAbortRefresh() { state.marketState.refresh?.controller.abort(); }

export function marketCancelRefresh() { marketSetAuto(false); }

export function marketSizeTrade(ticker) {
  if (!marketAllRows().some(row => row.ticker === ticker)) return;
  if (state.liveInterval || state.livePausedRemaining > 0) stopLive();
  // Hide the previous symbol while the selected ticker loads, including without a key.
  state.quoteData = null; state.chainData = []; state.chartBars = []; state.dailyBars = []; state.selectedExp = null;
  setQuoteVisible(false);
  document.getElementById('ticker').value = ticker;
  ['entryPrice', 'stopLong', 'stopShort'].forEach(id => { document.getElementById(id).value = ''; });
  if (state.currentMode === 'futures') setMode('shares'); else setView('calc');
  updateChartVisibility(); updateStickyBar();
  window.scrollTo({ top:0, behavior:'smooth' });
  if (document.getElementById('apiKey').value.trim()) fetchQuote();
  else {
    openSheet('settings');
    showToast(ticker + ' selected. Add your Tradier key to load its quote and size the trade.');
  }
}

export function marketRefreshDue(scope = marketRefreshScope()) {
  const cached = marketCachedSnapshot(scope);
  return Math.max(cached ? cached.fetchedAt + scope.interval : 0, state.marketState.retryAt);
}

export function marketScheduleRefresh() {
  clearTimeout(state.marketState.timer); state.marketState.timer = null;
  if (!state.marketView || document.hidden || navigator.onLine === false) {
    marketAbortRefresh();
    if (state.marketView) marketRenderRefreshStatus();
    return;
  }
  const key = document.getElementById('apiKey').value.trim();
  if (state.marketState.environment !== document.getElementById('apiEnv').value || state.marketState.key !== key) {
    marketAbortRefresh(); marketReadCache(); renderMarket();
  }
  const scope = marketRefreshScope();
  if (state.marketState.refresh && state.marketState.refresh.scope.id !== scope.id) marketAbortRefresh();
  marketRenderRefreshStatus();
  if (state.marketState.refresh || state.marketState.loading || !scope.rows.length) return;
  const canRefresh = state.marketState.auto && key && !state.marketState.authBlocked;
  const delay = canRefresh ? Math.min(5000, Math.max(0, marketRefreshDue(scope) - Date.now())) : 5000;
  state.marketState.timer = setTimeout(() => {
    state.marketState.timer = null;
    if (canRefresh && marketRefreshDue() <= Date.now()) return marketRefreshToday(true);
    marketScheduleRefresh();
  }, delay);
}

export function marketRenderRefreshStatus() {
  const ms = state.marketState, scope = marketRefreshScope(), cached = marketCachedSnapshot(scope);
  const usingQuotes = ms.quoteMode && cached;
  const refresh = document.getElementById('marketRefreshBtn');
  refresh.disabled = !!ms.refresh || ms.loading || !scope.rows.length || ms.retryAt > Date.now() || navigator.onLine === false;
  refresh.textContent = ms.refresh ? ms.refresh.status : '↻ Refresh quotes';
  refresh.title = 'Fetch quotes for ' + scope.label + ' (' + scope.rows.length.toLocaleString() + ' symbols). Updates Today'
    + (ms.category === 'themes' ? '' : ' and From open') + '; longer periods stay at the Sep 16, 2026 snapshot.';
  document.getElementById('marketCancelBtn').hidden = !ms.refresh;
  document.getElementById('marketSnapshotBtn').hidden = !usingQuotes;
  const auto = document.getElementById('marketAutoBtn');
  auto.textContent = 'Auto: ' + (ms.auto ? 'on' : 'off');
  auto.setAttribute('aria-pressed', String(ms.auto));
  auto.classList.toggle('primary', ms.auto);
  const interval = scope.interval === 180000 ? '3 min' : '30 sec';
  auto.title = (ms.auto ? 'Pause automatic quote refresh. ' : 'Resume automatic quote refresh. ')
    + scope.label + ' refreshes every ' + interval + ' while Market is visible and online. Requires a Tradier key in Size.';
  const wait = Math.max(0, Math.ceil((ms.retryAt - Date.now()) / 1000));
  const status = navigator.onLine === false ? 'Offline · cached data kept'
    : ms.authBlocked ? 'Auto paused · check your Tradier key in Size'
    : !document.getElementById('apiKey').value.trim() ? 'Add a Tradier key in Size to refresh quotes.'
    : wait ? (ms.refresh ? 'Waiting to retry' : (ms.auto ? 'Retrying in ' : 'Refresh available in ') + wait + ' sec') + ' · previous data kept'
    : (ms.auto ? 'Auto every ' + interval : 'Auto paused') + ' · ' + scope.label + ' · ' + scope.rows.length.toLocaleString() + ' symbols';
  const statusElement = document.getElementById('marketRefreshStatus');
  if (statusElement.textContent !== status) statusElement.textContent = status;
  if (!ms.stocks.length) return;
  const source = document.getElementById('marketSource');
  const history = ms.category === 'themes' ? '1W–YTD' : '1W–1Y';
  if (usingQuotes) {
    const age = Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 1000));
    const ageText = age < 60 ? age + ' sec ago' : age < 3600 ? Math.floor(age / 60) + ' min ago' : new Date(cached.fetchedAt).toLocaleString();
    const count = scope.rows.filter(row => cached.quotes[row.ticker]).length;
    source.innerHTML = '<b>Today' + (ms.category === 'themes' ? '' : ' / from open') + ': Tradier ' + marketEscape(ms.environment)
      + '</b> · fetched ' + marketEscape(ageText) + (Date.now() - cached.fetchedAt >= scope.interval ? ' · <b>stale cache</b>' : '')
      + ' · ' + count.toLocaleString() + '/' + scope.rows.length.toLocaleString() + ' quotes available. Prices may be delayed. '
      + '<b>' + history + ': snapshot Sep 16, 2026.</b>';
  } else {
    source.innerHTML = '<b>Imported snapshot · Sep 16, 2026</b> · All periods are from the reference '
      + (ms.category === 'themes' ? 'export' : 'ETF tables') + '; quote timestamps were not provided. Longer periods stay imported when quotes refresh.';
  }
}

export async function marketRefreshToday(automatic = false) {
  if (state.marketState.refresh || !state.marketState.stocks.length || !state.marketView || document.hidden || navigator.onLine === false) return;
  const notice = document.getElementById('marketNotice');
  const key = document.getElementById('apiKey').value.trim();
  if (!key) {
    if (!automatic) { notice.textContent = 'Add your Tradier key in Size to refresh quotes. The imported snapshot is available without a key.'; notice.hidden = false; }
    return;
  }
  if (state.marketState.environment !== document.getElementById('apiEnv').value || state.marketState.key !== key) marketReadCache();
  if (state.marketState.retryAt > Date.now() || (automatic && (!state.marketState.auto || state.marketState.authBlocked))) { marketScheduleRefresh(); return; }
  const scope = marketRefreshScope(), symbols = marketQuoteSymbols();
  if (!symbols.length) return;
  if (automatic && marketRefreshDue(scope) > Date.now()) { marketScheduleRefresh(); return; }
  clearTimeout(state.marketState.timer); state.marketState.timer = null;
  const context = {controller:new AbortController(), scope, environment:state.marketState.environment,
    status:'Refreshing ' + scope.label + '…'};
  state.marketState.refresh = context;
  notice.hidden = true;
  marketRenderRefreshStatus();
  try {
    const quotes = await MarketData.fetchQuotes(symbols, {
      base:baseUrl(), auth:headers(), signal:context.controller.signal,
      onProgress(done, total) {
        context.status = 'Refreshing ' + done.toLocaleString() + ' / ' + total.toLocaleString();
        marketRenderRefreshStatus();
      },
      onRetry({delay, status}) {
        context.status = 'Waiting to retry batch…';
        if (status === 429) state.marketState.retryAt = Date.now() + delay;
        marketRenderRefreshStatus();
      },
    });
    if (context.controller.signal.aborted || context.environment !== document.getElementById('apiEnv').value || key !== document.getElementById('apiKey').value.trim()) return;
    const scopedQuotes = Object.create(null);
    symbols.forEach(symbol => { if (quotes[symbol]) scopedQuotes[symbol] = quotes[symbol]; });
    if (!Object.keys(scopedQuotes).length) throw new Error('Tradier returned no usable quotes.');
    // Replace only this complete scope. Other tabs keep their own data and timestamps.
    state.marketState.snapshots[scope.id] = {fetchedAt:Date.now(), quotes:scopedQuotes};
    state.marketState.quoteMode = true; state.marketState.failures = 0; state.marketState.retryAt = 0; state.marketState.authBlocked = false;
    store.set(marketCacheKey(), JSON.stringify({scopes:state.marketState.snapshots}));
  } catch(error) {
    if (!context.controller.signal.aborted) {
      state.marketState.failures++;
      state.marketState.authBlocked = error.status === 401 || error.status === 403;
      state.marketState.retryAt = Date.now() + Math.max(error.retryAfter || 0, Math.min(180000, 30000 * 2 ** Math.min(3, state.marketState.failures - 1)));
      notice.textContent = (error.message || 'Could not refresh quotes.') + ' Previous data kept.';
      notice.hidden = false;
    }
  } finally {
    state.marketState.refresh = null;
    renderMarket(true); marketScheduleRefresh();
  }
}

export function renderMarket(preservePosition = false) {
  const section = document.getElementById('marketSection');
  const oldTable = preservePosition ? section.querySelector('.market-table-wrap') : null;
  const position = oldTable ? {top:oldTable.scrollTop, left:oldTable.scrollLeft} : null;
  const focused = preservePosition && section.contains(document.activeElement) ? document.activeElement : null;
  const focusAttribute = focused ? [...focused.attributes].find(attr => attr.name.startsWith('data-market-')) : null;
  const focusContainer = focused?.closest('#marketContent, #marketStats, #marketPeriods, #marketBreadcrumb');
  const ms = state.marketState, period = ms.period;
  const isTheme = ms.category === 'themes';
  const category = MARKET_CATEGORIES.find(item => item.id === ms.category);
  const columns = marketColumns();
  const unit = isTheme ? 'stock' : 'ETF';
  MARKET_CATEGORIES.forEach(item => {
    const tab = document.getElementById('marketTab-' + item.id), active = item.id === ms.category;
    tab.setAttribute('aria-selected', String(active)); tab.setAttribute('tabindex', active ? '0' : '-1');
    const count = item.id === 'themes' ? MarketData.groups(ms.stocks).length : ms.etfs.filter(row => row.category === item.id).length;
    tab.innerHTML = marketEscape(item.name) + (count ? '<small aria-hidden="true">' + count + '</small>' : '');
  });
  document.getElementById('marketPanel').setAttribute('aria-labelledby', 'marketTab-' + ms.category);
  document.getElementById('marketScope').hidden = !isTheme;
  document.getElementById('marketSearch').placeholder = isTheme ? 'Search ticker, company or industry' : 'Search ticker or fund name';
  document.getElementById('marketFootnote').innerHTML = isTheme
    ? 'Groups are equally weighted. Missing returns are excluded.<br>Open a group to explore its stocks. Select a ticker to size a trade.'
    : 'From open measures the change from the session open. 1Y is the reference’s Perf Year, separate from YTD.<br>Select a ticker to size a trade.';
  const download = document.getElementById('marketDownload');
  download.href = isTheme ? MARKET_FILE : MARKET_ETF_FILE;
  download.textContent = isTheme ? 'Download stock universe CSV ↗' : 'Download all ETF universes CSV ↗';
  const source = document.getElementById('marketSource');
  const content = document.getElementById('marketContent');
  marketRenderRefreshStatus();
  content.setAttribute('aria-busy', String(ms.loading));
  if (!ms.stocks.length) {
    source.textContent = 'Universe exported Sep 16, 2026';
    content.innerHTML = ms.error
      ? '<div class="market-empty">' + marketEscape(ms.error) + '<br><button class="btn" data-market-retry>Retry loading</button></div>'
      : '<div class="market-empty"><span class="spinner"></span> Loading market data…</div>';
    return;
  }
  const rows = marketRows(), groups = isTheme ? MarketData.groups(rows) : [];
  const query = document.getElementById('marketSearch').value;
  const isGroups = isTheme && ms.scope === 'groups';
  const universe = isGroups ? groups : ms.group ? rows.filter(row => row.group === ms.group) : rows;
  const filtered = MarketData.sort(MarketData.filter(universe, query), ms.sort === 'ticker' ? 'ticker' : period, ms.direction);
  const visible = isGroups ? filtered : filtered.slice(0, ms.limit);
  const up = universe.filter(row => row.returns[period] > 0).length;
  const down = universe.filter(row => row.returns[period] < 0).length;
  const ranked = MarketData.sort(universe.filter(row => row.returns[period] !== null), period, 'desc');
  const leader = ranked[0], laggard = ranked[ranked.length - 1];
  const stat = (label, value, note, tone = '', action = '') => '<' + (action ? 'button type="button" ' + action : 'div') + ' class="market-stat">'
    + '<span class="market-stat-label">' + label + '</span><span class="market-stat-value ' + tone + '">' + value + '</span><span class="market-stat-note">' + marketEscape(note) + '</span></' + (action ? 'button' : 'div') + '>';
  const action = row => isGroups ? 'data-market-group="' + marketEscape(row.name) + '"' : 'data-market-ticker="' + marketEscape(row.ticker) + '"';
  document.getElementById('marketStats').innerHTML =
    stat(ms.group ? 'Group universe' : isTheme ? 'Tracked universe' : category.name, (isGroups ? rows.length : universe.length).toLocaleString(), isGroups ? groups.length + ' industry groups' : ms.group || (isTheme ? 'Across all industry groups' : category.description))
    + stat((isGroups ? 'Groups' : isTheme ? 'Stocks' : 'ETFs') + ' · ' + MARKET_PERIODS[period], '<span class="market-positive">' + up + ' ↑</span> <span class="market-negative">' + down + ' ↓</span>', 'Advancing / declining')
    + (leader ? stat('Leading · ' + MARKET_PERIODS[period], marketPct(leader.returns[period]), leader.ticker || leader.name, marketTone(leader.returns[period]), action(leader)) : stat('Leading', '—', 'No returns available'))
    + (laggard ? stat('Lagging · ' + MARKET_PERIODS[period], marketPct(laggard.returns[period]), laggard.ticker || laggard.name, marketTone(laggard.returns[period]), action(laggard)) : stat('Lagging', '—', 'No returns available'));
  [['marketGroupsBtn', isGroups], ['marketStocksBtn', !isGroups], ['marketTableBtn', ms.display === 'table'], ['marketHeatmapBtn', ms.display === 'heatmap']].forEach(([id, active]) => {
    const button = document.getElementById(id); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  document.getElementById('marketClearBtn').hidden = !query;
  document.getElementById('marketPeriods').innerHTML = columns.map(i => '<button class="' + (period === i ? 'active' : '') + '" aria-pressed="' + (period === i) + '" title="' + marketEscape(marketPeriodHelp(i)) + '" data-market-period="' + i + '">' + MARKET_PERIODS[i] + '</button>').join('');
  document.getElementById('marketBreadcrumb').innerHTML = (ms.group ? '<button data-market-home>All groups</button><span class="market-neutral">/</span>' : '')
    + '<strong>' + marketEscape(ms.group || (isTheme ? isGroups ? 'Industry groups' : 'All stocks' : category.name)) + '</strong><span class="market-count">' + filtered.length.toLocaleString() + (isGroups ? ' group' : ' ' + unit) + (filtered.length === 1 ? '' : 's') + (query ? ' found' : '') + '</span>';
  const coverageText = (row, i) => isGroups ? row.coverage[i] + '/' + row.count + ' stocks with returns' : '';
  if (!visible.length) {
    content.innerHTML = '<div class="market-empty">No matches for “' + marketEscape(query) + '”.<br><button class="btn" data-market-clear>Clear search</button></div>';
  } else if (ms.display === 'heatmap') {
    // Log scaling preserves differences between small moves without letting outliers wash out the map.
    const max = Math.max(1, ...filtered.map(row => Math.abs(row.returns[period] || 0)));
    content.innerHTML = '<div class="market-grid">' + visible.map(row => {
      const value = row.returns[period];
      const strength = value === null ? 0 : Math.log1p(Math.abs(value)) / Math.log1p(max);
      const bg = value === null || value === 0 ? 'var(--bg3)' : 'hsl(' + (value > 0 ? '151' : '350') + ' 42% ' + (13 + strength * 18).toFixed(1) + '%)';
      const label = isGroups ? row.name : row.ticker;
      return '<button class="market-tile" style="background:' + bg + '" ' + action(row) + ' title="' + marketEscape((isGroups ? row.name : row.name + ' · Size this trade') + ' · ' + coverageText(row, period)) + '">'
        + '<span class="market-tile-name">' + marketEscape(label) + '</span><span class="market-tile-bottom"><small>' + (isGroups ? row.count + ' stocks' : 'Size trade ↗') + '</small><strong>' + marketPct(value) + '</strong></span></button>';
    }).join('') + '</div>';
  } else {
    content.innerHTML = '<div class="market-table-wrap"><table class="market-table' + (isTheme ? '' : ' market-etf-table') + '" aria-label="' + (isGroups ? 'Industry group' : isTheme ? 'Stock' : category.name) + ' performance"><thead><tr><th scope="col"' + (ms.sort === 'ticker' ? ' aria-sort="' + (ms.direction === 'asc' ? 'ascending' : 'descending') + '"' : '') + '><button data-market-ticker-sort>' + (isGroups ? 'Industry group' : isTheme ? 'Ticker / company' : 'Ticker / fund') + (ms.sort === 'ticker' ? ms.direction === 'asc' ? ' ↑' : ' ↓' : '') + '</button></th>'
      + columns.map(i => '<th scope="col"' + (ms.sort === 'performance' && period === i ? ' aria-sort="' + (ms.direction === 'desc' ? 'descending' : 'ascending') + '"' : '') + '><button title="' + marketEscape(marketPeriodHelp(i) + ' Click to sort; click again to reverse.') + '" data-market-sort="' + i + '">' + MARKET_PERIODS[i] + (ms.sort === 'performance' && period === i ? ms.direction === 'desc' ? ' ↓' : ' ↑' : '') + '</button></th>').join('')
      + '</tr></thead><tbody>' + visible.map(row => '<tr><td class="market-name"><button ' + action(row) + ' title="' + (isGroups ? 'Open group' : 'Size this trade') + '"><span class="' + (!isGroups ? 'market-stock-symbol' : '') + '">' + marketEscape(isGroups ? row.name : row.ticker) + '</span><small>' + marketEscape(isGroups ? row.count + ' stocks' : row.name) + '</small></button></td>'
        + columns.map(i => '<td class="' + marketTone(row.returns[i]) + (period === i ? ' market-selected-period' : '') + '" title="' + coverageText(row, i) + '">' + marketPct(row.returns[i]) + (isGroups && row.coverage[i] < row.count ? '<sup aria-label="Partial coverage">*</sup>' : '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  }
  document.getElementById('marketMoreBtn').hidden = visible.length >= filtered.length;
  document.getElementById('marketMoreBtn').textContent = 'Show more · ' + visible.length + ' of ' + filtered.length.toLocaleString();
  if (focusAttribute && focusContainer) {
    // Row order may change with prices; restore focus by ticker/group, not row index.
    const target = [...focusContainer.querySelectorAll('[' + focusAttribute.name + ']')].find(element => element.getAttribute(focusAttribute.name) === focusAttribute.value);
    target?.focus({preventScroll:true});
  }
  const table = position ? section.querySelector('.market-table-wrap') : null;
  if (table) { table.scrollTop = position.top; table.scrollLeft = position.left; }
}

// delegated listeners for the Market view, attached once at boot
export function initMarketEvents() {
  document.getElementById('marketSection').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const data = button.dataset;
    if (data.marketCategory !== undefined) marketSetCategory(data.marketCategory);
    else if (data.marketTickerSort !== undefined) marketSortTicker();
    else if (data.marketGroup !== undefined) marketOpenGroup(data.marketGroup);
    else if (data.marketTicker !== undefined) marketSizeTrade(data.marketTicker);
    else if (data.marketPeriod !== undefined) marketSetPeriod(+data.marketPeriod, false);
    else if (data.marketSort !== undefined) marketSetPeriod(+data.marketSort, true);
    else if (data.marketHome !== undefined) marketSetScope('groups');
    else if (data.marketClear !== undefined) marketClearSearch();
    else if (data.marketRetry !== undefined) loadMarket();
  });
  document.getElementById('marketTabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = MARKET_CATEGORIES.findIndex(item => item.id === state.marketState.category);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? MARKET_CATEGORIES.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + MARKET_CATEGORIES.length) % MARKET_CATEGORIES.length;
    event.preventDefault();
    marketSetCategory(MARKET_CATEGORIES[next].id);
    document.getElementById('marketTab-' + state.marketState.category).focus();
  });
}

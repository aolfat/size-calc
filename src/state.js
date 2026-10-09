// All mutable app state lives here, one object instead of loose globals.
// UI modules read and write state.* directly; tests call resetState() for a clean slate.
import { store } from './lib/store.js';

export const DAILY_RANGES = [21, 63, 126, 252]; // 1M / 3M / 6M / 1Y range chips, in sessions

export function createState() {
  const dailyRange = DAILY_RANGES.includes(+store.get('daily_range')) ? +store.get('daily_range') : 63;
  return {
    quoteData: null,
    chainData: [],
    selectedExp: null,
    currentMode: 'shares',
    direction: 'long',
    sizingMode: 'risk',
    optionTradeSide: 'buy',
    exposureBySymbol: Object.create(null),
    chartBars: [],
    chartHover: -1,
    chartHoverY: -1,
    errorTimer: null,
    simState: null,
    simHover: -1,
    simHoverY: -1,
    simReg: {}, // chain detail rows park their sim params here by option symbol
    session: null, // the signed-in Supabase session, or null
    supabase: null, // the Supabase client, created on first use (tests put a fake here)
    supabaseLoading: null, // the one in-flight library load
    cloudSuppress: false, // true while applying server data or restoring storage, so those writes aren't edits
    cloudBusy: false, // the running push, pull or merge (a promise), or false
    cloudTimer: null,
    cloudPending: new Set(), // account keys changed here since the last successful push (persisted)
    signOutArmed: false, // a second Sign out discards edits that couldn't be sent
    quoteRequestId: 0, // bumped per Load: only the latest Load applies its answer and owns the spinner
    openSheetName: null,
    sheetOpener: null,
    quickOpen: false,
    flashNext: false,
    editingUsd: false,
    futuresDirection: 'long',
    stopStrategy: 'none',
    stopPercent: 0.05,
    atrMultiplier: 0,
    atr5: null, // { symbol, value, asOf }: completed native five-minute bars only
    marketState: {
      stocks: [], etfs: [], category: 'themes', loading: false, error: '', scope: 'groups', group: '', display: 'table',
      period: 2, sort: 'performance', direction: 'desc', limit: 100, snapshots: Object.create(null), quoteMode: true,
      environment: '', key: '', refresh: null, timer: null, auto: store.get('market_auto_refresh') !== '0',
      failures: 0, retryAt: 0, authBlocked: false,
    },
    positionsView: false,
    utilsView: false,
    marketView: false,
    levDir: 'both', // both | long | short — a display filter, re-renders the last result
    levLast: null,
    chartInterval: parseInt(store.get('chart_interval')) || 5,
    chartRequestId: 0,
    adrValue: 0,
    prevDay: null, // { h, l, c } of the last completed session
    hv20: 0, // annualized 20-day historical volatility
    hvDist: [], // rolling HV20 over the past year, for the IV percentile
    dailyBars: [], // full history incl. today's forming bar, for the daily chart
    showDaily: true,
    dailyRange, // the chosen range chip
    dailyView: { count: dailyRange, offset: 0 }, // what's on screen, after pinches and drags
    dailySymbol: '', // the view resets when this changes
    dailyHover: -1,
    dailyHoverY: -1,
    liveInterval: null,
    liveCountdown: null,
    liveEnd: 0,
    liveTicks: 0,
    livePolling: false,
    liveModeIdx: 0,
    livePausedRemaining: 0,
    allExps: [],
    expsExpanded: false,
    chainLoading: false,
    chainLoadingFor: '',
    chainRequestId: 0,
    pendingAtmScroll: false, // set on user-driven chain loads, never on live polls
    chainSide: 'both',
    zoneMode: 'otm',
    zoneFilter: { otm: true, itm: false },
    railDetailSym: null,
    pinnedData: {},
    positions: null, // the last Schwab read: positionRows() plus { orders, last4, asOf, stopsMissing }
    positionsError: '',
    positionsBusy: false,
    positionsRequest: 0, // bumped per read, so a late answer for an old account is dropped
    positionsTimer: null,
    posTicket: null, // the position order the review sheet shows, frozen when it opens
    posTradeBusy: false,
    posLast: null, // { symbol, at, confirmed } of the last position order; unconfirmed blocks a repeat for a while
    cancelTicket: null, // the working-order cancel the review sheet shows, frozen when it opens
    posChart: null, // the open position chart: { symbol, bars, view, range, loading, error, hover, hoverY, price, qty } (price and qty = the target form)
    detailReg: {}, // full calcOpt results by OCC symbol, for spread legs
    spreadPending: null,
    spreadPendingCredit: false,
    schwabRefreshing: null, // the one in-flight token refresh, shared by concurrent calls
    acctSizeBusy: false, // the daily account size read is in flight
    tradeTicket: null, // the order the review sheet shows, frozen when it opens; that exact payload is what gets sent
    tradeBusy: false,
    tradeLast: null, // { symbol, at } of the last order placed, to flag a quick repeat
  };
}

export const state = createState();

// tests start each case from a clean slate
export function resetState() {
  Object.assign(state, createState());
}

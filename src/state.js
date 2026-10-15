// All mutable app state lives here, one object instead of loose globals.
// UI modules read and write state.* directly; tests call resetState() for a clean slate.
import { store } from './lib/store.js';

export const DAILY_RANGES = [21, 63, 126, 252]; // 1M / 3M / 6M / 1Y range chips, in sessions

export function createState() {
  const dailyRange = DAILY_RANGES.includes(+store.get('daily_range')) ? +store.get('daily_range') : 63;
  let posCols = [];
  try { posCols = JSON.parse(store.get('positions_cols') || '[]'); } catch(e) {}
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
    sessionResuming: false, // a stored session is being read back (boot, or the poll's retry)
    authSubscription: null, // observes sign-out and user changes from other tabs
    signingOut: false, // the explicit sign-out owns cleanup and reload while Supabase emits SIGNED_OUT
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
    journalView: false,
    journalRecords: null, // the kept Schwab records, newest first, once read
    journalLoading: false,
    journalError: '',
    barsBusy: false, // the journal is saving 5-minute bars
    journalReview: null, // reviews once read: { reviews: key → { setup_grade, plan_followed, note, market, reviewed_at }, labels: key → [{ kind, value, set_by }], days: day → { market, note }, library: rows }
    journalReviewError: '', // the review tables couldn't be read (the migration not pushed yet, say)
    journalSetupFilter: '', // the list, calendar and stats narrowed to trades with this setup (its key)
    journalReviewFilter: 'all', // the trades tab: all | todo (to review)
    reviewMarketOwn: false, // the market chips set this trade's own market, not the day's
    journalShots: null, // your screenshots once read: [{ id, trade_key, path, caption, width, height, bytes, created_at }]
    journalShotsError: '', // they couldn't be read (the migration not pushed yet, say)
    journalShotUrls: {}, // path → signed link (an hour)
    shotsBusy: 0, // screenshots being shrunk and kept
    shotView: null, // the screenshot open in the viewer (its id)
    shotDeleteArmed: false, // Delete was tapped once: the next tap deletes
    setupDraft: null, // + New setup being made: { action, levels, pattern, name }
    reviewLinkDraft: '', // a link being pasted under Option flow
    reviewNewKind: '', // + New is open for this kind
    reviewNewName: '', // what's typed in it
    reviewNoteDraft: null, // { key, text }: the note being typed, so a redraw never loses it
    journalDeck: null, // the review deck: { keys (the queue when it started, oldest first), at, seen, shown (P&L revealed), finished }
    journalTrade: null, // the trade page open in the Journal: { key, five, daily, view5, viewD, loading/status per chart, hover }
    journalTab: 'trades', // trades | calendar | stats | books | fills
    modelBooks: {
      owner: '', loading: false, pending: null, loaded: false, error: '',
      books: [], examples: [], urls: {}, bookId: '', setupKey: '', mode: 'books',
      draft: null, bookDraft: null, busy: false, preparing: false, deleteKey: '',
      viewerId: '', signing: false, imageError: '',
    },
    journalDay: '', // the trades tab narrowed to one day picked on the calendar ('YYYY-MM-DD', New York)
    journalMonth: '', // the calendar's month, 'YYYY-MM'; empty = the newest with closed trades
    journalMonthShown: '', // the month the calendar last showed (‹ › step from it)
    journalPeriod: 'all', // the stats cover: all | day | week | month
    journalPeriodKey: '', // which one: 'YYYY-MM-DD' (a week = its Monday) or 'YYYY-MM'; empty = the newest with closed trades
    journalPeriodShown: '', // the period the stats last showed (‹ › step from it)
    journalSide: 'all', // all | long | short
    journalSymbol: '', // symbol filter, typed
    tradeReviews: null, // your word on each trade, by trade key: { stop, deleted }, once read
    journalSaved: [], // the trades you shaped (merged trades, spreads, legs kept apart): trades rows, { id, account, fill_ids, created_at }
    journalSavedError: '', // the trades table couldn't be read (no migration yet): trades show as the app groups them, merging is off
    journalPicked: [], // trade keys ticked for Merge
    journalMerging: false, // a merge or separate is being saved
    tradeReviewsError: '', // the reviews couldn't be read (the trades still show, with Schwab's stops)
    journalShowDeleted: false, // deleted trades shown, dimmed, to restore one
    tradeReviewKey: null, // the trade open in the trade sheet
    journalUndo: null, // the review rows that put the last delete back (Undo on its toast)
    tradeReviewBusy: false, // a save is on its way
    tradeReviewError: '',
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
    positions: null, // the last Schwab read: positionRows() plus { hash, orders, last4, asOf, stopsMissing }
    positionsError: '',
    positionsBusy: false, // the read in flight (a promise resolving to the newest read), or false
    positionsRequest: 0, // bumped per read, so a late answer for an old account is dropped
    positionsTimer: null,
    posTicket: null, // the position order the review sheet shows, frozen when it opens
    posTradeBusy: false,
    posLast: null, // { hash, symbol, at, confirmed } of the last position order; unconfirmed blocks a repeat on that account and symbol for a while
    cancelTicket: null, // the working-order cancel the review sheet shows, frozen when it opens
    editTicket: null, // the working-order change the review sheet shows, re-planned as the form changes
    posCols: Array.isArray(posCols) ? posCols : [], // the optional Positions columns picked (positions_cols, this device only)
    posColsOpen: false, // the Columns picker showing
    posHideValue: store.get('positions_hide_value') === '1', // account value and cash masked in the Positions header
    posChartAvg: store.get('pos_chart_avg') !== '0', // the position chart draws your average cost (pos_chart_avg, this device only)
    posChart: null, // the open position chart: { symbol, option, label, bars, view, range, loading, error, hover, hoverY, price, qty } (range: sessions; price and qty = the target form)
    detailReg: {}, // full calcOpt results by OCC symbol, for spread legs
    spreadPending: null,
    spreadPendingCredit: false,
    schwabRefreshing: null, // the one in-flight token refresh, shared by concurrent calls
    schwabCallbackTimer: null, // asks the worker for its callback once the URL stops changing
    historyBusy: false, // the journal spike's Schwab history export is reading
    captureBusy: false, // raw capture is reading Schwab and saving to Supabase
    captureError: '', // the last capture's failure, shown on its status line
    schwabProxyEditing: false, // Change pressed: the worker URL box stays open until you leave it
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

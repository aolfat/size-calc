// All mutable app state lives here, one object instead of loose globals.
// UI modules read and write state.* directly; tests call resetState() for a clean slate.
import { store } from './lib/store.js';

export const DAILY_RANGES = [21, 63, 126, 252]; // 1M / 3M / 6M / 1Y range chips, in sessions

export function createState() {
  const dailyRange = DAILY_RANGES.includes(+store.get('daily_range')) ? +store.get('daily_range') : 63;
  let posCols = [];
  try { posCols = JSON.parse(store.get('positions_cols') || '[]'); } catch(e) {}
  let journalHidden = [];
  try { journalHidden = JSON.parse(store.get('journal_hidden_cols') || '[]'); } catch(e) {}
  return {
    quoteData: null,
    chainData: [],
    selectedExp: null,
    currentMode: 'shares',
    timeZone: store.get('time_zone') === 'pt' ? 'pt' : 'et', // the zone clock times show in (lib/zone.js), this device only
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
    cloudKeyAsked: null, // the user whose Vault key this page load already asked for (a device without one asks once)
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
      history: Object.create(null), // ticker → { day, refs, last }: daily-close references for 1W–1Y, read once a New York day
      historyJob: null, // { controller, scope, done, total } while a scope's daily history loads
      historyRetryAt: 0, historyError: '',
    },
    positionsView: false,
    utilsView: false,
    journalView: false,
    journalRecords: null, // the kept Schwab records, newest first, once read
    journalLoading: false,
    journalError: '',
    barsBusy: false, // the journal is saving 5-minute bars
    featureStamps: null, // trade key → { feature key → { v, value, note } }: the trade features stamped (trade_features), once read
    featuresOwner: '', // whose stamps those are
    featuresError: '', // they couldn't be read (the table not pushed yet): nothing is stamped, the Journal works
    featuresBusy: false, // a stamping run is going
    featuresProgress: null, // { done, total, features } while it goes
    featuresLast: null, // the last run here: { user, at, value, unknown, waiting, error, sig (what was still due) }
    featureWaits: {}, // trade key → { feature key → what it waits for }, from the last run
    journalReview: null, // reviews once read: { reviews: key → { setup_grade, plan_followed, note (the exit note), entry_note, market, reviewed_at }, labels: key → [{ kind, value, set_by }], days: day → { market, note }, library: rows }
    journalReviewError: '', // the review tables couldn't be read (the migration not pushed yet, say)
    journalSetupKey: '', // the setup whose page the Setups tab shows ('' = every setup)
    journalSetupFilter: '', // the list, calendar and stats narrowed to trades with this setup (its key)
    journalReviewFilter: 'all', // the trades tab's review chips: all | todo (to review) | done (reviewed) | untagged (no setup)
    claudeKeys: null, // your Claude access keys once read (Settings): [{ id, label, created_at, last_used_at }]
    claudeKeysError: '', // they couldn't be read (the migration not pushed yet, say)
    claudeNewKey: '', // a key just made, shown once until a sheet opens or closes
    claudeBusy: false, // Make key is saving
    reviewMarketOwn: false, // the market chips set this trade's own market, not the day's
    journalShots: null, // your screenshots once read: [{ id, trade_key, path, caption, width, height, bytes, created_at }]
    journalShotsError: '', // they couldn't be read (the migration not pushed yet, say)
    journalShotUrls: {}, // path → signed link (an hour)
    shotsBusy: 0, // screenshots being shrunk and kept
    shotView: null, // the screenshot open in the viewer (its id)
    shotDeleteArmed: false, // Delete was tapped once: the next tap deletes
    shotUndo: '', // the screenshot last X'd off, for the toast's Undo
    setupDraft: null, // + New setup open: { action, levels, pattern, key (the setup it put on the trade), made (the one it made, while only it uses it) }
    setupEdit: null, // one of My setups being edited in Edit choices: { key ('' for + New setup), action, levels, pattern, name, follow (the name tracks the parts), missed ({ id, symbol }: made for that missed trade) }
    libraryNew: null, // + New open in that builder: { kind (level, action or pattern), name, short }
    reviewLinkDraft: '', // a link being pasted under Option flow
    reviewNewKind: '', // + New is open for this kind
    reviewNewName: '', // what's typed in it
    reviewNewShort: '', // and its words on a short (an action or pattern)
    reviewSearch: { setup: '', tactic: '' }, // what's typed in the trade page's setup and tactic searches
    reviewNoteDraft: null, // { key, which: 'entry' | 'exit', text }: the note being typed, so a redraw never loses it
    journalDeck: null, // the review deck: { keys (the queue when it started, oldest first), at, seen, shown (P&L revealed), finished }
    journalTrade: null, // the trade page open in the Journal: { key, five, daily, viewD, loading/status per chart, charts }
    chartLib: null, // Lightweight Charts once loaded (the trade page's charts), or null
    chartLibLoading: null, // the one in-flight library load
    journalHiddenCols: Array.isArray(journalHidden) ? journalHidden : [], // the trades table's columns you hid (journal_hidden_cols, this device only)
    journalColsOpen: false, // the trades table's Columns picker showing
    journalTab: 'trades', // trades | calendar | stats | setups | books | features | fills
    modelBooks: {
      owner: '', loading: false, pending: null, loaded: false, error: '',
      books: [], examples: [], urls: {}, bookId: '', setupKey: '', mode: 'books',
      draft: null, bookDraft: null, busy: false, preparing: false, deleteKey: '',
      viewerId: '', signing: false, imageError: '',
    },
    journalDay: '', // the trades tab narrowed to one day picked on the calendar ('YYYY-MM-DD', New York)
    journalNotebookDay: '', // the day's notebook page open in the Calendar tab ('YYYY-MM-DD', New York; docs/journal-notebook.md)
    notebookDraft: null, // { day, field, text }: a notebook box being typed, saved on blur
    notebookEdit: '', // goal | rule: that list open in place to edit
    notebookItemDraft: '', // the new goal or rule being typed
    missedDraft: '', // the ticker of a missed trade being typed
    missedOpen: '', // the id of the missed trade open to edit
    missedNewTactic: '', // the missed trade whose + New tactic box is open
    missedTacticDraft: '', // the tactic's name being typed there
    missedUndo: null, // { day, list }: the missed trades before the last Remove, for the toast's Undo
    missedChart: null, // the open missed trade's (or focus ticker's) charts: { symbol, day, mark, five, daily, charts, ... } (ui/missed-chart.js)
    focusDraft: '', // the ticker being typed into the day's focus list
    focusOpen: '', // the id of the focus ticker open to edit (a missed trade and a focus ticker are never open at once)
    focusUndo: null, // { day, list }: the focus list before the last Remove, for the toast's Undo
    journalMonth: '', // the calendar's month, 'YYYY-MM'; empty = the newest with closed trades
    journalMonthShown: '', // the month the calendar last showed (‹ › step from it)
    journalReviewPeriod: null, // the week or month review open under the calendar: { unit: 'week' | 'month', key: its Monday or 'YYYY-MM' }
    journalExcursions: {}, // trade key → { sig, ex }: each closed trade's MFE, MAE and exit efficiency from its saved bars, for the reviews
    periodTradeSort: { by: 'pnl', dir: -1 }, // the week or month review's trade list: 'pnl' | 'pct' | 'r' | 'opened', -1 biggest (newest) first
    periodBarsBusy: false, // a review is reading its trades' bars
    periodReviews: null, // 'week|2026-10-12' or 'month|2026-10' → its period_reviews row (grades, notes, the rules); null until read
    periodReviewsError: '', // why they couldn't be read (the table not pushed yet): the numbers still show, nothing saves
    periodOverallError: '', // why the overall notes (went_well, work_on, note) couldn't be read (their columns not pushed yet): those boxes are off, the rest saves
    periodNoteDraft: null, // { unit, key, field, text }: a part's note, an overall note or the rule for next week being typed, saved on blur
    journalPeriod: 'all', // the stats cover: all | day | week | month
    journalPeriodKey: '', // which one: 'YYYY-MM-DD' (a week = its Monday) or 'YYYY-MM'; empty = the newest with closed trades
    journalPeriodShown: '', // the period the stats last showed (‹ › step from it)
    journalSide: 'all', // all | long | short
    journalSymbol: '', // symbol filter, typed
    tradeReviews: null, // your word on each trade, by trade key: { stop, deleted }, once read
    journalSaved: [], // the trades you shaped (merged trades, spreads, legs kept apart): trades rows, { id, account, fill_ids, created_at }
    journalSavedError: '', // the trades table couldn't be read (no migration yet): trades show as the app groups them, merging is off
    journalPicked: [], // trade keys ticked for Merge
    journalSelecting: false, // phones: Select shows the cards' tick boxes
    journalFiltersOpen: false, // phones: Filters opens the setup, side, fees and Review from row
    journalJustReviewed: '', // a trade reviewed on its page just now: its card pops once on the way back
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
    spreadTicket: null, // the spread close the review sheet shows, frozen when it opens
    cancelTicket: null, // the working-order cancel the review sheet shows, frozen when it opens
    editTicket: null, // the working-order change the review sheet shows, re-planned as the form changes
    posCols: Array.isArray(posCols) ? posCols : [], // the optional Positions columns picked (positions_cols, this device only)
    posColsOpen: false, // the Columns picker showing
    posLegsOpen: [], // the Positions spreads (SpreadRow keys) showing their legs
    posJournalBusy: false, // the R column's read of the Journal's records, stops and merges in flight (a promise), or false
    posJournalError: '', // that read failed: R counts from the stops working now until a Refresh tries again
    posRTrades: null, // the Journal's trades as the R column last built them: { records, reviews, saved, fees, trades }
    posHideValue: store.get('positions_hide_value') === '1', // account value and cash masked in the Positions header
    posChartAvg: store.get('pos_chart_avg') !== '0', // the position chart draws your average cost (pos_chart_avg, this device only)
    posChart: null, // the open position chart: { symbol, option, label, five, daily, error, price, qty, addStop, addPrice } (five and daily: a pane each, { kind, bars, vwap, view, range, loading, error, hover, hoverY }, range in sessions; price and qty = the target form, addStop and addPrice = Move breakeven's)
    posChartTool: 'target', // what a tap on the position chart sets: 'target' (profit target), 'stop' (a stop to review) or 'add' (Move breakeven's stop); kept while charts open and close
    detailReg: {}, // full calcOpt results by OCC symbol, for spread legs
    spreadPending: null,
    spreadPendingCredit: false,
    schwabRefreshing: null, // the one in-flight token refresh, shared by concurrent calls
    schwabCallbackTimer: null, // asks the worker for its callback once the URL stops changing
    historyBusy: false, // the journal spike's Schwab history export is reading
    captureBusy: false, // raw capture is reading Schwab and saving to Supabase
    tosImport: null, // a thinkorswim statement read for the Import sheet: { name, parsed, zone, matched, checked, busy, error }, until saved or cancelled
    captureError: '', // the last capture's failure, shown on its status line
    schwabProxyEditing: false, // Change pressed: the worker URL box stays open until you leave it
    schwabBannerReady: false, // boot has restored the Google session and finished any Schwab callback: the banner may speak
    schwabBannerHidden: false, // × on the banner: hidden until the app is opened again
    schwabProxyConfirming: null, // Log in pressed once on a worker URL synced from the account: the second press uses it
    acctSizeBusy: false, // the daily account size read is in flight
    tradeTicket: null, // the order the review sheet shows, frozen when it opens; that exact payload is what gets sent
    tradeBusy: false,
    tradeLast: null, // { symbol, at } of the last order placed, to flag a quick repeat
    orb: null, // { symbol, minutes, isLong, high, low, end, entry, stop }: the opening range a chip last set on the ticket
    orbBusy: 0, // the chip whose bars are being read
    orbNote: '', // why the last chip set nothing (range not closed yet, no bars)
  };
}

export const state = createState();

// tests start each case from a clean slate
export function resetState() {
  Object.assign(state, createState());
}

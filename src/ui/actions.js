// The action registry: every data-action / data-input / data-change / data-enter name in the markup
// and in rendered templates maps to one call here. Adapters turn data-arg strings into arguments.
import { store } from '../lib/store.js';
import { growBox } from '../lib/grow.js';
import { state } from '../state.js';
import { cancelModelDraft, closeModelImage, deleteModelBook, deleteModelExample, editModelBook, editModelExample, loadModelBooks, modelBookField, modelExampleField, openModelImage, pasteModelImages, pickModelImage, refreshModelImages, saveModelBook, saveModelExample, selectModelBook, selectModelSetup, setModelBrowse, toggleModelSetup } from './model-books.js';
import { addMissedShots, addTradeShots, closeShotViewer, deleteTradeShot, openShot, removeTradeShot, undoRemoveShot, pasteMissedShot, pasteTradeShot, pickMissedShots, pickTradeShots, saveTradeShotCaption } from './journal-shots.js';
import { setAccountSizeSource } from './account-size.js';
import { allocationChanged, allocationQtyChanged, pinAllocation, setAllocationPct, setOptionTradeSide, setSizingMode } from './allocation.js';
import { pinnedStopChanged, refreshAllPinned, refreshPinned, removePinned } from './cards.js';
import { renderChain, selectExp, setSide, setZoneMode, toggleExps } from './chain.js';
import { setChartInterval } from './chart.js';
import { copyPinned, copyShares } from './copy-text.js';
import { dailyToday, setDailyRange, toggleDaily } from './daily.js';
import { closeDetails } from './detail.js';
import { effects } from './effects.js';
import { setFuturesFees } from './futures.js';
import { toggleLive } from './live.js';
import { marketCancelRefresh, marketClearSearch, marketRefreshToday, marketSearchChanged, marketSetDisplay, marketSetScope, marketShowMore, marketToggleAuto, marketUseSnapshot } from './market.js';
import { closePositionChart, posAddChanged, posChartStopChanged, posChartToday, posTargetChanged, posTargetRChanged, setPosChartRange, setPosChartTool, setPosTargetPortion, setPosTargetR, togglePosChartAvg, togglePositionChart } from './position-chart.js';
import { openOrderCancel, sendOrderCancel, setCancelKeep } from './order-cancel.js';
import { openOrderEdit, sendOrderEdit, setEditDuration, setEditPrice, setEditQty, setEditStop } from './order-edit.js';
import { openSpreadClose, placeSpreadClose, setSpreadCloseDuration, setSpreadClosePortion, setSpreadClosePrice, setSpreadCloseQty, setSpreadCloseType } from './spread-close.js';
import { openPositionTrade, placePositionTrade, setClosePortion, setClosePrice, setCloseQty, setCloseR, setCloseRText, setCloseType, setPositionBeMode, setPositionStopAt, setPositionStopDuration, setPositionStopPrice } from './position-trade.js';
import { refreshPositions, togglePosColumn, togglePosColumnsMenu, togglePosHideValue, togglePosLegs } from './positions.js';
import { simPosition } from './position-sim.js';
import { fetchQuickOption, parseQuick, toggleQuick } from './quick-lookup.js';
import { recalcAll, setRiskPct, setRiskUsd, syncFromDollar, toggleUsdEdit } from './risk.js';
import { saveKey, setTimeZone, signIn, signOut } from './settings.js';
import { copyClaudeKey, makeClaudeAccessKey, revokeClaudeAccessKey } from './claude-access.js';
import { closePeriodReview, openPeriodReview, periodTextInput, periodTextSave, setPeriodGrade, setPeriodTradeSort, setRuleKept, stepPeriodReview } from './journal-week.js';
import { clearJournalDay, closeJournalSetup, journalThisMonth, openJournalSetup, openJournalStats, showSetupIn, pickJournalDay, setJournalPeriod, setJournalReviewFilter, setJournalSetupFilter, shiftJournalMonth, stepJournalPeriod } from './journal.js';
import { clearTosStatement, pickTosStatement, saveTosStatement, setTosZone, tosStatementChosen } from './journal-tos.js';
import { closeJournalTrade, editJournalTrade, journalPageTrade, stepJournalTrade, setJournalChartKind, setJournalInterval, setJournalRange, setJournalTradeTab, toggleJournalLog } from './journal-trade.js';
import { toggleTradeFeatures } from './journal-features.js';
import { addMissedTactic, addMissedTrade, openMissedOnDay, cancelMissedTactic, missedTacticInput, newMissedSetup, startMissedTactic, addNotebookItem, closeJournalDay, daySleepSave, dayTextInput, dayTextSave, editNotebookList, missedInput, missedNoteInput, missedNoteSave, moveNotebookItem, notebookItemInput, openJournalDay, openMissedTrade, openTodayNotebook, removeMissedTrade, renameNotebookItem, retireNotebookItem, setDayEnergy, setDayFocusKept, setDayGrade, setDayMarket, setDayPlace, setDayRule, toggleMissedSetup, setMissedSide, toggleMissedTactic, setMissedWhy, stepJournalDay, toggleDayFeeling, toggleWokeEarly, undoRemoveMissed, addFocusTicker, focusInput, focusNoteInput, focusNoteSave, newFocusSetup, openFocusTicker, removeFocusTicker, setFocusPlayed, setFocusSide, toggleFocusSetup, undoRemoveFocus } from './journal-notebook.js';
import { deckBack, deckNext, endReviewDeck, revealDeckPnl, reviewSkipped, setDeckPnl, setReviewFrom, startReviewDeck, toggleDeckWeekly } from './journal-deck.js';
import { addLibraryChoice, useSetupTwin, addReviewLink, cancelLibraryChoice, cancelSetupEdit, editSetup, newLibrarySetup, startLibraryChoice, mergeEditedSetup, saveSetupEdit, setEditAction, setEditPattern, setupEditNameInput, toggleEditLevel, removeReviewLink, reviewLinkInput, cancelReviewItem, cancelSetupDraft, setDraftAction, setDraftPattern, startSetupDraft, toggleDraftLevel, toggleSetup, mergeLibraryItem, mergeTwin, setLibraryShort, openJournalLibrary, renameLibraryItem, reviewNoteInput, reviewNoteSave, reviewSearchInput, reviewSearchPick, saveReviewItem, setPlanFollowed, setReviewMarket, setSetupGrade, startReviewItem, toggleLibraryHidden, toggleReviewLabel, toggleReviewMarketOwn } from './journal-review.js';
import { clearJournalPicks, clearTradeStop, combineTrade, deletePicked, deleteTrade, journalImport, journalSymbolChanged, mergePicked, openJournalExport, openJournalImport, openTradeReview, openTradeRow, pickTradeStop, restoreTrade, saveTradeStop, separateTrade, setJournalFees, setJournalSide, setJournalTab, splitSpread, toggleDeletedTrades, toggleJournalColumn, toggleJournalColumnsMenu, toggleJournalFilters, toggleJournalPick, toggleJournalSelect, tradeStopPreview, undoDeleteTrades } from './journal.js';
import { downloadSchwabHistory } from './schwab-history.js';
import { sharePinned, shareShares } from './share-image.js';
import { contractsQtyChanged, renderShares, sharesQtyChanged } from './shares.js';
import { closeSheet, openSheet } from './sheets.js';
import { toggleKbdHelp } from './shortcuts.js';
import { closeSim, drawSim, simFromPinned, simPriceTyped, simSetPrice } from './sim.js';
import { cancelSpread, startSpread } from './spreads.js';
import { jumpTo } from './sticky-bar.js';
import { setAtrMultiplier, setDirection, setStopPercent, setStopStrategy, stopsChanged } from './stops.js';
import { loadTicker, refreshQuote, submitTicker, tickerInputChanged } from './ticker.js';
import { findLevEtfs, levLoad, levTarget, renderGain, setLevDir } from './tools.js';
import { setOrb } from './orb.js';
import { checkTradeStatus, connectSchwab, disconnectSchwab, finishSchwab, hideSchwabBanner, schwabBannerLogin, openTrade, placeTrade, reloadSchwabAccounts, schwabAccountChanged, schwabProxyChanged, schwabProxyDone, editSchwabProxy, setTradeEntryLimit, setTradeEntryType, setTradeLimit, setTradeStopDuration } from './trade.js';
import { setMode, setView } from './views.js';

const arg = el => el.dataset.arg || '';
/** run a Review action on the trade open on the Journal's trade page */
const withPageTrade = fn => { const t = journalPageTrade(); return t ? fn(t) : undefined; };
const num = el => Number(el.dataset.arg);

/** @type {Record<string, import('../lib/delegate.js').Handler>} */
export const actions = {
  // ---------- views and navigation ----------
  setView: el => setView(arg(el)),
  setMode: el => setMode(arg(el)),
  scrollToTop: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
  jumpTo: el => jumpTo(arg(el)),
  toggleKbdHelp: () => toggleKbdHelp(),
  openSheet: el => openSheet(arg(el)),
  closeSheet: () => closeSheet(),

  // ---------- settings: account and key ----------
  saveKey: () => saveKey(),
  signIn: () => signIn(),
  signOut: () => signOut(),
  makeClaudeKey: () => makeClaudeAccessKey(),
  copyClaudeKey: () => copyClaudeKey(),
  revokeClaudeKey: el => revokeClaudeAccessKey(arg(el)),

  // ---------- settings: Schwab login ----------
  schwabProxyChanged: () => schwabProxyChanged(),
  downloadSchwabHistory: () => downloadSchwabHistory(),
  journalImport: () => journalImport(),
  pickTosStatement: () => pickTosStatement(),
  tosStatementChosen: el => tosStatementChosen(/** @type {HTMLInputElement} */ (el)),
  setTosZone: el => setTosZone(/** @type {HTMLSelectElement} */ (el)),
  saveTosStatement: () => saveTosStatement(),
  clearTosStatement: () => clearTosStatement(),
  openJournalImport: () => openJournalImport(),
  openJournalExport: () => openJournalExport(),
  setJournalTab: el => setJournalTab(arg(el)),
  loadModelBooks: () => loadModelBooks(),
  selectModelBook: el => selectModelBook(arg(el)),
  selectModelSetup: el => selectModelSetup(arg(el)),
  setModelBrowse: el => setModelBrowse(arg(el)),
  editModelBook: el => editModelBook(arg(el)),
  modelBookField: el => modelBookField(arg(el), /** @type {HTMLInputElement} */ (el).value),
  saveModelBook: () => saveModelBook(),
  deleteModelBook: el => deleteModelBook(arg(el)),
  cancelModelDraft: () => cancelModelDraft(),
  pickModelImage: () => pickModelImage(),
  modelImagePicked: el => { const input = /** @type {HTMLInputElement} */ (el); const result = pasteModelImages(input.files); input.value = ''; return result; },
  editModelExample: el => editModelExample(arg(el)),
  modelExampleField: el => modelExampleField(arg(el), /** @type {HTMLInputElement} */ (el).value),
  toggleModelSetup: el => toggleModelSetup(arg(el)),
  saveModelExample: () => saveModelExample(),
  deleteModelExample: el => deleteModelExample(arg(el)),
  refreshModelImages: () => refreshModelImages(),
  openModelImage: el => openModelImage(arg(el)),
  closeModelImage: () => closeModelImage(),
  pickJournalDay: el => pickJournalDay(arg(el)),
  // ---------- the notebook: a page per trading day ----------
  openJournalDay: el => openJournalDay(arg(el)),
  closeJournalDay: () => closeJournalDay(),
  stepJournalDay: el => stepJournalDay(arg(el)),
  openTodayNotebook: () => openTodayNotebook(),
  toggleDayFeeling: el => toggleDayFeeling(arg(el)),
  setDayEnergy: el => setDayEnergy(arg(el)),
  setDayPlace: el => setDayPlace(arg(el)),
  setDayMarket: el => setDayMarket(arg(el)),
  setDayGrade: el => setDayGrade(arg(el)),
  setDayRule: el => setDayRule(arg(el), el.dataset.arg2 || ''),
  setDayFocusKept: el => setDayFocusKept(arg(el)),
  toggleWokeEarly: () => toggleWokeEarly(),
  daySleepSave: el => daySleepSave(/** @type {HTMLInputElement} */ (el).value),
  dayTextInput: el => { growBox(/** @type {HTMLTextAreaElement} */ (el)); dayTextInput(arg(el), /** @type {HTMLTextAreaElement} */ (el).value); },
  dayTextSave: el => dayTextSave(arg(el), /** @type {HTMLTextAreaElement} */ (el).value),
  editNotebookList: el => editNotebookList(arg(el)),
  notebookItemInput: el => notebookItemInput(/** @type {HTMLInputElement} */ (el).value),
  addNotebookItem: el => addNotebookItem(arg(el)),
  renameNotebookItem: el => renameNotebookItem(arg(el), /** @type {HTMLInputElement} */ (el).value),
  moveNotebookItem: el => moveNotebookItem(arg(el), Number(el.dataset.arg2)),
  missedInput: el => missedInput(/** @type {HTMLInputElement} */ (el).value),
  addMissedTrade: () => addMissedTrade(),
  openMissedTrade: el => openMissedTrade(arg(el)),
  openMissedOnDay: el => openMissedOnDay(arg(el), el.dataset.arg2 || ''),
  setMissedSide: el => setMissedSide(arg(el), el.dataset.arg2 || ''),
  setMissedWhy: el => setMissedWhy(arg(el), el.dataset.arg2 || ''),
  toggleMissedSetup: el => toggleMissedSetup(arg(el), el.dataset.arg2 || ''),
  toggleMissedTactic: el => toggleMissedTactic(arg(el), el.dataset.arg2 || ''),
  newMissedSetup: el => newMissedSetup(arg(el)),
  startMissedTactic: el => startMissedTactic(arg(el)),
  cancelMissedTactic: () => cancelMissedTactic(),
  missedTacticInput: el => missedTacticInput(/** @type {HTMLInputElement} */ (el).value),
  addMissedTactic: el => addMissedTactic(arg(el), state.missedTacticDraft || /** @type {HTMLInputElement | null} */ (document.getElementById('nbMissedTactic'))?.value || ''),
  missedNoteInput: el => { growBox(/** @type {HTMLTextAreaElement} */ (el)); missedNoteInput(arg(el), /** @type {HTMLTextAreaElement} */ (el).value); },
  missedNoteSave: el => missedNoteSave(arg(el), /** @type {HTMLTextAreaElement} */ (el).value),
  removeMissedTrade: el => removeMissedTrade(arg(el)),
  undoRemoveMissed: () => undoRemoveMissed(),
  focusInput: el => focusInput(/** @type {HTMLInputElement} */ (el).value),
  addFocusTicker: () => addFocusTicker(),
  openFocusTicker: el => openFocusTicker(arg(el), el.dataset.arg2 || ''),
  setFocusSide: el => setFocusSide(arg(el), el.dataset.arg2 || ''),
  setFocusPlayed: el => setFocusPlayed(arg(el), el.dataset.arg2 || ''),
  toggleFocusSetup: el => toggleFocusSetup(arg(el), el.dataset.arg2 || ''),
  newFocusSetup: el => newFocusSetup(arg(el)),
  focusNoteInput: el => { growBox(/** @type {HTMLTextAreaElement} */ (el)); focusNoteInput(arg(el), el.dataset.arg2 || '', /** @type {HTMLTextAreaElement} */ (el).value); },
  focusNoteSave: el => focusNoteSave(arg(el), el.dataset.arg2 || '', /** @type {HTMLTextAreaElement} */ (el).value),
  removeFocusTicker: el => removeFocusTicker(arg(el)),
  undoRemoveFocus: () => undoRemoveFocus(),
  retireNotebookItem: el => retireNotebookItem(arg(el)),
  clearJournalDay: () => clearJournalDay(),
  shiftJournalMonth: el => shiftJournalMonth(arg(el)),
  journalThisMonth: () => journalThisMonth(),
  setJournalPeriod: el => setJournalPeriod(arg(el)),
  stepJournalPeriod: el => stepJournalPeriod(arg(el)),
  openJournalStats: el => openJournalStats(arg(el), el.dataset.arg2 || ''),
  openJournalSetup: el => openJournalSetup(arg(el)),
  closeJournalSetup: () => closeJournalSetup(),
  showSetupIn: el => showSetupIn(arg(el)),
  openPeriodReview: el => openPeriodReview(arg(el), el.dataset.arg2 || ''),
  closePeriodReview: () => closePeriodReview(),
  stepPeriodReview: el => stepPeriodReview(arg(el)),
  setPeriodGrade: el => setPeriodGrade(arg(el), /** @type {HTMLSelectElement} */ (el).value),
  setRuleKept: el => setRuleKept(arg(el)),
  setPeriodTradeSort: el => setPeriodTradeSort(arg(el)),
  periodTextInput: el => periodTextInput(arg(el), /** @type {HTMLTextAreaElement} */ (el).value),
  periodTextSave: el => periodTextSave(arg(el), /** @type {HTMLTextAreaElement} */ (el).value),
  setJournalSide: el => setJournalSide(arg(el)),
  journalSymbolChanged: () => journalSymbolChanged(),
  toggleDeletedTrades: () => toggleDeletedTrades(),
  toggleJournalColumnsMenu: () => toggleJournalColumnsMenu(),
  toggleJournalColumn: el => toggleJournalColumn(arg(el)),
  setJournalFees: el => setJournalFees(arg(el)),
  openTradeReview: el => openTradeReview(arg(el)),
  tradeStopPreview: () => tradeStopPreview(),
  pickTradeStop: el => pickTradeStop(arg(el)),
  saveTradeStop: el => { if (el.tagName === 'INPUT') el.blur(); saveTradeStop(); },
  clearTradeStop: () => clearTradeStop(),
  openTradeRow: (el, e) => openTradeRow(arg(el), e),
  closeJournalTrade: () => closeJournalTrade(),
  stepJournalTrade: el => stepJournalTrade(num(el)),
  setJournalReviewFilter: el => setJournalReviewFilter(arg(el)),
  setJournalSetupFilter: el => setJournalSetupFilter(/** @type {HTMLSelectElement} */ (el).value),
  // the Review section acts on the trade on the page
  setReviewMarket: el => withPageTrade(t => setReviewMarket(t, arg(el))),
  toggleReviewMarketOwn: () => withPageTrade(t => toggleReviewMarketOwn(t)),
  toggleReviewLabel: el => withPageTrade(t => toggleReviewLabel(t, arg(el), el.dataset.arg2 || '')),
  toggleSetup: el => withPageTrade(t => toggleSetup(t, arg(el))),
  reviewSearchInput: el => withPageTrade(t => reviewSearchInput(t, arg(el), /** @type {HTMLInputElement} */ (el).value)),
  reviewSearchPick: (el, e) => { e.preventDefault(); return withPageTrade(t => reviewSearchPick(t, arg(el))); },
  startReviewDeck: () => startReviewDeck(),
  reviewSkipped: () => reviewSkipped(),
  deckNext: () => deckNext(),
  deckBack: () => deckBack(),
  endReviewDeck: () => endReviewDeck(),
  toggleDeckWeekly: () => toggleDeckWeekly(),
  revealDeckPnl: () => revealDeckPnl(),
  setDeckPnl: el => setDeckPnl(arg(el)),
  setReviewFrom: el => setReviewFrom(/** @type {HTMLInputElement} */ (el).value),
  clearReviewFrom: () => setReviewFrom(''),
  startSetupDraft: () => startSetupDraft(),
  cancelSetupDraft: () => cancelSetupDraft(),
  setDraftAction: el => withPageTrade(t => setDraftAction(t, arg(el))),
  setDraftPattern: el => withPageTrade(t => setDraftPattern(t, arg(el))),
  toggleDraftLevel: el => withPageTrade(t => toggleDraftLevel(t, arg(el))),
  editSetup: el => editSetup(arg(el)),
  cancelSetupEdit: () => cancelSetupEdit(),
  setEditAction: el => setEditAction(arg(el)),
  setEditPattern: el => setEditPattern(arg(el)),
  toggleEditLevel: el => toggleEditLevel(arg(el)),
  setupEditNameInput: el => setupEditNameInput(/** @type {HTMLInputElement} */ (el).value),
  saveSetupEdit: () => saveSetupEdit(),
  mergeEditedSetup: el => mergeEditedSetup(arg(el)),
  newLibrarySetup: () => newLibrarySetup(),
  useSetupTwin: el => useSetupTwin(arg(el)),
  startLibraryChoice: el => startLibraryChoice(arg(el)),
  cancelLibraryChoice: () => cancelLibraryChoice(),
  libraryChoiceInput: el => { if (state.libraryNew) state.libraryNew.name = /** @type {HTMLInputElement} */ (el).value; },
  libraryChoiceShortInput: el => { if (state.libraryNew) state.libraryNew.short = /** @type {HTMLInputElement} */ (el).value; },
  addLibraryChoice: () => addLibraryChoice(state.libraryNew?.name || /** @type {HTMLInputElement | null} */ (document.getElementById('libraryNewName'))?.value || ''),
  pasteTradeShot: () => withPageTrade(t => pasteTradeShot(t)),
  pickTradeShots: () => pickTradeShots(),
  addTradeShotsFromInput: el => withPageTrade(t => { const files = /** @type {HTMLInputElement} */ (el).files; const p = addTradeShots(t, files); /** @type {HTMLInputElement} */ (el).value = ''; return p; }),
  openShot: el => openShot(arg(el)),
  removeTradeShot: el => removeTradeShot(arg(el)),
  undoRemoveShot: () => undoRemoveShot(),
  pasteMissedShot: () => pasteMissedShot(),
  pickMissedShots: () => pickMissedShots(),
  addMissedShotsFromInput: el => { const files = /** @type {HTMLInputElement} */ (el).files; const p = addMissedShots(files); /** @type {HTMLInputElement} */ (el).value = ''; return p; },
  closeShotViewer: () => closeShotViewer(),
  deleteTradeShot: () => deleteTradeShot(),
  saveTradeShotCaption: el => saveTradeShotCaption(/** @type {HTMLInputElement} */ (el).value),
  reviewLinkInput: el => reviewLinkInput(/** @type {HTMLInputElement} */ (el).value),
  addReviewLink: el => withPageTrade(t => addReviewLink(t, arg(el), el.tagName === 'INPUT' ? /** @type {HTMLInputElement} */ (el).value : undefined)),
  removeReviewLink: el => withPageTrade(t => removeReviewLink(t, arg(el), el.dataset.arg2 || '')),
  setSetupGrade: el => withPageTrade(t => setSetupGrade(t, arg(el))),
  setPlanFollowed: el => withPageTrade(t => setPlanFollowed(t, arg(el))),
  reviewNoteInput: el => withPageTrade(t => reviewNoteInput(t, /** @type {HTMLTextAreaElement} */ (el).value, arg(el))),
  reviewNoteSave: el => withPageTrade(t => reviewNoteSave(t, /** @type {HTMLTextAreaElement} */ (el).value, arg(el))),
  startReviewItem: el => startReviewItem(arg(el)),
  cancelReviewItem: () => cancelReviewItem(),
  reviewNewNameInput: el => { state.reviewNewName = /** @type {HTMLInputElement} */ (el).value; },
  reviewNewShortInput: el => { state.reviewNewShort = /** @type {HTMLInputElement} */ (el).value; },
  saveReviewItem: () => withPageTrade(t => saveReviewItem(t, state.reviewNewName || /** @type {HTMLInputElement | null} */ (document.getElementById('reviewNewName'))?.value || '')),
  openJournalLibrary: () => openJournalLibrary(),
  renameLibraryItem: el => renameLibraryItem(arg(el), el.dataset.arg2 || '', /** @type {HTMLInputElement} */ (el).value),
  toggleLibraryHidden: el => toggleLibraryHidden(arg(el), el.dataset.arg2 || ''),
  mergeLibraryItem: el => mergeLibraryItem(arg(el), el.dataset.arg2 || '', /** @type {HTMLSelectElement} */ (el).value),
  mergeTwin: el => mergeTwin(arg(el), el.dataset.arg2 || '', el.dataset.into || ''),
  setLibraryShort: el => setLibraryShort(arg(el), el.dataset.arg2 || '', /** @type {HTMLInputElement} */ (el).value),
  editJournalTrade: () => editJournalTrade(),
  setJournalInterval: el => setJournalInterval(num(el)),
  setJournalRange: el => setJournalRange(el.dataset.arg),
  setJournalChartKind: el => setJournalChartKind(el.dataset.arg),
  setJournalTradeTab: el => setJournalTradeTab(el.dataset.arg),
  toggleTradeFeatures: () => toggleTradeFeatures(),
  toggleJournalLog: el => toggleJournalLog(el.dataset.arg),
  deletePicked: () => deletePicked(),
  undoDeleteTrades: () => undoDeleteTrades(),
  deleteTrade: () => deleteTrade(),
  restoreTrade: el => restoreTrade(arg(el)),
  combineTrade: el => combineTrade(arg(el)),
  splitSpread: () => splitSpread(),
  toggleJournalPick: el => toggleJournalPick(arg(el)),
  clearJournalPicks: () => clearJournalPicks(),
  toggleJournalSelect: () => toggleJournalSelect(),
  toggleJournalFilters: () => toggleJournalFilters(),
  mergePicked: () => mergePicked(),
  separateTrade: el => separateTrade(arg(el)),
  schwabProxyDone: () => schwabProxyDone(),
  editSchwabProxy: () => editSchwabProxy(),
  connectSchwab: () => connectSchwab(),
  schwabBannerLogin: () => schwabBannerLogin(),
  hideSchwabBanner: () => hideSchwabBanner(),
  finishSchwab: el => { if (el.tagName === 'INPUT') el.blur(); finishSchwab(); },
  reloadSchwabAccounts: () => reloadSchwabAccounts(),
  schwabAccountChanged: () => schwabAccountChanged(),
  disconnectSchwab: () => disconnectSchwab(),

  // ---------- account and risk ----------
  setSizingMode: el => setSizingMode(arg(el)),
  setAccountSizeSource: el => setAccountSizeSource(arg(el)),
  recalcAll: () => recalcAll(),
  syncFromDollar: () => syncFromDollar(),
  setRiskPct: el => setRiskPct(num(el)),
  setRiskUsd: el => setRiskUsd(num(el)),
  toggleUsdEdit: () => toggleUsdEdit(),
  allocationChanged: () => allocationChanged(),
  setAllocationPct: el => setAllocationPct(num(el)),
  setOptionTradeSide: el => setOptionTradeSide(arg(el)),

  // ---------- ticket: ticker, direction, entry and stops ----------
  submitTicker: el => { if (el.tagName === 'INPUT') el.blur(); submitTicker(); },
  tickerInputChanged: () => tickerInputChanged(),
  refreshQuote: () => refreshQuote(),
  toggleLive: () => toggleLive(),
  loadTicker: el => loadTicker(arg(el)),
  setDirection: el => setDirection(arg(el)),
  stopsChanged: () => stopsChanged(),
  setStopStrategy: el => setStopStrategy(/** @type {HTMLSelectElement} */ (el).value),
  setAtrMultiplier: el => setAtrMultiplier(num(el)),
  setStopPercent: el => setStopPercent(num(el)),
  setTimeZone: el => setTimeZone(arg(el)),
  stopPercentTyped: el => setStopPercent(/** @type {HTMLInputElement} */ (el).value, true),

  // ---------- shares answer ----------
  sharesQtyChanged: el => sharesQtyChanged(el),
  shareShares: () => shareShares(),
  copyShares: () => copyShares(),

  // ---------- Schwab order review ----------
  openTrade: () => openTrade(),
  setTradeStopDuration: el => setTradeStopDuration(arg(el)),
  setTradeEntryType: el => setTradeEntryType(arg(el)),
  setTradeEntryLimit: el => setTradeEntryLimit(el.value),
  setTradeLimit: el => setTradeLimit(el.value),
  setOrb: el => setOrb(num(el)),
  placeTrade: () => placeTrade(),
  checkTradeStatus: () => checkTradeStatus(),

  // ---------- futures ----------
  futuresFeesChanged: el => { setFuturesFees(arg(el), el.value); renderShares(); },

  // ---------- charts ----------
  setChartInterval: el => setChartInterval(num(el)),
  toggleDaily: () => toggleDaily(),
  setDailyRange: el => setDailyRange(num(el)),
  dailyToday: () => dailyToday(),

  // ---------- option chain and details ----------
  selectExp: el => selectExp(arg(el)),
  toggleExps: () => toggleExps(),
  setSide: el => setSide(arg(el)),
  setZoneMode: el => setZoneMode(arg(el)),
  renderChain: () => renderChain(),
  bothStrikesChanged: el => { store.set('both_strikes', /** @type {HTMLInputElement} */ (el).value); renderChain(); },
  contractsQtyChanged: el => contractsQtyChanged(el, num(el)),
  closeDetails: () => closeDetails(),
  openSimFor: el => effects.openSim(state.simReg[arg(el)]),
  pinAllocation: el => pinAllocation(arg(el)),
  allocationQtyChanged: el => allocationQtyChanged(Math.floor(Number(/** @type {HTMLInputElement} */ (el).value)), num(el), el.dataset.arg2 || ''),
  startSpread: el => startSpread(arg(el), el.dataset.arg2 === 'credit'),
  cancelSpread: () => cancelSpread(),

  // ---------- quick lookup and pinned cards ----------
  toggleQuick: () => toggleQuick(),
  parseQuick: () => parseQuick(),
  fetchQuickOption: () => fetchQuickOption(),
  copyPinned: el => copyPinned(arg(el)),
  sharePinned: el => sharePinned(arg(el)),
  simFromPinned: el => simFromPinned(arg(el)),
  refreshPinned: el => refreshPinned(arg(el)),
  removePinned: el => removePinned(arg(el)),
  pinnedStopChanged: el => pinnedStopChanged(arg(el), el),
  refreshAllPinned: () => refreshAllPinned(),

  // ---------- positions ----------
  refreshPositions: () => refreshPositions(true),
  openPositionTrade: el => openPositionTrade(arg(el), el.dataset.arg2),
  setPositionStopDuration: el => setPositionStopDuration(arg(el)),
  setPositionBeMode: el => setPositionBeMode(arg(el)),
  placePositionTrade: () => placePositionTrade(),
  setCloseType: el => setCloseType(arg(el)),
  setClosePortion: el => setClosePortion(num(el)),
  setCloseQty: el => setCloseQty(el.value),
  setClosePrice: el => setClosePrice(el.value),
  setCloseR: el => setCloseR(num(el)),
  setCloseRText: el => setCloseRText(el.value),
  setPositionStopPrice: el => setPositionStopPrice(el.value),
  setPositionStopAt: el => setPositionStopAt(arg(el)),
  openSpreadClose: el => openSpreadClose(arg(el)),
  setSpreadCloseType: el => setSpreadCloseType(arg(el)),
  setSpreadClosePortion: el => setSpreadClosePortion(num(el)),
  setSpreadCloseQty: el => setSpreadCloseQty(el.value),
  setSpreadClosePrice: el => setSpreadClosePrice(el.value),
  setSpreadCloseDuration: el => setSpreadCloseDuration(arg(el)),
  placeSpreadClose: () => placeSpreadClose(),
  openOrderCancel: el => openOrderCancel(arg(el)),
  setCancelKeep: el => setCancelKeep(arg(el) === 'keep'),
  sendOrderCancel: () => sendOrderCancel(),
  openOrderEdit: el => openOrderEdit(arg(el)),
  setEditStop: el => setEditStop(el.value),
  setEditPrice: el => setEditPrice(el.value),
  setEditQty: el => setEditQty(el.value),
  setEditDuration: el => setEditDuration(arg(el)),
  sendOrderEdit: () => sendOrderEdit(),
  togglePositionChart: el => togglePositionChart(arg(el)),
  closePositionChart: () => closePositionChart(),
  setPosChartRange: el => setPosChartRange(num(el)),
  posChartToday: el => posChartToday(arg(el)),
  togglePosChartAvg: () => togglePosChartAvg(),
  posTargetChanged: () => posTargetChanged(),
  posTargetRChanged: () => posTargetRChanged(),
  posChartStopChanged: () => posChartStopChanged(),
  setPosTargetPortion: el => setPosTargetPortion(num(el)),
  setPosTargetR: el => setPosTargetR(num(el)),
  setPosChartTool: el => setPosChartTool(arg(el)),
  posAddChanged: () => posAddChanged(),
  simPosition: el => simPosition(arg(el)),
  togglePosColumnsMenu: () => togglePosColumnsMenu(),
  togglePosColumn: el => togglePosColumn(arg(el)),
  togglePosHideValue: () => togglePosHideValue(),
  togglePosLegs: el => togglePosLegs(arg(el)),

  // ---------- simulator ----------
  closeSim: () => closeSim(),
  closeSimBackdrop: (el, event) => { if (event.target === el) closeSim(); },
  drawSim: () => drawSim(),
  simPriceTyped: el => simPriceTyped(el),
  simSetPrice: el => simSetPrice(Number.isNaN(num(el)) ? arg(el) : num(el)), // 'stop' | 'current' | R multiple

  // ---------- market ----------
  marketToggleAuto: () => marketToggleAuto(),
  marketUseSnapshot: () => marketUseSnapshot(),
  marketRefreshToday: () => marketRefreshToday(),
  marketCancelRefresh: () => marketCancelRefresh(),
  marketSetScope: el => marketSetScope(arg(el)),
  marketSearchChanged: () => marketSearchChanged(),
  marketClearSearch: () => marketClearSearch(),
  marketSetDisplay: el => marketSetDisplay(arg(el)),
  marketShowMore: () => marketShowMore(),

  // ---------- tools ----------
  renderGain: () => renderGain(),
  findLevEtfs: el => { if (el.tagName === 'INPUT') el.blur(); findLevEtfs(); },
  setLevDir: el => setLevDir(arg(el)),
  levLoad: el => levLoad(arg(el)),
  levTarget: el => { if (el.tagName === 'INPUT') el.blur(); levTarget(); },
};

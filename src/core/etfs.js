// @ts-check
// Which tickers are funds (ETFs), for the Journal's Ticker type filter: the Market tab's ETF list, the leveraged and
// inverse funds the Tools finder knows, and the broad index and bond funds people trade most. A short list on purpose: a
// fund it misses reads as a stock until it's added here (or you tell the journal what it moves with).
import { LEV_ETFS } from './lev-etfs.js';

/** data/market-etfs-*.csv's tickers (a test keeps them in) */
const MARKET_ETFS = 'AGG AIA AIQ ARKG ARKK ASHR BBH BLOK BOTZ BOUT BTF BUZZ CIBR CLOU COPX DBA DBC DRAM DRIV EMLC ESPO EUV FDN FFTY FOTO FXI GDX GDXJ GLD HACK HYG IBUY IDNA IDRV IEF IEI IGV IHI IPO ITA ITB IWO IXC IYT JETS KBE KIE KRE KWEB LIT LQD MAGS MOO MSOS NANR NLR OIH OUNZ PAVE PBW PHO PPH QTUM REMX SHV SKYY SLV SMH SPPP TAN TLT UFO UNG URA USO UUP VGIT WEAT WGMI XAR XBI XHB XHS XME XOP XRT XSD XSW IJJ IJK IJS IJT IVE IVW XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY QQQE RSP RSPC RSPD RSPF RSPG RSPH RSPM RSPN RSPR RSPS RSPT RSPU ACWI ARGT ECH EEM EFA EPOL EUFN EWA EWC EWD EWG EWI EWL EWP EWQ EWS EWW EWY EWZ EZA EZU GREK IEUR IEV INDA MCHI THD TUR';
/** broad index, size, style, bond, volatility and crypto funds */
const COMMON_ETFS = 'SPY VOO IVV SPLG VTI ITOT QQQ QQQM IWM IWB IWF IWD IWN IJH IJR MDY DIA VUG VTV VB VO VEA VWO VXUS VNQ VIG'
  + ' SCHD SCHX SCHG SCHB DGRO NOBL MTUM QUAL USMV SPLV BND BNDX TIP SHY SGOV BIL JNK EMB MUB ARKW ARKQ ARKF ARKX VXX VIXY'
  + ' IBIT FBTC GBTC BITO ETHA ETHE SOXX PSI IGM VGT FTEC IYW WCLD BUG QTEC ONEQ IBB XLG OEF MGK SPYG SPYV SPHB SPHD GDXU';

/** @type {Set<string>} */
export const ETFS = new Set([
  ...MARKET_ETFS.split(' '), ...COMMON_ETFS.split(' '),
  ...Object.values(LEV_ETFS).flat().map(([sym]) => String(sym)), // the funds, not what they track (NVDA is a stock)
].filter(Boolean));

/** cash-settled index option roots (SPX, its weeklies, the minis) */
export const INDEXES = new Set(['SPX', 'SPXW', 'XSP', 'NDX', 'NDXP', 'XND', 'RUT', 'RUTW', 'MRUT', 'VIX', 'VIXW', 'DJX', 'OEX', 'XEO']);

/** whether a ticker is a fund. @param {string} symbol */
export const isEtf = symbol => ETFS.has(String(symbol || '').toUpperCase());

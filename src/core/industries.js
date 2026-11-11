// @ts-check
// Industry groups and their sectors, never typed (owner request): the Market tab's universe (data/market-universe-*.csv)
// names each stock's industry group ('Semiconductors', Yahoo's industries), and SECTOR_OF puts each group in its sector
// ('Technology', Yahoo's eleven). A trade reads on its stock: an option's or a spread's underlying, a leveraged fund's
// underlying (setupOn: NVDL reads on NVDA). The sector SPDRs (XLK...) are their sector, with no group; any other ETF, an
// index or a future has none.
import { parseSchwabOption } from './positions.js';

/** the eleven sectors, in the order the Journal lists them */
export const SECTORS = ['Technology', 'Communication Services', 'Consumer Cyclical', 'Consumer Defensive', 'Energy',
  'Financial Services', 'Healthcare', 'Industrials', 'Basic Materials', 'Real Estate', 'Utilities'];

/** each sector's industry groups, as the universe names them */
const GROUPS = /** @type {Record<string, string[]>} */ ({
  'Technology': ['Communication Equipment', 'Computer Hardware', 'Consumer Electronics', 'Electronic Components',
    'Electronics & Computer Distribution', 'Information Technology Services', 'Scientific & Technical Instruments',
    'Semiconductor Equipment & Materials', 'Semiconductors', 'Software - Application', 'Software - Infrastructure', 'Solar'],
  'Communication Services': ['Advertising Agencies', 'Broadcasting', 'Electronic Gaming & Multimedia', 'Entertainment',
    'Internet Content & Information', 'Publishing', 'Telecom Services'],
  'Consumer Cyclical': ['Apparel Manufacturing', 'Apparel Retail', 'Auto & Truck Dealerships', 'Auto Manufacturers', 'Auto Parts',
    'Department Stores', 'Footwear & Accessories', 'Furnishings, Fixtures & Appliances', 'Gambling', 'Home Improvement Retail',
    'Internet Retail', 'Leisure', 'Lodging', 'Luxury Goods', 'Packaging & Containers', 'Personal Services', 'Recreational Vehicles',
    'Residential Construction', 'Resorts & Casinos', 'Restaurants', 'Specialty Retail', 'Textile Manufacturing', 'Travel Services'],
  'Consumer Defensive': ['Beverages - Brewers', 'Beverages - Non-Alcoholic', 'Beverages - Wineries & Distilleries', 'Confectioners',
    'Discount Stores', 'Education & Training Services', 'Farm Products', 'Food Distribution', 'Grocery Stores',
    'Household & Personal Products', 'Packaged Foods', 'Tobacco'],
  'Energy': ['Oil & Gas Drilling', 'Oil & Gas E&P', 'Oil & Gas Equipment & Services', 'Oil & Gas Integrated', 'Oil & Gas Midstream',
    'Oil & Gas Refining & Marketing', 'Thermal Coal', 'Uranium'],
  'Financial Services': ['Asset Management', 'Banks - Diversified', 'Banks - Regional', 'Capital Markets', 'Closed-End Fund - Debt',
    'Closed-End Fund - Equity', 'Closed-End Fund - Foreign', 'Credit Services', 'Financial Conglomerates',
    'Financial Data & Stock Exchanges', 'Insurance - Diversified', 'Insurance - Life', 'Insurance - Property & Casualty',
    'Insurance - Reinsurance', 'Insurance - Specialty', 'Insurance Brokers', 'Mortgage Finance', 'Shell Companies'],
  'Healthcare': ['Biotechnology', 'Diagnostics & Research', 'Drug Manufacturers - General', 'Drug Manufacturers - Specialty & Generic',
    'Health Information Services', 'Healthcare Plans', 'Medical Care Facilities', 'Medical Devices', 'Medical Distribution',
    'Medical Instruments & Supplies'],
  'Industrials': ['Aerospace & Defense', 'Airlines', 'Airports & Air Services', 'Building Products & Equipment',
    'Business Equipment & Supplies', 'Conglomerates', 'Consulting Services', 'Electrical Equipment & Parts',
    'Engineering & Construction', 'Farm & Heavy Construction Machinery', 'Industrial Distribution', 'Integrated Freight & Logistics',
    'Marine Shipping', 'Metal Fabrication', 'Pollution & Treatment Controls', 'Railroads', 'Rental & Leasing Services',
    'Security & Protection Services', 'Specialty Business Services', 'Specialty Industrial Machinery', 'Staffing & Employment Services',
    'Tools & Accessories', 'Trucking', 'Waste Management'],
  'Basic Materials': ['Agricultural Inputs', 'Aluminum', 'Building Materials', 'Chemicals', 'Coking Coal', 'Copper', 'Gold',
    'Lumber & Wood Production', 'Other Industrial Metals & Mining', 'Other Precious Metals & Mining', 'Paper & Paper Products',
    'Silver', 'Specialty Chemicals', 'Steel'],
  'Real Estate': ['REIT - Diversified', 'REIT - Healthcare Facilities', 'REIT - Hotel & Motel', 'REIT - Industrial', 'REIT - Mortgage',
    'REIT - Office', 'REIT - Residential', 'REIT - Retail', 'REIT - Specialty', 'Real Estate - Development',
    'Real Estate - Diversified', 'Real Estate Services'],
  'Utilities': ['Utilities - Diversified', 'Utilities - Independent Power Producers', 'Utilities - Regulated Electric',
    'Utilities - Regulated Gas', 'Utilities - Regulated Water', 'Utilities - Renewable'],
});

/** industry group → its sector */
export const SECTOR_OF = /** @type {Record<string, string>} */ (Object.fromEntries(
  Object.entries(GROUPS).flatMap(([sector, groups]) => groups.map(g => [g, sector]))));

/** the sector SPDRs: a trade on one (or on a fund that moves with one) is in its sector */
export const SECTOR_FUNDS = /** @type {Record<string, string>} */ ({
  XLK: 'Technology', XLC: 'Communication Services', XLY: 'Consumer Cyclical', XLP: 'Consumer Defensive', XLE: 'Energy',
  XLF: 'Financial Services', XLV: 'Healthcare', XLI: 'Industrials', XLB: 'Basic Materials', XLRE: 'Real Estate', XLU: 'Utilities',
});

/**
 * ticker → industry group, from the universe's rows (MarketData.parseCsv)
 * @param {{ ticker: string, group: string }[]} rows @returns {Map<string, string>}
 */
export const industryMap = rows => new Map(rows.map(r => [r.ticker, r.group]));

/**
 * The stock a trade's industry reads on: a leveraged fund's underlying, an option's root, a spread's symbol (its root),
 * else its own symbol; '' for a future.
 * @param {{ symbol: string, assetType?: string, legs?: unknown, setupOn?: string | null }} t
 */
export function stockOf(t) {
  const sym = String(t.symbol || '');
  if (/FUTURE/.test(t.assetType || '') || sym.startsWith('/')) return '';
  if (t.setupOn) return t.setupOn;
  const root = t.legs ? sym : t.assetType === 'OPTION' ? parseSchwabOption(sym)?.root || sym.split(' ')[0] : sym;
  return root.replace(/^\$/, '');
}

/**
 * A trade's industry group and sector: { ticker, industry ('' for a sector SPDR), sector ('' for a group SECTOR_OF doesn't
 * know yet) }, or null when the universe doesn't list its stock.
 * @param {{ symbol: string, assetType?: string, legs?: unknown, setupOn?: string | null }} t @param {Map<string, string>} map
 * @returns {{ ticker: string, industry: string, sector: string } | null}
 */
export function industryOf(t, map) {
  const ticker = stockOf(t);
  if (!ticker) return null;
  const industry = map.get(ticker);
  if (industry) return { ticker, industry, sector: SECTOR_OF[industry] || '' };
  return SECTOR_FUNDS[ticker] ? { ticker, industry: '', sector: SECTOR_FUNDS[ticker] } : null;
}

/** 'Semiconductors · Technology'; '' for none @param {{ industry: string, sector: string } | null} info */
export const industryWords = info => info ? [info.industry, info.sector].filter(Boolean).join(' · ') : '';

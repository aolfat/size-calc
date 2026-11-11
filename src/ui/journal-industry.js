// The Journal's industry groups (core/industries.js, services/industries.js): each trade's industry group and sector, read
// from the Market tab's stock universe, never typed (owner request). Shown on the trade page, filtered in More filters,
// broken down in Stats.
import { industryOf } from '../core/industries.js';
import { loadIndustryMap } from '../services/industries.js';
import { state } from '../state.js';

/** read the universe once (the Journal's load); a failure leaves every trade without a group and says why in Stats */
export async function loadIndustries() {
  if (state.industries) return;
  try {
    state.industries = await loadIndustryMap();
    state.industriesError = '';
  } catch(e) {
    state.industriesError = String(e?.message || e);
  }
}

/** the groups are read, so a trade without one is one the universe doesn't list (not one still loading) */
export const industriesReady = () => !!state.industries;

/** a trade's { ticker, industry, sector }, or null (not listed, or not read yet) */
export const tradeIndustry = t => state.industries ? industryOf(t, state.industries) : null;

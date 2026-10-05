// @ts-check
// Desktop shell tiers. CSS mirrors these exact queries: the chain is compact while the main pane
// is narrower than the full 1000px table, and the rail shows chain details at any desktop width.

export const DESKTOP_MQ = '(min-width: 1100px)';

export const COMPACT_CHAIN_MQ = '(min-width: 1100px) and (max-width: 1439.98px)';

/** @param {string} query @returns {boolean} */
export function mq(query) { return !!window.matchMedia && window.matchMedia(query).matches; }

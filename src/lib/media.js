// @ts-check
// What JS mirrors from the stylesheets: the desktop shell tiers and the font stack canvases draw with.
// Desktop shell tiers. CSS mirrors these exact queries: the chain is compact while the main pane
// is narrower than the full 1000px table, and the rail shows chain details at any desktop width.

export const DESKTOP_MQ = '(min-width: 1100px)';

export const COMPACT_CHAIN_MQ = '(min-width: 1100px) and (max-width: 1439.98px)';

/** @param {string} query @returns {boolean} */
export function mq(query) { return !!window.matchMedia && window.matchMedia(query).matches; }

// Canvas text can't read CSS variables: this matches --sans in styles/base.css.
export const SANS_FONT = '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

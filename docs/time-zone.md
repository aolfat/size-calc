# Times: ET or PT

Settings has a Times switch (#zoneSeg): New York (ET), the default, or Pacific (PT).
It flips every clock time the app shows, everywhere at once: the calculator's 5-minute chart axis and readout, the position chart, the journal trade and missed-trade charts (Lightweight Charts), fills, stop orders, Opened (ET / PT) in the trades table, the week review's early entries, the time-of-day stats, the opening-range line, the ATR bar time, Positions' times and refreshes, order sheets, the 'Updated' line, the sync status, pinned snapshots and the share image.
It is kept on this device only (time_zone in localStorage, state.timeZone), not synced, so each device picks its own.

**What doesn't move.**
The market's logic stays on New York's clock in either zone: trading days, the 9:30 to 16:00 session, extended hours, the 4pm expiry close, the opening range's window, bars kept after 20:00, the calendar, period reviews and the time-of-day groups.
Only their labels change: the 9:30–9:45 group reads 6:30–6:45 in PT.
Dates shown for a trading day (a trade's day, the calendar) are New York's in both zones.
What Claude reads (scripts/journal.mjs, the key-gated functions) stays in ET.

**How.**
core/format.js has the pure conversions: wallClock(ms, zone), nyWallMs(day, time) (a New York wall clock as an instant, exact on DST days) and nyWallIn(day, time, zone).
lib/zone.js reads state.timeZone and is what the rest calls: inZone(t, opts) for an instant (toLocaleString in the shown zone), zoneClock / zoneDial / zoneWords for a New York 'HH:MM' as bars are stamped, zoneAbbr for 'ET' / 'PT'.
Core code that words a time takes the wording from its caller (openingRange's `say`, periodReview's ctx.clock; both default to ET) and chartSeries / chartTime take the zone; paintTradeChart sets the bars again when the zone changed, keeping the view.
setTimeZone in ui/settings.js saves it and redraws what's on screen (charts, the Journal, Positions, the opening-range line, the stop line, the account source line, Claude keys); stamps already taken (pinned cards' as-of, 'Updated') change on their next update.

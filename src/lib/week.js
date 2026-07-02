// src/lib/week.js — the weekly-reset boundary, computed in a DST-safe way.
//
// Invariant (CLAUDE.md #3): "Weekly" = since the most recent Monday 00:00 in the
// office's LOCAL zone. The weekly count is derived by filtering `assignments` on
// `timestamp >= mostRecentMondayMidnight(...)`. Getting this instant wrong (e.g.
// computing it in UTC, or off-by-a-day across a DST transition) silently skews
// every fairness decision, so we lean on Luxon's zone-aware math rather than
// hand-rolling Date arithmetic.
//
// PURE: no Firebase, no I/O. Safe to import from unit tests.

import { DateTime } from 'luxon'

// The Texas HHSC office's local zone. Exported so callers (counts.js, reports)
// and tests share one source of truth for "local".
export const WEEK_ZONE = 'America/Chicago'

/**
 * The most recent Monday at 00:00:00.000 in `zone`, as a JS Date (a UTC instant).
 *
 * Luxon weeks are Monday-based, so `startOf('week')` lands on Monday midnight in
 * the target zone. Because the zone is applied before truncating, the result is
 * correct across DST transitions (the offset is whatever was in effect at that
 * Monday midnight, not "now").
 *
 * @param {Date} now  reference instant (defaults to current time)
 * @param {string} zone IANA zone (defaults to WEEK_ZONE)
 * @returns {Date} Monday 00:00 local, as a JS Date
 */
export function mostRecentMondayMidnight(now = new Date(), zone = WEEK_ZONE) {
  return DateTime.fromJSDate(now)
    .setZone(zone)
    .startOf('week') // Luxon: week starts Monday → Monday 00:00:00.000 in `zone`
    .toJSDate()
}

/**
 * Today at 00:00:00.000 in `zone`, as a JS Date (a UTC instant).
 *
 * Same setZone→startOf pattern as mostRecentMondayMidnight, so it is likewise
 * DST-safe: the offset applied is whatever was in effect at that local midnight,
 * not "now". Used for the "today" Reports window. PURE: no Firebase, no I/O.
 *
 * @param {Date} now  reference instant (defaults to current time)
 * @param {string} zone IANA zone (defaults to WEEK_ZONE)
 * @returns {Date} today 00:00 local, as a JS Date
 */
export function startOfTodayMidnight(now = new Date(), zone = WEEK_ZONE) {
  return DateTime.fromJSDate(now).setZone(zone).startOf('day').toJSDate()
}

/**
 * The Monday 00:00 that BEGINS a rolling window of `weeks` Monday-aligned weeks
 * ending with the CURRENT week: the current week's Monday minus (weeks - 1)
 * weeks. Used for the "historical" Reports window.
 *
 * `weeks = 1` is exactly mostRecentMondayMidnight(now) (the current week only);
 * `weeks = 8` reaches back to the Monday seven weeks earlier. Same zone-aware
 * setZone→startOf('week') pattern; Luxon's calendar `minus({ weeks })` preserves
 * the local 00:00 time-of-day, so the result stays Monday 00:00 even when the
 * window spans a spring-forward / fall-back (DST-safe, not off by an hour/day).
 * PURE: no Firebase, no I/O.
 *
 * @param {number} weeks  number of Monday-aligned weeks in the window (>= 1)
 * @param {Date} now  reference instant (defaults to current time)
 * @param {string} zone IANA zone (defaults to WEEK_ZONE)
 * @returns {Date} the window's first Monday 00:00 local, as a JS Date
 */
export function rollingWeeksStart(weeks, now = new Date(), zone = WEEK_ZONE) {
  return DateTime.fromJSDate(now)
    .setZone(zone)
    .startOf('week')
    .minus({ weeks: weeks - 1 })
    .toJSDate()
}

// src/lib/counts.js — derive the GLOBAL weekly count per worker from the
// `assignments` collection (the single source of truth, CLAUDE.md #6).
//
// "Weekly" = timestamp >= most-recent Monday 00:00 local (week.js). The count is
// GLOBAL across all programs (#3) — we do NOT filter by program here. Never store
// a separate counter; always derive.

import {
  collection,
  query,
  where,
  Timestamp,
  getDocsFromServer,
  onSnapshot,
} from 'firebase/firestore'
import { mostRecentMondayMidnight, startOfTodayMidnight, rollingWeeksStart } from './week.js'

/**
 * Count this week's assignments per worker.
 *
 * Uses getDocsFromServer (not the cache) so a just-written assignment — whose
 * serverTimestamp resolves on the server — is reflected immediately. Reading
 * from cache right after an Assign could miss it and hand out a stale ranking.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {Date} [now] reference instant for the week boundary (defaults to now)
 * @returns {Promise<Map<string, number>>} workerId -> count (absent worker = 0)
 */
export async function getWeeklyCounts(db, now = new Date()) {
  const since = mostRecentMondayMidnight(now)
  const q = query(
    collection(db, 'assignments'),
    where('timestamp', '>=', Timestamp.fromDate(since)),
  )
  const snap = await getDocsFromServer(q)

  const counts = new Map()
  snap.forEach((docSnap) => {
    const workerId = docSnap.data().workerId
    if (!workerId) return
    counts.set(workerId, (counts.get(workerId) ?? 0) + 1)
  })
  return counts
}

// How many Monday-aligned weeks the "historical" Reports window spans: the
// current week plus the 7 prior. Exported so it is trivially changeable in one
// place. Used for both the subscribe query's lower bound and the per-emit
// historical bucket boundary.
export const DEFAULT_HISTORICAL_WEEKS = 8

/**
 * PURE. Bucket pre-fetched assignment rows into three NESTED windows —
 * today ⊆ week ⊆ historical — tallying per worker. No Firebase, no clock: the
 * caller passes the rows and the three boundaries, so it is exhaustively
 * unit-testable by feeding rows that straddle each boundary.
 *
 * A row counts toward a window when its timestamp is AT OR AFTER that window's
 * start (>= is inclusive). Rows with a falsy workerId or a null timestampMs are
 * skipped defensively — a just-written serverTimestamp can be null before it
 * resolves, and such a row has no place on the timeline yet.
 *
 * @param {Array<{workerId: string, timestampMs: number|null}>} rows
 * @param {{todayStart: Date, weekStart: Date, historicalStart: Date}} boundaries JS Dates
 * @returns {{today: Map<string,number>, week: Map<string,number>, historical: Map<string,number>}}
 *          a worker absent from a map = 0 (exactly like getWeeklyCounts)
 */
export function bucketCounts(rows, { todayStart, weekStart, historicalStart }) {
  const today = new Map()
  const week = new Map()
  const historical = new Map()
  const todayMs = todayStart.getTime()
  const weekMs = weekStart.getTime()
  const historicalMs = historicalStart.getTime()

  const bump = (map, id) => map.set(id, (map.get(id) ?? 0) + 1)

  for (const row of rows ?? []) {
    const id = row?.workerId
    const ms = row?.timestampMs
    // Defensive: skip a missing worker or an unresolved (null) timestamp.
    if (!id || ms == null) continue
    // Nested windows: today's rows are also within week and historical, so a
    // single row bumps every window whose start it clears. todayMs >= weekMs >=
    // historicalMs, which is what makes today ⊆ week ⊆ historical hold.
    if (ms >= historicalMs) bump(historical, id)
    if (ms >= weekMs) bump(week, id)
    if (ms >= todayMs) bump(today, id)
  }
  return { today, week, historical }
}

/**
 * LIVE balances subscription for the Reports screen. Mirrors subscribeWorkers'
 * shape (a cb plus an optional onError, returns the unsubscribe fn). Reads ONLY —
 * writes nothing and stores no counter (invariant #6): every count is DERIVED
 * from `assignments` on each emit.
 *
 * The query is a SINGLE range filter (timestamp >= historicalStart), so no
 * composite index is required. The query's lower bound is captured once at
 * subscribe time; the three bucket boundaries, however, are RECOMPUTED from
 * `new Date()` on every emit, so a day/week rollover is reflected on the next
 * change. If the week rolls over mid-session the captured query start is slightly
 * older than the fresh historicalStart — harmless, because bucketCounts re-filters
 * every row against the fresh boundary (a few extra-old docs get fetched but are
 * never counted).
 *
 * Each doc is read with { serverTimestamps: 'estimate' } so a just-Assigned case
 * counts immediately (its estimate ≈ now buckets into today/week/historical
 * correctly); timestamp is normalized to millis (or null) exactly like
 * subscribeAssignments. Contains no set/add/update/delete/runTransaction/
 * serverTimestamp call.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {(balances: {today: Map<string,number>, week: Map<string,number>, historical: Map<string,number>, boundaries: {todayStart: Date, weekStart: Date, historicalStart: Date}}) => void} cb
 * @param {{onError?: (err: Error) => void, historicalWeeks?: number}} [opts]
 * @returns {import('firebase/firestore').Unsubscribe}
 */
export function subscribeBalances(
  db,
  cb,
  { onError, historicalWeeks = DEFAULT_HISTORICAL_WEEKS } = {},
) {
  const queryStart = rollingWeeksStart(historicalWeeks)
  const q = query(
    collection(db, 'assignments'),
    where('timestamp', '>=', Timestamp.fromDate(queryStart)),
  )
  return onSnapshot(
    q,
    (snap) => {
      // Recompute all three boundaries from the current instant on every emit, so
      // a day/week rollover is picked up without re-subscribing.
      const now = new Date()
      const todayStart = startOfTodayMidnight(now)
      const weekStart = mostRecentMondayMidnight(now)
      const historicalStart = rollingWeeksStart(historicalWeeks, now)
      const rows = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: 'estimate' })
        return {
          workerId: data.workerId,
          timestampMs: data.timestamp?.toMillis?.() ?? null,
        }
      })
      const { today, week, historical } = bucketCounts(rows, {
        todayStart,
        weekStart,
        historicalStart,
      })
      cb({ today, week, historical, boundaries: { todayStart, weekStart, historicalStart } })
    },
    (err) => onError && onError(err),
  )
}

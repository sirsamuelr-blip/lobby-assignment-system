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
} from 'firebase/firestore'
import { mostRecentMondayMidnight } from './week.js'

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

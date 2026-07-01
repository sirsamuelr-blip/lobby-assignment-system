// src/lib/unavailable.js — the Temp-unavailable (clerk-set, 30-min) state.
//
// A clerk can mark a SUGGESTED worker temporarily unavailable — a fixed staffing
// reason (away from desk, busy with a client, left for the day) — and the case is
// instantly re-suggested to the next-lowest worker. Like Pending, exclusion is
// enforced QUERY-TIME: a worker is temp-unavailable iff a temp doc for them has
// `until` STRICTLY in the future. No client timer is the source of truth — a tab
// that dies still auto-returns the worker to the pool when the doc expires. This
// mirrors pending.js, minus the concurrency guard: temp-unavailability is GLOBAL
// (no clerkId, everyone's pool excludes them) and set last-write-wins (a plain
// `setDoc`, no transaction) — there is no race between clerks to arbitrate.
//
// CLAUDE.md invariants honored here:
//   #2  Marking temp-unavailable NEVER changes a count. It only writes a
//       liveState doc; the weekly count derives solely from `assignments`.
//   #1/#3  No PII: the doc holds a FIXED staffing reason, never client data.

import {
  collection,
  query,
  where,
  doc,
  getDocsFromServer,
  onSnapshot,
  setDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'

// 30-minute temp-unavailable window (CLAUDE.md worker-states table). `until` is
// client-computed as Date.now() + TEMP_UNAVAIL_TTL_MS (acceptable for a single,
// clock-synced office); markedAt is the server-authoritative record.
export const TEMP_UNAVAIL_TTL_MS = 30 * 60 * 1000

// Deterministic per-worker doc id → "one temp-unavailable per worker". Distinct
// prefix from pending's `pending_<id>` so the two liveState kinds never collide.
export const tempUnavailDocId = (workerId) => `tempunavail_${workerId}`

// `until` may arrive as a Firestore Timestamp ({toMillis}), a Date, or a raw
// millis number. Normalize to millis; a missing/invalid value → NaN, which every
// `> now` comparison treats as already-expired (the safe direction). Kept LOCAL
// (not imported from pending.js) so this module stands on its own.
function untilToMillis(until) {
  if (until && typeof until.toMillis === 'function') return until.toMillis()
  return +until
}

/**
 * PURE. Given raw temp-unavailable-doc data objects, return the workerIds whose
 * window is still active (`until` STRICTLY in the future). Deduped. This is the
 * single source of truth for "who is temp-unavailable" — the pool excludes
 * exactly these.
 */
export function activeTempUnavailableIds(docs, now = new Date()) {
  const nowMs = +now
  const ids = new Set()
  for (const d of docs ?? []) {
    if (!d || !d.workerId) continue
    if (untilToMillis(d.until) > nowMs) ids.add(d.workerId)
  }
  return [...ids]
}

/**
 * The query-time exclusion set, read FROM SERVER so a mark another clerk just
 * wrote is seen immediately (mirrors getPendingIds' getDocsFromServer reasoning —
 * reading cache could re-suggest a worker someone else just parked).
 */
export async function getTempUnavailableIds(db, now = new Date()) {
  // Single equality filter (kind == 'tempUnavailable') → no composite index.
  const q = query(collection(db, 'liveState'), where('kind', '==', 'tempUnavailable'))
  const snap = await getDocsFromServer(q)
  return activeTempUnavailableIds(
    snap.docs.map((d) => d.data()),
    now,
  )
}

/**
 * Mark a worker temp-unavailable for TEMP_UNAVAIL_TTL_MS. A plain `setDoc`
 * (last-write-wins) of the FULL doc shape — kind/workerId/reason MUST all be
 * written or the kind=='tempUnavailable' query returns nothing. Marking NEVER
 * touches a count (invariant #2); it only writes this one liveState doc.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {object} args
 * @param {string} args.workerId
 * @param {string} args.reason  a FIXED staffing reason — never client PII
 * @returns {Promise<void>}
 */
export async function markTempUnavailable(db, { workerId, reason }) {
  const ref = doc(db, 'liveState', tempUnavailDocId(workerId))
  await setDoc(ref, {
    kind: 'tempUnavailable',
    workerId,
    reason,
    until: Timestamp.fromMillis(Date.now() + TEMP_UNAVAIL_TTL_MS),
    markedAt: serverTimestamp(),
  })
}

/**
 * Live subscription for the Roster/Live Status tab. Hands `cb` the array of
 * temp-unavailable-doc data objects on every change; returns the unsubscribe fn.
 */
export function subscribeTempUnavailable(db, cb) {
  const q = query(collection(db, 'liveState'), where('kind', '==', 'tempUnavailable'))
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data())))
}

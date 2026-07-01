// src/lib/pending.js — the Pending state + the multi-clerk concurrency guard.
//
// A worker goes Pending the instant they are SUGGESTED — before the clerk
// confirms — so a second clerk entering a case a moment later cannot be handed
// the same person (spec §6 concurrency). Pending lives in the `liveState`
// collection, one doc per worker at the DETERMINISTIC id `pending_<workerId>`,
// which is how "one pending per worker" is enforced structurally.
//
// CLAUDE.md invariants honored here:
//   #2  Pending NEVER changes a count. Going pending only writes a liveState
//       doc; the count is derived from `assignments` and only createAssignment
//       adds one. There is no counter to bump on suggest/expire/release.
//   #3/#4  Pool exclusion is QUERY-TIME: a worker is pending iff a pending doc
//       for them has expiresAt > now. We never rely on a client timer firing or
//       a delete succeeding — a tab that dies still auto-releases when its claim
//       expires. `activePendingIds` is the single pure definition of "expired".
//
// The ticket is NOT allocated here. It is issued at ASSIGN time (assignments.js)
// so the sequence stays dense — abandoned or re-picked pending cases never burn a
// number. A pending doc therefore carries no ticket; the weekly count is
// unaffected either way (it derives from `assignments`).

import {
  collection,
  query,
  where,
  doc,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  deleteDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { suggestWorker } from './selection.js'

// 10-minute pending window (spec §5). expiresAt is client-computed as
// Date.now() + PENDING_TTL_MS (acceptable for a single, clock-synced office);
// suggestedAt is the server-authoritative record.
export const PENDING_TTL_MS = 10 * 60 * 1000

// Deterministic per-worker doc id → "one pending per worker". Shared with
// assignments.js so the id scheme is defined exactly once (no drift).
export const pendingDocId = (workerId) => `pending_${workerId}`

// expiresAt may arrive as a Firestore Timestamp ({toMillis}), a Date, or a raw
// millis number. Normalize to millis; a missing/invalid value → NaN, which every
// `> now` comparison treats as already-expired (the safe direction).
function expiresToMillis(expiresAt) {
  if (expiresAt && typeof expiresAt.toMillis === 'function') return expiresAt.toMillis()
  return +expiresAt
}

/**
 * PURE. Given raw pending-doc data objects, return the workerIds whose claim is
 * still active (expiresAt STRICTLY in the future). Deduped. This is the single
 * source of truth for "who is pending" — the pool excludes exactly these.
 */
export function activePendingIds(docs, now = new Date()) {
  const nowMs = +now
  const ids = new Set()
  for (const d of docs ?? []) {
    if (!d || !d.workerId) continue
    if (expiresToMillis(d.expiresAt) > nowMs) ids.add(d.workerId)
  }
  return [...ids]
}

/**
 * The query-time exclusion set, read FROM SERVER so a claim another clerk just
 * wrote is seen immediately (mirrors counts.js' getDocsFromServer reasoning —
 * reading cache could hand out a worker someone else just claimed).
 */
export async function getPendingIds(db, now = new Date()) {
  // Single equality filter (kind == 'pending') → no composite index needed.
  const q = query(collection(db, 'liveState'), where('kind', '==', 'pending'))
  const snap = await getDocsFromServer(q)
  return activePendingIds(
    snap.docs.map((d) => d.data()),
    now,
  )
}

/**
 * PURE. From raw pending-doc data, pick THIS clerk's single unexpired claim (one
 * client at a time per clerk). Used to restore an in-progress case after a page
 * reload, since the pending doc outlives the tab's React state.
 *
 * @param {Array<object>} docs
 * @param {string} clerkId
 * @param {Date|number} [now]
 * @returns {{workerId: string, programs: string[], expiresAtMs: number} | null}
 */
export function pickMyPendingClaim(docs, clerkId, now = new Date()) {
  const nowMs = +now
  for (const d of docs ?? []) {
    if (!d || d.clerkId !== clerkId || !d.workerId) continue
    const expMs = expiresToMillis(d.expiresAt)
    if (expMs > nowMs) {
      return {
        workerId: d.workerId,
        programs: Array.isArray(d.programs) ? d.programs : [],
        expiresAtMs: expMs,
      }
    }
  }
  return null
}

/**
 * Server-read wrapper around pickMyPendingClaim (single kind=='pending' equality
 * → no composite index; clerkId filtered in memory). Mirrors getPendingIds'
 * getDocsFromServer so a just-written claim is seen immediately.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} clerkId
 * @param {Date|number} [now]
 * @returns {Promise<{workerId: string, programs: string[], expiresAtMs: number} | null>}
 */
export async function getMyPendingClaim(db, clerkId, now = new Date()) {
  const q = query(collection(db, 'liveState'), where('kind', '==', 'pending'))
  const snap = await getDocsFromServer(q)
  return pickMyPendingClaim(
    snap.docs.map((d) => d.data()),
    clerkId,
    now,
  )
}

/**
 * Transactionally CLAIM a worker as pending — the concurrency guard itself.
 *
 * Reads pending_<workerId> before writing:
 *   • held by ANOTHER clerk & unexpired → { claimed: false } (they win the race)
 *   • held by US & unexpired → refresh the 10-min window
 *   • free / expired → take it
 *
 * Going pending NEVER touches a count OR a ticket (invariant #2) — it only writes
 * the liveState doc. The ticket is issued later, at Assign.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {object} args
 * @param {string} args.workerId
 * @param {string} args.clerkId
 * @param {string[]} args.programs
 * @returns {Promise<{claimed: boolean}>}
 */
export async function claimWorker(db, { workerId, clerkId, programs }) {
  const pendingRef = doc(db, 'liveState', pendingDocId(workerId))

  return runTransaction(db, async (tx) => {
    const nowMs = Date.now()

    // READ first (Firestore requires all reads before any writes).
    const pendingSnap = await tx.get(pendingRef)
    if (pendingSnap.exists()) {
      const data = pendingSnap.data()
      if (expiresToMillis(data.expiresAt) > nowMs) {
        if (data.clerkId === clerkId) {
          // A re-suggest landed back on OUR OWN worker: refresh the window.
          tx.set(
            pendingRef,
            { expiresAt: Timestamp.fromMillis(nowMs + PENDING_TTL_MS) },
            { merge: true },
          )
          return { claimed: true }
        }
        // Another clerk holds an active claim on this worker — we lost the race.
        return { claimed: false }
      }
      // An expired stale doc: fall through and overwrite it (reclaim).
    }

    tx.set(pendingRef, {
      kind: 'pending',
      workerId,
      programs, // for the pending-list / Roster display; NOT PII
      clerkId,
      suggestedAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(nowMs + PENDING_TTL_MS),
    })
    return { claimed: true }
  })
}

/**
 * Best-effort immediate release (courtesy only). Correctness relies on the
 * expiresAt query-time filter, so a failed or no-op delete is harmless — the
 * claim simply expires within the 10-minute window.
 */
export async function releasePending(db, workerId) {
  try {
    await deleteDoc(doc(db, 'liveState', pendingDocId(workerId)))
  } catch {
    // Swallow — see above; the expiry filter is the real release mechanism.
  }
}

/**
 * Live subscription for the Roster/Live Status tab. Hands `cb` the array of
 * pending-doc data objects on every change; returns the unsubscribe fn.
 */
export function subscribePending(db, cb) {
  const q = query(collection(db, 'liveState'), where('kind', '==', 'pending'))
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data())))
}

/**
 * Orchestrate suggest → claim with a bounded race re-pick, so the re-pick loop is
 * unit-testable without Firestore (inject `claimFn`). If a suggested worker is
 * claimed by another clerk between our suggest and our claim, exclude them and
 * re-pick the next-lowest — repeating until we win a claim or run out.
 *
 * @returns {Promise<{ok:true, worker: object} | {ok:false, message:string}>}
 */
export async function suggestAndClaim({
  workers,
  weeklyCounts,
  pendingIds,
  tempUnavailableIds = [],
  programs,
  clerkId,
  db,
  claimFn = (args) => claimWorker(db, args),
}) {
  const cap = (workers?.length ?? 0) + 2 // bounded — never spin forever
  const taken = new Set()
  for (let i = 0; i < cap; i++) {
    const s = suggestWorker({
      workers,
      weeklyCounts,
      programs,
      // Pending (+ race-taken) and temp-unavailable are SEPARATE exclusion sets —
      // pass each straight through; suggestWorker unions them internally. Merging
      // here would be harmless today but blurs two distinct states.
      pendingIds: [...(pendingIds ?? []), ...taken],
      tempUnavailableIds,
    })
    if (!s.ok) return s // e.g. "No staff available…" — short-circuit, no claim
    const r = await claimFn({ workerId: s.worker.id, clerkId, programs })
    if (r && r.claimed) return { ok: true, worker: s.worker }
    taken.add(s.worker.id) // someone beat us → exclude and re-pick next-lowest
  }
  return { ok: false, message: 'Could not claim a worker — please retry.' }
}

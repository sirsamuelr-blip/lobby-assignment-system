// src/lib/assignments.js — write a confirmed assignment (the count++ moment).
//
// CLAUDE.md invariants:
//   #1  NO CLIENT PII, EVER. The assignment doc contains ONLY the six fields
//       below. The EWMS case number / client name live solely in the Teams
//       message the clerk pastes — never here. Do NOT add a case field.
//   #2  The count increments ONLY on a confirmed Assign (this function). The
//       weekly count is derived from these docs (counts.js), so simply writing
//       one IS the increment — there is no separate counter to bump. Going
//       Pending must never reach here.
//   #6  `assignments` is the single source of truth.
//
// The ticket is allocated HERE, on the confirmed Assign, so the sequence stays
// dense — abandoned or re-picked pending cases never burn a number. The
// transaction first VERIFIES the pending claim (still ours, still unexpired) —
// throwing BEFORE it reads the counter so a failed Assign can't consume a ticket
// — then writes the assignment, advances the counter, and clears the pending doc
// atomically. Pending never increments a count.
//
// REASSIGN (invariant #8): reassignAssignment re-attributes an EXISTING doc to a
// different worker — it writes NO new doc, no counter, and no ticket. Because the
// weekly count is DERIVED per workerId (counts.js), simply changing `workerId` IS
// the correction: the wrongly-credited worker drops −1 and the new one gains +1,
// net-zero, with no stored tally to reconcile. A reassigned doc additionally
// carries `reassignedFrom` — the previous worker's id, a STAFF workerId, still
// never any client data (invariant #1) — and is forced manual:true (a human
// correction). Its ticket and timestamp are left untouched (same case).

import {
  doc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import { TICKET_COUNTER, advanceTicket } from './tickets.js'
import { pendingDocId } from './pending.js'

/**
 * Log a confirmed assignment and return its ticket.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {object} args
 * @param {string[]} args.programs one or more of 'snap' | 'tanf' | 'mepd' | 'medicaid'
 *                                  (the whole case goes to ONE worker → +1, per
 *                                  case, never per program)
 * @param {string} args.workerId  the assigned worker's id
 * @param {string} args.clerkId   the acting clerk's id (per-tab dev id for now)
 * @param {boolean} [args.manual] true for an override (Phase 6); default false
 * @returns {Promise<{ticket: number, id: string}>}
 */
export async function createAssignment(db, { programs, workerId, clerkId, manual = false }) {
  if (!Array.isArray(programs) || programs.length === 0) {
    throw new Error('createAssignment: programs must be a non-empty array')
  }
  if (!clerkId) {
    throw new Error('createAssignment: clerkId is required')
  }

  const pendingRef = doc(db, 'liveState', pendingDocId(workerId))
  const counterRef = doc(db, TICKET_COUNTER.collection, TICKET_COUNTER.doc)
  const assignmentRef = doc(collection(db, 'assignments')) // auto-id

  const ticket = await runTransaction(db, async (tx) => {
    const nowMs = Date.now()

    // Verify the pending claim BEFORE reading the counter, so a failed Assign
    // never burns a ticket number. If it's gone, expired, or now held by another
    // clerk, this worker may already be taken elsewhere — bail so the caller
    // re-suggests instead of double-assigning.
    const pendingSnap = await tx.get(pendingRef)
    const data = pendingSnap.exists() ? pendingSnap.data() : null
    const exp = data?.expiresAt
    const expMs = exp && typeof exp.toMillis === 'function' ? exp.toMillis() : +exp
    if (!data || !(expMs > nowMs) || data.clerkId !== clerkId) {
      throw new Error('Claim expired or reassigned — re-suggesting.')
    }

    // Allocate the ticket now (only confirmed Assigns consume a number). All
    // reads (pending, counter) precede all writes — Firestore requires it.
    const counterSnap = await tx.get(counterRef)
    const currentNext = counterSnap.exists()
      ? counterSnap.data()[TICKET_COUNTER.field]
      : undefined
    const { ticket, next } = advanceTicket(currentNext)

    // The ENTIRE assignment document. Six fields. No case number, no name, no
    // client data of any kind (invariant #1). One case → one doc → +1, even when
    // `programs` lists several.
    tx.set(assignmentRef, {
      ticket,
      timestamp: serverTimestamp(),
      programs,
      workerId,
      clerkId,
      manual,
    })
    tx.set(counterRef, { [TICKET_COUNTER.field]: next }, { merge: true })
    // Clear the pending claim in the SAME transaction: the +1 (this doc) and the
    // release happen atomically, and pending itself never increments a count.
    tx.delete(pendingRef)

    return ticket
  })

  return { ticket, id: assignmentRef.id }
}

/**
 * Re-attribute an EXISTING assignment to a different worker — a human correction
 * of a wrong-worker Assign (invariant #8). This writes NO new assignment, no
 * counter, and no ticket: the weekly count is DERIVED per workerId (counts.js),
 * so changing `workerId` IS the correction — the wrongly-credited worker drops
 * −1 and the new worker gains +1, net-zero, with nothing to reconcile.
 *
 * The doc's `ticket` and `timestamp` are left untouched (it is the same case).
 * The only new field is `reassignedFrom`, the previous worker's id — a STAFF
 * workerId, never a case number or client name (invariant #1). `manual` is forced
 * true, because a reassign is always a human override. A single-doc update: no
 * transaction is needed (no counter, no pending claim to reconcile atomically).
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {object} args
 * @param {string} args.assignmentId  the existing assignment doc id
 * @param {string} args.fromWorkerId  the wrongly-credited worker (recorded as reassignedFrom)
 * @param {string} args.toWorkerId    the worker who should hold the case
 * @returns {Promise<void>}
 */
export async function reassignAssignment(db, { assignmentId, fromWorkerId, toWorkerId }) {
  if (!assignmentId) throw new Error('reassignAssignment: assignmentId is required')
  if (!toWorkerId) throw new Error('reassignAssignment: toWorkerId is required')
  if (fromWorkerId === toWorkerId) {
    throw new Error('reassignAssignment: already assigned to that advisor')
  }
  await updateDoc(doc(db, 'assignments', assignmentId), {
    workerId: toWorkerId,
    manual: true,
    reassignedFrom: fromWorkerId,
  })
}

// ---------------------------------------------------------------------------
// READ-ONLY subscription over `assignments` — for the Log / Reports views.
//
// This is purely a READ over the single source of truth (invariant #6): it
// writes NOTHING, derives NOTHING about counts, and never touches a counter, a
// pending doc, or a ticket. Weekly counts still derive from these same docs via
// counts.js; this subscription only mirrors the raw rows, newest first, for a
// chronological record. Safe to mount from any read-only screen. There is no
// set / add / update / delete / runTransaction / serverTimestamp call below.
// ---------------------------------------------------------------------------

/**
 * Live subscription over the `assignments` collection, newest first. Mirrors
 * subscribeWorkers' shape: hands `cb` the array of normalized rows on every
 * change and forwards a subscription error to `onError` (optional). Returns the
 * unsubscribe fn. Capped at the 200 most recent docs so the Log stays light.
 *
 * Each doc is read with the ESTIMATE serverTimestamps option so a just-written
 * `serverTimestamp` renders immediately (as the client's best estimate) instead
 * of arriving null on the first local snapshot; `timestamp` is still tolerated
 * as null defensively and normalized to millis (or null).
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {(rows: Array<{id: string, ticket: number, timestamp: number|null, programs: string[], workerId: string, clerkId: string, manual: boolean, reassignedFrom?: string}>) => void} cb
 * @param {(err: Error) => void} [onError]
 * @returns {import('firebase/firestore').Unsubscribe}
 */
export function subscribeAssignments(db, cb, onError) {
  const q = query(collection(db, 'assignments'), orderBy('timestamp', 'desc'), limit(200))
  return onSnapshot(
    q,
    (snap) =>
      cb(
        snap.docs.map((d) => {
          const data = d.data({ serverTimestamps: 'estimate' })
          return {
            id: d.id,
            ticket: data.ticket,
            // Tolerate a still-null serverTimestamp defensively (estimate should
            // fill it, but never call .toMillis on a null).
            timestamp: data.timestamp?.toMillis?.() ?? null,
            programs: data.programs,
            workerId: data.workerId,
            clerkId: data.clerkId,
            manual: data.manual,
            reassignedFrom: data.reassignedFrom,
          }
        }),
      ),
    (err) => onError && onError(err),
  )
}

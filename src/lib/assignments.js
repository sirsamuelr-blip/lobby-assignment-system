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

import { doc, collection, runTransaction, serverTimestamp } from 'firebase/firestore'
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

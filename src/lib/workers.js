// src/lib/workers.js — the worker roster: reads + the Admin CRUD writers.
//
// The roster is seeded in Phase 1 (scripts/seed.js). Phase 5b's Admin page adds
// and edits workers through the writers below. Every returned/stored object
// carries `id` (the doc id, which EQUALS the stored `id` field) plus the roster
// attributes.
//
// CLAUDE.md invariants honored here:
//   #1  No PII: a worker doc carries only firstName, lastName, eaLevel, programs
//       (the four training booleans), and active. Never client data.
//   #2  No writer here EVER touches a count. Counts derive from `assignments`;
//       editing the roster changes eligibility, never a tally.
//   #3 (deactivate, never delete)  Workers are deactivated (active:false), NEVER
//       hard-deleted — assignment history and count derivation reference workerId
//       forever, so a removed worker would orphan those docs. setWorkerActive is
//       the only "remove from service" path.

import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  updateDoc,
} from 'firebase/firestore'

/**
 * Read every worker doc (one-shot). Each returned object carries `id` (the doc
 * id) plus the roster attributes. Used by Assign for its fresh-roster read.
 * @param {import('firebase/firestore').Firestore} db
 * @returns {Promise<Array<{id: string, firstName: string, lastName: string, eaLevel: number, programs: object, active: boolean}>>}
 */
export async function getAllWorkers(db) {
  const snap = await getDocs(collection(db, 'workers'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * Live subscription over the whole `workers` collection (Roster + Admin). Hands
 * `cb` the array of {id, ...data} on every change; `onError` (optional) receives
 * a subscription error so the caller can surface it. Returns the unsubscribe fn.
 * Mirrors subscribePending/subscribeUnavailability.
 */
export function subscribeWorkers(db, cb, onError) {
  return onSnapshot(
    collection(db, 'workers'),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err),
  )
}

/**
 * Add or edit a worker. Writes ONLY the documented roster fields — never a count,
 * never client data (invariants #1/#2).
 *
 *   • New worker (falsy `worker.id`): mint an auto doc id, then store it back into
 *     the doc's own `id` field so the id === docId invariant holds.
 *   • Existing worker (`worker.id` present): overwrite that doc with the full
 *     canonical shape.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {{id?: string, firstName: string, lastName: string, eaLevel: number, programs: object, active: boolean}} worker
 * @returns {Promise<string>} the worker's doc id
 */
export async function upsertWorker(db, worker) {
  const { firstName, lastName, eaLevel, programs, active } = worker
  if (!worker.id) {
    const ref = doc(collection(db, 'workers'))
    await setDoc(ref, { id: ref.id, firstName, lastName, eaLevel, programs, active })
    return ref.id
  }
  await setDoc(doc(db, 'workers', worker.id), {
    id: worker.id,
    firstName,
    lastName,
    eaLevel,
    programs,
    active,
  })
  return worker.id
}

/**
 * Deactivate (active:false) or reactivate (active:true) a worker. This is the
 * ONLY "remove from service" path — there is deliberately no delete, so no
 * assignment doc is ever left pointing at a missing workerId (invariant #3).
 * Touches only the `active` flag; never a count.
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} id
 * @param {boolean} active
 */
export async function setWorkerActive(db, id, active) {
  await updateDoc(doc(db, 'workers', id), { active })
}

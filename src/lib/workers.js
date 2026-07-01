// src/lib/workers.js — read the worker roster from Firestore.
//
// The roster is seeded in Phase 1 (scripts/seed.js) and edited via the Admin
// page in Phase 5. Here we only read it. Each returned object carries `id` (the
// doc id, which equals the stored `id` field) plus the roster attributes.

import { collection, getDocs } from 'firebase/firestore'

/**
 * Read every worker doc.
 * @param {import('firebase/firestore').Firestore} db
 * @returns {Promise<Array<{id: string, firstName: string, lastName: string, eaLevel: number, programs: object, active: boolean}>>}
 */
export async function getAllWorkers(db) {
  const snap = await getDocs(collection(db, 'workers'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'

const PROJECT_ID = 'lobby-assignment-rules-test'
const CLERK_UID = 'clerk-uid-1'
const CLERK2_UID = 'clerk-uid-2'
const SUP_UID = 'sup-uid-1'

let testEnv
let clerkDb   // authed as a clerk
let supDb     // authed as a supervisor
let anonDb    // unauthenticated

const okAssignment = (clerkId = CLERK_UID) => ({
  ticket: 1,
  timestamp: new Date(),
  programs: ['snap'],
  workerId: 'worker-01',
  clerkId,
  manual: false,
})

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  })
  clerkDb = testEnv.authenticatedContext(CLERK_UID).firestore()
  supDb = testEnv.authenticatedContext(SUP_UID).firestore()
  anonDb = testEnv.unauthenticatedContext().firestore()
})

afterAll(async () => {
  await testEnv.cleanup()
})

// Fresh data each test: seed the two role docs and one existing assignment with
// rules DISABLED, so the tests exercise ONLY the operation under assertion.
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'users', CLERK_UID), { uid: CLERK_UID, name: 'C', role: 'clerk' })
    await setDoc(doc(db, 'users', CLERK2_UID), { uid: CLERK2_UID, name: 'C2', role: 'clerk' })
    await setDoc(doc(db, 'users', SUP_UID), { uid: SUP_UID, name: 'S', role: 'supervisor' })
    await setDoc(doc(db, 'assignments', 'a1'), okAssignment())
  })
})

describe('reads', () => {
  it('unauthenticated cannot read workers', async () => {
    await assertFails(getDoc(doc(anonDb, 'workers', 'worker-01')))
  })
  it('a clerk can read workers', async () => {
    await assertSucceeds(getDoc(doc(clerkDb, 'workers', 'worker-01')))
  })
})

describe('workers / unavailability are supervisor-only', () => {
  it('a clerk CANNOT write a worker', async () => {
    await assertFails(
      setDoc(doc(clerkDb, 'workers', 'worker-99'), {
        id: 'worker-99', firstName: 'A', lastName: 'B', eaLevel: 1,
        programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true,
      }),
    )
  })
  it('a supervisor CAN write a worker', async () => {
    await assertSucceeds(
      setDoc(doc(supDb, 'workers', 'worker-99'), {
        id: 'worker-99', firstName: 'A', lastName: 'B', eaLevel: 1,
        programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true,
      }),
    )
  })
  it('a supervisor CANNOT sneak an extra field into a worker', async () => {
    await assertFails(
      setDoc(doc(supDb, 'workers', 'worker-99'), {
        id: 'worker-99', firstName: 'A', lastName: 'B', eaLevel: 1,
        programs: { snap: true, tanf: false, mepd: false, medicaid: false },
        active: true, clientName: 'SHOULD NOT BE HERE',
      }),
    )
  })
  it('a clerk CANNOT write an unavailability entry', async () => {
    await assertFails(
      setDoc(doc(clerkDb, 'unavailability', 'u1'), {
        workerId: 'worker-01', type: 'pto', mode: 'single', date: '2026-07-01',
      }),
    )
  })
  it('a supervisor CAN write an unavailability entry', async () => {
    await assertSucceeds(
      setDoc(doc(supDb, 'unavailability', 'u1'), {
        workerId: 'worker-01', type: 'pto', mode: 'single', date: '2026-07-01',
      }),
    )
  })
})

describe('assignments (audit log)', () => {
  it('a clerk CAN create an assignment recording themselves', async () => {
    await assertSucceeds(setDoc(doc(clerkDb, 'assignments', 'a2'), okAssignment()))
  })
  it('a clerk CANNOT forge another clerk as the acting clerk', async () => {
    await assertFails(
      setDoc(doc(clerkDb, 'assignments', 'a3'), okAssignment(CLERK2_UID)),
    )
  })
  it('a clerk CANNOT smuggle a client-PII field into an assignment', async () => {
    await assertFails(
      setDoc(doc(clerkDb, 'assignments', 'a4'), {
        ...okAssignment(), clientName: 'Jane Q Public',
      }),
    )
  })
  it('nobody can delete an assignment (append-only)', async () => {
    await assertFails(deleteDoc(doc(clerkDb, 'assignments', 'a1')))
    await assertFails(deleteDoc(doc(supDb, 'assignments', 'a1')))
  })
  it('reassign (change workerId only) is allowed', async () => {
    await assertSucceeds(
      updateDoc(doc(clerkDb, 'assignments', 'a1'), {
        workerId: 'worker-02', manual: true, reassignedFrom: 'worker-01',
      }),
    )
  })
  it('mutating an immutable field (ticket) is denied', async () => {
    await assertFails(updateDoc(doc(clerkDb, 'assignments', 'a1'), { ticket: 999 }))
  })
  it('a clerk CANNOT smuggle a client-PII field via update', async () => {
    await assertFails(
      updateDoc(doc(clerkDb, 'assignments', 'a1'), {
        workerId: 'worker-02', manual: true, reassignedFrom: 'worker-01',
        clientName: 'Jane Q Public',
      }),
    )
  })
})

describe('liveState + counters (staff operational state)', () => {
  it('a clerk CAN write a pending claim', async () => {
    await assertSucceeds(
      setDoc(doc(clerkDb, 'liveState', 'pending_worker-01'), {
        kind: 'pending', workerId: 'worker-01', programs: ['snap'],
        clerkId: CLERK_UID, suggestedAt: new Date(), expiresAt: new Date(Date.now() + 600000),
      }),
    )
  })
  it('unauthenticated CANNOT write liveState', async () => {
    await assertFails(
      setDoc(doc(anonDb, 'liveState', 'pending_worker-01'), { kind: 'pending' }),
    )
  })
})

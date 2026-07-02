import { describe, it, expect } from 'vitest'
import { activePendingIds, pickMyPendingClaim, suggestAndClaim } from './pending.js'
import { ROSTER } from './__fixtures__/roster.js'

// Same style as selection.test.js: a plain object of { workerId: count } with any
// unlisted worker implicitly at 0.
const counts = (overrides = {}) => ({ ...overrides })

describe('activePendingIds — the expiry filter (pool exclusion is query-time)', () => {
  it('keeps only expiresAt STRICTLY in the future; drops expired and exactly-now', () => {
    const now = new Date('2025-06-25T12:00:00Z')
    const nowMs = now.getTime()
    const docs = [
      { workerId: 'future', expiresAt: new Date(nowMs + 1000) },
      { workerId: 'past', expiresAt: new Date(nowMs - 1000) },
      { workerId: 'exactly-now', expiresAt: new Date(nowMs) },
    ]
    expect(activePendingIds(docs, now)).toEqual(['future'])
  })

  it('accepts a Firestore-Timestamp-like value ({toMillis}), a Date, and a raw number', () => {
    const nowMs = 1_000_000
    const now = new Date(nowMs)
    const docs = [
      { workerId: 'ts', expiresAt: { toMillis: () => nowMs + 5000 } },
      { workerId: 'date', expiresAt: new Date(nowMs + 5000) },
      { workerId: 'num', expiresAt: nowMs + 5000 },
      { workerId: 'ts-expired', expiresAt: { toMillis: () => nowMs - 1 } },
    ]
    expect(activePendingIds(docs, now).sort()).toEqual(['date', 'num', 'ts'])
  })

  it('accepts a raw-number `now` as well as a Date', () => {
    const docs = [{ workerId: 'a', expiresAt: 5000 }]
    expect(activePendingIds(docs, 4000)).toEqual(['a'])
    expect(activePendingIds(docs, 6000)).toEqual([])
  })

  it('dedups repeated workerIds', () => {
    const now = new Date(0)
    const docs = [
      { workerId: 'dup', expiresAt: 10_000 },
      { workerId: 'dup', expiresAt: 20_000 },
      { workerId: 'other', expiresAt: 10_000 },
    ]
    expect(activePendingIds(docs, now).sort()).toEqual(['dup', 'other'])
  })

  it('is safe on empty / missing input', () => {
    expect(activePendingIds([], new Date())).toEqual([])
    expect(activePendingIds(undefined, new Date())).toEqual([])
  })
})

describe("pickMyPendingClaim — restore this clerk's own unexpired claim after reload", () => {
  it('returns our unexpired claim as { workerId, programs, expiresAtMs }', () => {
    const now = new Date(1_000_000)
    const nowMs = now.getTime()
    const docs = [
      { clerkId: 'other', workerId: 'worker-02', programs: ['snap'], expiresAt: nowMs + 5000 },
      { clerkId: 'me', workerId: 'worker-01', programs: ['snap', 'mepd'], expiresAt: nowMs + 5000 },
    ]
    expect(pickMyPendingClaim(docs, 'me', now)).toEqual({
      workerId: 'worker-01',
      programs: ['snap', 'mepd'],
      expiresAtMs: nowMs + 5000,
    })
  })

  it("ignores other clerks' claims", () => {
    const now = new Date(0)
    const docs = [
      { clerkId: 'other', workerId: 'worker-01', programs: ['snap'], expiresAt: 10_000 },
    ]
    expect(pickMyPendingClaim(docs, 'me', now)).toBeNull()
  })

  it('ignores our own EXPIRED claim', () => {
    const now = new Date(10_000)
    const docs = [
      { clerkId: 'me', workerId: 'worker-01', programs: ['snap'], expiresAt: 5_000 },
    ]
    expect(pickMyPendingClaim(docs, 'me', now)).toBeNull()
  })

  it('defaults programs to [] when missing; returns null on empty / undefined input', () => {
    const now = new Date(0)
    expect(pickMyPendingClaim([], 'me', now)).toBeNull()
    expect(pickMyPendingClaim(undefined, 'me', now)).toBeNull()
    const docs = [{ clerkId: 'me', workerId: 'worker-01', expiresAt: 10_000 }]
    expect(pickMyPendingClaim(docs, 'me', now)).toEqual({
      workerId: 'worker-01',
      programs: [],
      expiresAtMs: 10_000,
    })
  })
})

describe('suggestAndClaim — suggest + claim with bounded race re-pick (no Firebase)', () => {
  // All counts zero, so SNAP ranks alphabetically by lastName: Alvarez (worker-01)
  // → Bennett (worker-02) → Chen (worker-03) → …
  const base = {
    workers: ROSTER,
    weeklyCounts: counts(),
    pendingIds: [],
    programs: ['snap'],
    clerkId: 'clerk-A',
  }

  it('a claimFn that always claims → returns the lowest-count worker (worker-01)', async () => {
    const claimFn = async () => ({ claimed: true })
    const r = await suggestAndClaim({ ...base, claimFn })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-01')
  })

  it('excludes tempUnavailableIds from the suggestion (worker-01 temp-unavailable → worker-02)', async () => {
    const claimFn = async () => ({ claimed: true })
    const r = await suggestAndClaim({ ...base, tempUnavailableIds: ['worker-01'], claimFn })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-02')
  })

  it('excludes supervisorUnavailableIds from the suggestion (worker-01 out → worker-02)', async () => {
    const claimFn = async () => ({ claimed: true })
    const r = await suggestAndClaim({ ...base, supervisorUnavailableIds: ['worker-01'], claimFn })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-02')
  })

  it('claimFn fails for worker-01 then claims → returns worker-02 (race re-pick excludes the taken worker)', async () => {
    const claimFn = async ({ workerId }) =>
      workerId === 'worker-01' ? { claimed: false } : { claimed: true }
    const r = await suggestAndClaim({ ...base, claimFn })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-02')
  })

  it('claimFn fails for worker-01 AND worker-02 → returns worker-03', async () => {
    const taken = new Set(['worker-01', 'worker-02'])
    const claimFn = async ({ workerId }) =>
      taken.has(workerId) ? { claimed: false } : { claimed: true }
    const r = await suggestAndClaim({ ...base, claimFn })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-03')
  })

  it('a claimFn that always fails → { ok:false } and terminates (bounded, no infinite loop)', async () => {
    let calls = 0
    const claimFn = async () => {
      calls++
      return { claimed: false }
    }
    const r = await suggestAndClaim({ ...base, claimFn })
    expect(r.ok).toBe(false)
    expect(calls).toBeLessThanOrEqual(ROSTER.length + 2)
  })

  it('a no-staff suggestion short-circuits WITHOUT calling claimFn', async () => {
    let called = false
    const claimFn = async () => {
      called = true
      return { claimed: true }
    }
    // MEPD has exactly four trained workers; excluding all of them empties the pool.
    const r = await suggestAndClaim({
      ...base,
      programs: ['mepd'],
      pendingIds: ['worker-05', 'worker-09', 'worker-13', 'worker-19'],
      claimFn,
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
})

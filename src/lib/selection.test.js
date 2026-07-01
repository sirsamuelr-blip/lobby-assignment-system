import { describe, it, expect } from 'vitest'
import { suggestWorker } from './selection.js'
import { ROSTER } from './__fixtures__/roster.js'

// Helper: build a weeklyCounts object from { workerId: count } overrides; any
// worker not listed implicitly counts as 0.
const counts = (overrides = {}) => ({ ...overrides })

describe('suggestWorker — selection key (weeklyCount ASC → lastName ASC → firstName ASC)', () => {
  it('all counts 0: SNAP suggests Maria Alvarez (worker-01)', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['snap'] })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-01')
    expect(`${r.worker.firstName} ${r.worker.lastName}`).toBe('Maria Alvarez')
  })

  it('all counts 0: MEPD suggests Aisha Edwards (worker-05)', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['mepd'] })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-05')
    expect(`${r.worker.firstName} ${r.worker.lastName}`).toBe('Aisha Edwards')
  })

  it('count-wins: Alvarez at 1, rest 0 → SNAP suggests James Bennett (worker-02)', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts({ 'worker-01': 1 }),
      programs: ['snap'],
    })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-02')
  })

  it('count-wins chain: Alvarez & Bennett at 1 → SNAP suggests Priya Chen (worker-03)', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts({ 'worker-01': 1, 'worker-02': 1 }),
      programs: ['snap'],
    })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-03')
  })

  it('a higher count is never preferred even when alphabetically first', () => {
    // Alvarez sorts first alphabetically, but at count 2 she must lose to anyone
    // with a lower count. Bennett (0) wins.
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts({ 'worker-01': 2 }),
      programs: ['snap'],
    })
    expect(r.worker.id).toBe('worker-02')
  })

  it('accepts a Map for weeklyCounts as well as a plain object', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: new Map([['worker-01', 1]]),
      programs: ['snap'],
    })
    expect(r.worker.id).toBe('worker-02')
  })

  it('does not mutate the caller-supplied workers array', () => {
    const before = ROSTER.map((w) => w.id)
    suggestWorker({ workers: ROSTER, weeklyCounts: counts({ 'worker-01': 5 }), programs: ['snap'] })
    expect(ROSTER.map((w) => w.id)).toEqual(before)
  })
})

describe('suggestWorker — tiebreaks', () => {
  it('lastName breaks a count tie (covered by all-zero SNAP → Alvarez before Bennett)', () => {
    // Alvarez and Bennett both at 0; Alvarez wins on lastName.
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['snap'] })
    expect(r.worker.lastName).toBe('Alvarez')
  })

  it('firstName breaks a tie when count AND lastName are equal', () => {
    // Two workers share lastName "Smith" and both count 0 → firstName decides.
    const fixture = [
      { id: 'w-bob', firstName: 'Bob', lastName: 'Smith', eaLevel: 1, programs: { snap: true }, active: true },
      { id: 'w-ann', firstName: 'Ann', lastName: 'Smith', eaLevel: 1, programs: { snap: true }, active: true },
    ]
    const r = suggestWorker({ workers: fixture, weeklyCounts: counts(), programs: ['snap'] })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('w-ann') // Ann < Bob
  })
})

describe('suggestWorker — program filter', () => {
  it('a worker not trained in a program is never suggested for it', () => {
    // worker-02 (Bennett) is SNAP-only. For MEPD he must never appear, even if
    // every MEPD-trained worker has a high count.
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts({ 'worker-05': 9, 'worker-09': 9, 'worker-13': 9, 'worker-19': 9 }),
      programs: ['mepd'],
    })
    expect(r.ok).toBe(true)
    // Only the four MEPD-trained workers are eligible; Bennett is not among them.
    expect(['worker-05', 'worker-09', 'worker-13', 'worker-19']).toContain(r.worker.id)
    expect(r.worker.id).not.toBe('worker-02')
  })

  it('the GLOBAL weekly count ranks across programs (not filtered by program)', () => {
    // All four MEPD-trained workers; give Edwards (normally first) a high global
    // count and the next-alphabetical, Ibarra, wins despite being MEPD-trained too.
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts({ 'worker-05': 3 }),
      programs: ['mepd'],
    })
    expect(r.worker.id).toBe('worker-09') // Ibarra, count 0
  })
})

describe('suggestWorker — multi-program cases (intersection of training)', () => {
  // One case may cover several programs; ONE advisor trained in ALL of them takes
  // it. Eligibility is the intersection of each program's trained set.

  it('single-element array behaves exactly like the old single-program call', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['snap'] })
    expect(r.worker.id).toBe('worker-01') // Alvarez, unchanged
  })

  it("['mepd'] → Aisha Edwards (worker-05)", () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['mepd'] })
    expect(r.worker.id).toBe('worker-05')
  })

  it("['snap','mepd'] → Edwards (worker-05): Alvarez is excluded for lacking MEPD", () => {
    // Proves the intersection narrows the pool. Alvarez would WIN a snap-only
    // case (sorts first), but she is not MEPD-trained, so SNAP+MEPD drops her and
    // the first MEPD-trained worker, Edwards, takes the whole case.
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['snap', 'mepd'] })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-05')
    // Sanity: Alvarez really is the snap-only winner she's being beaten out from.
    const snapOnly = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: ['snap'] })
    expect(snapOnly.worker.id).toBe('worker-01')
  })

  it("['snap','tanf','mepd','medicaid'] → Edwards (worker-05): only Edwards & Martin qualify, Edwards wins on lastName", () => {
    // Of the four MEPD-trained workers, only Edwards and Martin are also trained
    // in TANF (Ibarra and Silva are not), so the all-four intersection is just
    // those two; Edwards < Martin on lastName.
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts(),
      programs: ['snap', 'tanf', 'mepd', 'medicaid'],
    })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-05')
  })

  it('all-four case with Edwards excluded → Martin (worker-13), the only other all-four worker', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts(),
      programs: ['snap', 'tanf', 'mepd', 'medicaid'],
      pendingIds: ['worker-05'],
    })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('worker-13')
  })

  it('intersection-empty: a snap-only and an mepd-only worker yield no staff for [snap, mepd]', () => {
    const fixture = [
      { id: 'snap-only', firstName: 'Sam', lastName: 'Snapper', eaLevel: 1, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
      { id: 'mepd-only', firstName: 'Mia', lastName: 'Mendez', eaLevel: 1, programs: { snap: false, tanf: false, mepd: true, medicaid: false }, active: true },
    ]
    const r = suggestWorker({ workers: fixture, weeklyCounts: counts(), programs: ['snap', 'mepd'] })
    expect(r).toEqual({ ok: false, message: 'No staff available for SNAP + MEPD' })
  })
})

describe('suggestWorker — empty or invalid program selection', () => {
  it('an empty programs array returns { ok:false, message:"No program selected" }', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: [] })
    expect(r).toEqual({ ok: false, message: 'No program selected' })
  })

  it('a missing/undefined programs argument returns the "No program selected" message', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts() })
    expect(r).toEqual({ ok: false, message: 'No program selected' })
  })

  it('a non-array programs argument returns the "No program selected" message', () => {
    const r = suggestWorker({ workers: ROSTER, weeklyCounts: counts(), programs: 'snap' })
    expect(r).toEqual({ ok: false, message: 'No program selected' })
  })
})

describe('suggestWorker — EA3 last resort (#5)', () => {
  // Fixtures are deliberately arranged so the EA3 would WIN absent the
  // last-resort filter: ea3early sorts alphabetically before the EA1 (Able <
  // Zimmer). That isolates the `eaLevel !== 3` filter from the plain
  // count/alphabetical tiebreak — delete the filter in selection.js and the
  // first two tests here FAIL (the natural regression of invariant #5).
  const ea1 = { id: 'ea1', firstName: 'Zoe', lastName: 'Zimmer', eaLevel: 1, programs: { snap: true }, active: true }
  const ea3early = { id: 'ea3early', firstName: 'Amy', lastName: 'Able', eaLevel: 3, programs: { snap: true }, active: true }

  it('an available EA1 is chosen over an EA3 that would otherwise sort FIRST alphabetically', () => {
    // Both at count 0; ea3early (Able) sorts before ea1 (Zimmer). Only the EA3
    // last-resort filter keeps the EA3 out, so the EA1 must win.
    const r = suggestWorker({ workers: [ea1, ea3early], weeklyCounts: counts(), programs: ['snap'] })
    expect(r.worker.id).toBe('ea1')
  })

  it('an available EA1 is chosen over an EA3 with a STRICTLY LOWER weekly count', () => {
    // EA3 at 0, EA1 at 5 — absent the filter the EA3 wins on count. The
    // last-resort filter must still prefer the (higher-count) EA1.
    const r = suggestWorker({
      workers: [ea1, ea3early],
      weeklyCounts: counts({ ea1: 5 }),
      programs: ['snap'],
    })
    expect(r.worker.id).toBe('ea1')
  })

  it('EA3 is chosen only once the EA1 is excluded', () => {
    const r = suggestWorker({
      workers: [ea1, ea3early],
      weeklyCounts: counts(),
      programs: ['snap'],
      supervisorUnavailableIds: ['ea1'],
    })
    expect(r.worker.id).toBe('ea3early')
  })

  it('a pool of only EA3 workers returns the EA3', () => {
    const r = suggestWorker({ workers: [ea3early], weeklyCounts: counts(), programs: ['snap'] })
    expect(r.ok).toBe(true)
    expect(r.worker.id).toBe('ea3early')
  })

  it('among multiple EA3s (no EA1/EA2 available), lowest weekly count wins', () => {
    // EA1 excluded → both EA3s become eligible; lower count wins.
    const ea3b = { id: 'ea3b', firstName: 'Yan', lastName: 'York', eaLevel: 3, programs: { snap: true }, active: true }
    const r = suggestWorker({
      workers: [ea1, ea3early, ea3b],
      weeklyCounts: counts({ ea3early: 2 }),
      programs: ['snap'],
      supervisorUnavailableIds: ['ea1'],
    })
    expect(r.worker.id).toBe('ea3b') // York at 0 beats Able at 2
  })
})

describe('suggestWorker — exclusions (pending / temp / supervisor)', () => {
  it('pending workers are excluded from the pool (concurrency guard #4)', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts(),
      programs: ['snap'],
      pendingIds: ['worker-01'],
    })
    expect(r.worker.id).toBe('worker-02') // Alvarez pending → Bennett next
  })

  it('temp-unavailable workers are excluded', () => {
    const r = suggestWorker({
      workers: ROSTER,
      weeklyCounts: counts(),
      programs: ['snap'],
      tempUnavailableIds: ['worker-01'],
    })
    expect(r.worker.id).toBe('worker-02')
  })

  it('inactive workers are excluded', () => {
    const onlyInactive = [
      { id: 'x', firstName: 'In', lastName: 'Active', eaLevel: 1, programs: { snap: true }, active: false },
    ]
    const r = suggestWorker({ workers: onlyInactive, weeklyCounts: counts(), programs: ['snap'] })
    expect(r.ok).toBe(false)
  })
})

describe('suggestWorker — no staff', () => {
  it('empty candidate pool returns { ok: false, message } with the human label', () => {
    // No workers trained in MEPD here → empty pool.
    const noMepd = ROSTER.filter((w) => !w.programs.mepd)
    const r = suggestWorker({ workers: noMepd, weeklyCounts: counts(), programs: ['mepd'] })
    expect(r).toEqual({ ok: false, message: 'No staff available for MEPD' })
  })

  it('an entirely empty roster returns the no-staff message', () => {
    const r = suggestWorker({ workers: [], weeklyCounts: counts(), programs: ['mepd'] })
    expect(r).toEqual({ ok: false, message: 'No staff available for MEPD' })
  })
})

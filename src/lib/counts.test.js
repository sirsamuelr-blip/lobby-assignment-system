import { describe, it, expect } from 'vitest'
import { bucketCounts } from './counts.js'

// bucketCounts is PURE — no Firebase, no clock. We pass explicit boundaries and
// rows, so the tests are deterministic and independent of the machine's zone.
// Boundaries chosen to satisfy historicalStart <= weekStart <= todayStart, the
// same ordering the live subscription always produces (today ⊆ week ⊆ historical):
//   historicalStart : Mon May 11 2026 00:00 CDT (the 8-week window start)
//   weekStart       : Mon Jun 29 2026 00:00 CDT (this week's Monday)
//   todayStart      : Wed Jul  1 2026 00:00 CDT (today)
const todayStart = new Date('2026-07-01T05:00:00Z')
const weekStart = new Date('2026-06-29T05:00:00Z')
const historicalStart = new Date('2026-05-11T05:00:00Z')
const boundaries = { todayStart, weekStart, historicalStart }

const ms = (isoStr) => new Date(isoStr).getTime()

describe('bucketCounts', () => {
  it('tallies nested windows per worker (today ⊆ week ⊆ historical)', () => {
    const rows = [
      { workerId: 'a', timestampMs: ms('2026-07-01T14:00:00Z') }, // today
      { workerId: 'a', timestampMs: ms('2026-07-01T14:30:00Z') }, // today
      { workerId: 'a', timestampMs: ms('2026-06-30T14:00:00Z') }, // earlier this week (Tue)
      { workerId: 'b', timestampMs: ms('2026-06-01T14:00:00Z') }, // earlier in the 8-week window
    ]
    const { today, week, historical } = bucketCounts(rows, boundaries)

    // a: 2 today, +1 earlier this week, all 3 within the historical window.
    expect(today.get('a')).toBe(2)
    expect(week.get('a')).toBe(3)
    expect(historical.get('a')).toBe(3)

    // b: only the older (pre-this-week) row → historical only.
    expect(today.has('b')).toBe(false)
    expect(week.has('b')).toBe(false)
    expect(historical.get('b')).toBe(1)

    // Nesting holds for every worker: today <= week <= historical.
    for (const id of historical.keys()) {
      const t = today.get(id) ?? 0
      const w = week.get(id) ?? 0
      const h = historical.get(id) ?? 0
      expect(t).toBeLessThanOrEqual(w)
      expect(w).toBeLessThanOrEqual(h)
    }
  })

  it('a worker with no rows in a window is absent from that map (screen reads missing as 0)', () => {
    const rows = [{ workerId: 'b', timestampMs: ms('2026-06-01T14:00:00Z') }] // historical only
    const { today, week, historical } = bucketCounts(rows, boundaries)

    expect(today.has('b')).toBe(false) // → 0 on screen
    expect(week.has('b')).toBe(false) // → 0 on screen
    expect(historical.get('b')).toBe(1)

    // A never-seen worker is absent everywhere.
    expect(today.get('zzz')).toBeUndefined()
    expect(week.get('zzz')).toBeUndefined()
    expect(historical.get('zzz')).toBeUndefined()
  })

  it('boundary is inclusive: a row exactly at weekStart counts in week; 1 ms before does not', () => {
    const rows = [
      { workerId: 'x', timestampMs: weekStart.getTime() }, // exactly on the boundary
      { workerId: 'y', timestampMs: weekStart.getTime() - 1 }, // 1 ms before
    ]
    const { today, week, historical } = bucketCounts(rows, boundaries)

    expect(week.get('x')).toBe(1) // inclusive at the boundary
    expect(today.has('x')).toBe(false) // before today
    expect(week.has('y')).toBe(false) // 1 ms before → excluded from week
    expect(historical.get('y')).toBe(1) // but still inside the historical window
  })

  it('boundary inclusivity holds at the today and historical edges too', () => {
    const rows = [
      { workerId: 'z', timestampMs: todayStart.getTime() }, // exactly today 00:00
      { workerId: 'h', timestampMs: historicalStart.getTime() }, // exactly window start
      { workerId: 'o', timestampMs: historicalStart.getTime() - 1 }, // 1 ms before window
    ]
    const { today, week, historical } = bucketCounts(rows, boundaries)

    expect(today.get('z')).toBe(1) // inclusive at todayStart
    expect(historical.get('h')).toBe(1) // inclusive at historicalStart
    expect(week.has('h')).toBe(false) // historicalStart is before this week
    // A row before the window start is dropped from every bucket.
    expect(historical.has('o')).toBe(false)
    expect(week.has('o')).toBe(false)
    expect(today.has('o')).toBe(false)
  })

  it('skips rows with a null timestampMs or a falsy workerId (defensive)', () => {
    const rows = [
      { workerId: 'a', timestampMs: null }, // unresolved serverTimestamp → skipped
      { workerId: '', timestampMs: ms('2026-07-01T14:00:00Z') }, // empty id → skipped
      { workerId: undefined, timestampMs: ms('2026-07-01T14:00:00Z') }, // missing id → skipped
      { workerId: 'a', timestampMs: ms('2026-07-01T14:00:00Z') }, // the only valid row
    ]
    const { today, week, historical } = bucketCounts(rows, boundaries)

    expect(today.get('a')).toBe(1)
    expect(today.size).toBe(1) // no '' / undefined keys leaked in
    expect(week.size).toBe(1)
    expect(historical.size).toBe(1)
    expect(today.has('')).toBe(false)
  })

  it('returns empty maps for no rows (and tolerates a nullish rows arg)', () => {
    for (const input of [[], null, undefined]) {
      const { today, week, historical } = bucketCounts(input, boundaries)
      expect(today.size).toBe(0)
      expect(week.size).toBe(0)
      expect(historical.size).toBe(0)
    }
  })
})

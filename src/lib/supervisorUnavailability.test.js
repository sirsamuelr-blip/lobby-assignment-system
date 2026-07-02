import { describe, it, expect } from 'vitest'
import {
  isSupervisorUnavailableOn,
  activeSupervisorUnavailableIds,
  UNAVAIL_TYPE_LABELS,
} from './supervisorUnavailability.js'

// Every `now` below is written as an absolute UTC instant (…Z) so the tests do NOT
// depend on the machine's local timezone. The office zone is America/Chicago
// (WEEK_ZONE), so the LOCAL day is what the date logic must resolve:
//   • SUMMER anchor — 2025-06-25T17:00:00Z = Wed Jun 25 2025 12:00 CDT (UTC-5)
//     → local day '2025-06-25', Luxon weekday 3 (Wednesday).
const SUMMER = new Date('2025-06-25T17:00:00Z')

describe('isSupervisorUnavailableOn — single mode', () => {
  it("today's ISO date matches → out", () => {
    expect(isSupervisorUnavailableOn({ mode: 'single', date: '2025-06-25' }, SUMMER)).toBe(true)
  })
  it('yesterday → not out', () => {
    expect(isSupervisorUnavailableOn({ mode: 'single', date: '2025-06-24' }, SUMMER)).toBe(false)
  })
  it('tomorrow → not out', () => {
    expect(isSupervisorUnavailableOn({ mode: 'single', date: '2025-06-26' }, SUMMER)).toBe(false)
  })
})

describe('isSupervisorUnavailableOn — range mode (both bounds inclusive)', () => {
  it('today == startDate (inclusive) → out', () => {
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-06-25', endDate: '2025-06-30' },
        SUMMER,
      ),
    ).toBe(true)
  })
  it('today == endDate (inclusive) → out', () => {
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-06-20', endDate: '2025-06-25' },
        SUMMER,
      ),
    ).toBe(true)
  })
  it('the day before startDate → not out', () => {
    // today is Jun 25; the range opens Jun 26.
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-06-26', endDate: '2025-06-30' },
        SUMMER,
      ),
    ).toBe(false)
  })
  it('the day after endDate → not out', () => {
    // today is Jun 25; the range closed Jun 24.
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-06-20', endDate: '2025-06-24' },
        SUMMER,
      ),
    ).toBe(false)
  })
  it('a mid-range day → out', () => {
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-06-20', endDate: '2025-06-30' },
        SUMMER,
      ),
    ).toBe(true)
  })
  it('a range missing a bound → not out (null-safe)', () => {
    expect(isSupervisorUnavailableOn({ mode: 'range', startDate: '2025-06-20' }, SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn({ mode: 'range', endDate: '2025-06-30' }, SUMMER)).toBe(false)
  })
})

describe('isSupervisorUnavailableOn — recurring mode (Luxon weekday 1..7)', () => {
  it("a `now` whose local weekday == doc.weekday → out (Wed = 3)", () => {
    expect(isSupervisorUnavailableOn({ mode: 'recurring', weekday: 3 }, SUMMER)).toBe(true)
  })
  it('a different weekday → not out', () => {
    expect(isSupervisorUnavailableOn({ mode: 'recurring', weekday: 4 }, SUMMER)).toBe(false)
  })
})

describe('isSupervisorUnavailableOn — null-safe on junk input', () => {
  it('null / non-object / unknown mode / missing fields → false', () => {
    expect(isSupervisorUnavailableOn(null, SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn(undefined, SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn('nope', SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn({}, SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn({ mode: 'weird' }, SUMMER)).toBe(false)
    expect(isSupervisorUnavailableOn({ mode: 'single' }, SUMMER)).toBe(false) // no date
    expect(isSupervisorUnavailableOn({ mode: 'recurring' }, SUMMER)).toBe(false) // no weekday
  })
})

describe('DST-safety — the LOCAL calendar day, never UTC', () => {
  // America/Chicago falls back on 2025-11-02. This instant is 2025-11-03T05:30:00Z,
  // which is Sun Nov 2 2025 23:30 CST (UTC-6) in Central: the LOCAL day is Nov 2
  // (Sunday, Luxon weekday 7) while the UTC day is already Nov 3 (Monday). Every
  // assertion below would INVERT if "today" were computed in UTC instead of through
  // WEEK_ZONE/Luxon — this is the guard against anyone dropping the zone.
  const DST = new Date('2025-11-03T05:30:00Z')

  it('single on the true LOCAL day (Nov 2) → out; single on the UTC day (Nov 3) → not', () => {
    expect(isSupervisorUnavailableOn({ mode: 'single', date: '2025-11-02' }, DST)).toBe(true)
    // If the code resolved "today" in UTC it would be Nov 3 and this would be true.
    expect(isSupervisorUnavailableOn({ mode: 'single', date: '2025-11-03' }, DST)).toBe(false)
  })

  it('range whose inclusive endDate is the LOCAL day (Nov 2) → out', () => {
    // Under UTC, today would read as Nov 3 > endDate → wrongly not-out. Luxon keeps
    // it Nov 2 == endDate → out.
    expect(
      isSupervisorUnavailableOn(
        { mode: 'range', startDate: '2025-11-01', endDate: '2025-11-02' },
        DST,
      ),
    ).toBe(true)
  })

  it('recurring on the LOCAL weekday (Sun = 7) → out; on the UTC weekday (Mon = 1) → not', () => {
    expect(isSupervisorUnavailableOn({ mode: 'recurring', weekday: 7 }, DST)).toBe(true)
    expect(isSupervisorUnavailableOn({ mode: 'recurring', weekday: 1 }, DST)).toBe(false)
  })
})

describe('activeSupervisorUnavailableIds', () => {
  it('dedups a worker with two active docs', () => {
    const docs = [
      { workerId: 'w1', mode: 'single', date: '2025-06-25' },
      { workerId: 'w1', mode: 'recurring', weekday: 3 },
    ]
    expect(activeSupervisorUnavailableIds(docs, SUMMER)).toEqual(['w1'])
  })

  it('drops a worker whose only doc is inactive today', () => {
    const docs = [{ workerId: 'gone', mode: 'single', date: '2025-06-24' }]
    expect(activeSupervisorUnavailableIds(docs, SUMMER)).toEqual([])
  })

  it('treats all four types identically (each active → out)', () => {
    const docs = [
      { workerId: 'a', type: 'wfh', mode: 'single', date: '2025-06-25' },
      { workerId: 'b', type: 'pto', mode: 'single', date: '2025-06-25' },
      { workerId: 'c', type: 'special_project', mode: 'single', date: '2025-06-25' },
      { workerId: 'd', type: 'callout', mode: 'single', date: '2025-06-25' },
    ]
    expect(activeSupervisorUnavailableIds(docs, SUMMER).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('mixes active and inactive docs across workers', () => {
    const docs = [
      { workerId: 'in', mode: 'single', date: '2025-06-25' }, // active
      { workerId: 'out', mode: 'single', date: '2025-01-01' }, // inactive
      { workerId: 'range', mode: 'range', startDate: '2025-06-20', endDate: '2025-06-30' }, // active
    ]
    expect(activeSupervisorUnavailableIds(docs, SUMMER).sort()).toEqual(['in', 'range'])
  })

  it('accepts a raw-millis `now` as well as a Date', () => {
    const docs = [{ workerId: 'w1', mode: 'single', date: '2025-06-25' }]
    expect(activeSupervisorUnavailableIds(docs, +SUMMER)).toEqual(['w1'])
  })

  it('skips docs with no workerId', () => {
    const docs = [
      { mode: 'single', date: '2025-06-25' }, // no workerId
      { workerId: 'w1', mode: 'single', date: '2025-06-25' },
    ]
    expect(activeSupervisorUnavailableIds(docs, SUMMER)).toEqual(['w1'])
  })

  it('is safe on empty / undefined input', () => {
    expect(activeSupervisorUnavailableIds([], SUMMER)).toEqual([])
    expect(activeSupervisorUnavailableIds(undefined, SUMMER)).toEqual([])
  })
})

describe('UNAVAIL_TYPE_LABELS', () => {
  it('covers all four types with human-facing labels', () => {
    expect(UNAVAIL_TYPE_LABELS).toEqual({
      wfh: 'WFH',
      pto: 'PTO',
      special_project: 'Special project',
      callout: 'Callout',
    })
  })
})

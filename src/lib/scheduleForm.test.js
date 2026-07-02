import { describe, it, expect } from 'vitest'
import {
  isValidDateRange,
  buildUnavailabilityEntry,
  buildUnavailabilityEntries,
  describeSchedule,
  WEEKDAYS,
} from './scheduleForm.js'

describe('isValidDateRange — inclusive ISO-string range check', () => {
  it('accepts start before end and start === end', () => {
    expect(isValidDateRange('2026-07-01', '2026-07-05')).toBe(true)
    expect(isValidDateRange('2026-07-01', '2026-07-01')).toBe(true)
  })

  it('rejects end before start', () => {
    expect(isValidDateRange('2026-07-05', '2026-07-01')).toBe(false)
  })

  it('rejects missing / non-string bounds', () => {
    expect(isValidDateRange('', '2026-07-01')).toBe(false)
    expect(isValidDateRange('2026-07-01', '')).toBe(false)
    expect(isValidDateRange(undefined, '2026-07-01')).toBe(false)
    expect(isValidDateRange('2026-07-01', null)).toBe(false)
  })
})

describe('buildUnavailabilityEntry — form fields → unavailability entry', () => {
  it('single: keeps the raw YYYY-MM-DD date string (never a Timestamp)', () => {
    const r = buildUnavailabilityEntry({
      workerId: 'worker-05',
      type: 'pto',
      mode: 'single',
      date: '2026-07-03',
    })
    expect(r).toEqual({
      entry: { workerId: 'worker-05', type: 'pto', mode: 'single', date: '2026-07-03' },
    })
    expect(typeof r.entry.date).toBe('string')
  })

  it('range: keeps both date strings when valid', () => {
    const r = buildUnavailabilityEntry({
      workerId: 'worker-05',
      type: 'special_project',
      mode: 'range',
      startDate: '2026-07-06',
      endDate: '2026-07-10',
    })
    expect(r).toEqual({
      entry: {
        workerId: 'worker-05',
        type: 'special_project',
        mode: 'range',
        startDate: '2026-07-06',
        endDate: '2026-07-10',
      },
    })
  })

  it('range: rejects end before start', () => {
    const r = buildUnavailabilityEntry({
      workerId: 'worker-05',
      type: 'wfh',
      mode: 'range',
      startDate: '2026-07-10',
      endDate: '2026-07-06',
    })
    expect(r.entry).toBeUndefined()
    expect(r.error).toMatch(/before the start/i)
  })

  it('recurring: stores the Luxon weekday as a NUMBER (Tuesday → 2, not "2", not getDay)', () => {
    const r = buildUnavailabilityEntry({
      workerId: 'worker-05',
      type: 'callout',
      mode: 'recurring',
      weekday: '2', // an <input>/<select> hands strings; must coerce to a number
    })
    expect(r.entry).toEqual({
      workerId: 'worker-05',
      type: 'callout',
      mode: 'recurring',
      weekday: 2,
    })
    expect(typeof r.entry.weekday).toBe('number')
  })

  it('recurring: rejects an out-of-range / missing weekday', () => {
    expect(
      buildUnavailabilityEntry({ workerId: 'w', type: 'wfh', mode: 'recurring', weekday: 0 }).error,
    ).toMatch(/weekday/i)
    expect(
      buildUnavailabilityEntry({ workerId: 'w', type: 'wfh', mode: 'recurring', weekday: 8 }).error,
    ).toMatch(/weekday/i)
    expect(
      buildUnavailabilityEntry({ workerId: 'w', type: 'wfh', mode: 'recurring' }).error,
    ).toMatch(/weekday/i)
  })

  it('reports missing worker / type / date before anything else', () => {
    expect(buildUnavailabilityEntry({ mode: 'single' }).error).toMatch(/worker/i)
    expect(buildUnavailabilityEntry({ workerId: 'w', mode: 'single' }).error).toMatch(/type/i)
    expect(
      buildUnavailabilityEntry({ workerId: 'w', type: 'pto', mode: 'single' }).error,
    ).toMatch(/date/i)
    expect(
      buildUnavailabilityEntry({ workerId: 'w', type: 'pto', mode: 'range' }).error,
    ).toMatch(/date/i)
  })
})

describe('buildUnavailabilityEntries — multi-weekday recurring fan-out', () => {
  it('recurring [2,4] → two single-weekday entries, both NUMBERS', () => {
    const r = buildUnavailabilityEntries({
      workerId: 'worker-05',
      type: 'wfh',
      mode: 'recurring',
      weekdays: [2, 4],
    })
    expect(r.error).toBeUndefined()
    expect(r.entries).toEqual([
      { workerId: 'worker-05', type: 'wfh', mode: 'recurring', weekday: 2 },
      { workerId: 'worker-05', type: 'wfh', mode: 'recurring', weekday: 4 },
    ])
    r.entries.forEach((e) => expect(typeof e.weekday).toBe('number'))
  })

  it('recurring [2,2,3] dedups to two entries (weekday 2 and 3)', () => {
    const r = buildUnavailabilityEntries({
      workerId: 'w',
      type: 'pto',
      mode: 'recurring',
      weekdays: [2, 2, 3],
    })
    expect(r.entries.map((e) => e.weekday)).toEqual([2, 3])
  })

  it('recurring: coerces string weekdays and drops out-of-range values', () => {
    const r = buildUnavailabilityEntries({
      workerId: 'w',
      type: 'pto',
      mode: 'recurring',
      weekdays: ['1', 0, 8, '5'],
    })
    expect(r.entries.map((e) => e.weekday)).toEqual([1, 5])
  })

  it('recurring: [] or all-invalid → { error } about weekdays', () => {
    expect(
      buildUnavailabilityEntries({ workerId: 'w', type: 'pto', mode: 'recurring', weekdays: [] }).error,
    ).toMatch(/weekday/i)
    expect(
      buildUnavailabilityEntries({
        workerId: 'w',
        type: 'pto',
        mode: 'recurring',
        weekdays: [0, 8],
      }).error,
    ).toMatch(/weekday/i)
    expect(
      buildUnavailabilityEntries({ workerId: 'w', type: 'pto', mode: 'recurring' }).error,
    ).toMatch(/weekday/i)
  })

  it('single → a one-entry array equal to the singular builder’s {entry}', () => {
    const fields = { workerId: 'w', type: 'pto', mode: 'single', date: '2026-07-03' }
    const plural = buildUnavailabilityEntries(fields)
    const singular = buildUnavailabilityEntry(fields)
    expect(plural).toEqual({ entries: [singular.entry] })
  })

  it('range end<start → the singular error passes through', () => {
    const r = buildUnavailabilityEntries({
      workerId: 'w',
      type: 'wfh',
      mode: 'range',
      startDate: '2026-07-10',
      endDate: '2026-07-06',
    })
    expect(r.entries).toBeUndefined()
    expect(r.error).toMatch(/before the start/i)
  })
})

describe('describeSchedule — human-readable schedule text', () => {
  it('renders each mode per spec', () => {
    expect(describeSchedule({ mode: 'single', date: '2026-07-03' })).toBe('2026-07-03')
    expect(
      describeSchedule({ mode: 'range', startDate: '2026-07-06', endDate: '2026-07-10' }),
    ).toBe('2026-07-06 – 2026-07-10')
    expect(describeSchedule({ mode: 'recurring', weekday: 2 })).toBe('Every Tuesday')
    expect(describeSchedule({ mode: 'recurring', weekday: 7 })).toBe('Every Sunday')
  })

  it('is null-safe on missing / unknown-mode entries', () => {
    expect(describeSchedule(null)).toBe('')
    expect(describeSchedule({})).toBe('')
    expect(describeSchedule({ mode: 'recurring', weekday: 99 })).toBe('Every ?')
  })
})

describe('WEEKDAYS — the Mon=1…Sun=7 Luxon mapping', () => {
  it('maps each ordinal to the right name (no getDay offset)', () => {
    expect(WEEKDAYS.map((d) => d.value)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(WEEKDAYS.find((d) => d.value === 1).long).toBe('Monday')
    expect(WEEKDAYS.find((d) => d.value === 7).long).toBe('Sunday')
  })
})

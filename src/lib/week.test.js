import { describe, it, expect } from 'vitest'
import { mostRecentMondayMidnight, WEEK_ZONE } from './week.js'

// Inputs are written as absolute UTC instants (…Z) so the test does NOT depend
// on the machine's local timezone. The expected Mondays are the corresponding
// Monday-00:00 in America/Chicago, expressed back in UTC:
//   • CDT (summer) = UTC-5  → local midnight is 05:00 UTC
//   • CST (winter) = UTC-6  → local midnight is 06:00 UTC

const iso = (d) => d.toISOString()

describe('mostRecentMondayMidnight', () => {
  it('exports the Central zone as the default', () => {
    expect(WEEK_ZONE).toBe('America/Chicago')
  })

  it('summer weekday → that week\'s Monday 00:00 CDT (UTC-5)', () => {
    // Wed Jun 25 2025 12:00 Central (17:00 UTC) → Mon Jun 23 2025 00:00 CDT.
    const now = new Date('2025-06-25T17:00:00Z')
    expect(iso(mostRecentMondayMidnight(now))).toBe('2025-06-23T05:00:00.000Z')
  })

  it('winter weekday → that week\'s Monday 00:00 CST (UTC-6), proving DST handling', () => {
    // Wed Jan 15 2025 12:00 Central (18:00 UTC) → Mon Jan 13 2025 00:00 CST.
    const now = new Date('2025-01-15T18:00:00Z')
    expect(iso(mostRecentMondayMidnight(now))).toBe('2025-01-13T06:00:00.000Z')
  })

  it('uses the offset in effect AT the target Monday, not at "now" (pre-spring-forward)', () => {
    // Sat Mar 8 2025 (before DST begins Sun Mar 9) → Monday is Mar 3, still CST.
    const now = new Date('2025-03-08T18:00:00Z') // Sat 12:00 CST
    expect(iso(mostRecentMondayMidnight(now))).toBe('2025-03-03T06:00:00.000Z')
  })

  it('a date after spring-forward resolves its Monday in CDT', () => {
    // Fri Mar 14 2025 12:00 CDT (17:00 UTC) → Monday Mar 10 2025 00:00 CDT.
    const now = new Date('2025-03-14T17:00:00Z')
    expect(iso(mostRecentMondayMidnight(now))).toBe('2025-03-10T05:00:00.000Z')
  })

  it('a timestamp exactly at Monday 00:00 local returns itself', () => {
    const mondayMidnight = new Date('2025-06-23T05:00:00Z') // Mon 00:00 CDT
    expect(iso(mostRecentMondayMidnight(mondayMidnight))).toBe('2025-06-23T05:00:00.000Z')
  })

  describe('Sunday-night vs Monday-morning land on opposite sides of the boundary', () => {
    // The boundary is Mon Jun 23 2025 00:00 CDT = 2025-06-23T05:00:00Z.
    it('Sunday 23:30 Central falls in the PREVIOUS week (Mon Jun 16)', () => {
      const sundayNight = new Date('2025-06-23T04:30:00Z') // Sun Jun 22 23:30 CDT
      expect(iso(mostRecentMondayMidnight(sundayNight))).toBe('2025-06-16T05:00:00.000Z')
    })

    it('Monday 00:30 Central falls in the NEW week (Mon Jun 23)', () => {
      const mondayMorning = new Date('2025-06-23T05:30:00Z') // Mon Jun 23 00:30 CDT
      expect(iso(mostRecentMondayMidnight(mondayMorning))).toBe('2025-06-23T05:00:00.000Z')
    })

    it('the two are only 60 minutes apart in real time but a week apart in result', () => {
      const sundayNight = new Date('2025-06-23T04:30:00Z')
      const mondayMorning = new Date('2025-06-23T05:30:00Z')
      const a = mostRecentMondayMidnight(sundayNight).getTime()
      const b = mostRecentMondayMidnight(mondayMorning).getTime()
      expect(b - a).toBe(7 * 24 * 60 * 60 * 1000)
    })
  })

  it('respects an explicitly passed zone (Eastern shifts the boundary)', () => {
    // Same instant, Eastern (UTC-4 in summer): Mon Jun 23 00:00 EDT = 04:00 UTC.
    const now = new Date('2025-06-25T17:00:00Z')
    expect(iso(mostRecentMondayMidnight(now, 'America/New_York'))).toBe(
      '2025-06-23T04:00:00.000Z',
    )
  })
})

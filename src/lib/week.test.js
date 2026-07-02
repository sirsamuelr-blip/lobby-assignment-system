import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  mostRecentMondayMidnight,
  rollingWeeksStart,
  startOfTodayMidnight,
  WEEK_ZONE,
} from './week.js'

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

// Read a JS Date back in the office zone, to assert "this instant is <that>
// wall-clock time in America/Chicago" independent of the machine's local zone.
const inZone = (d) => DateTime.fromJSDate(d).setZone(WEEK_ZONE)
const wall = (d) => inZone(d).toFormat('yyyy-MM-dd HH:mm:ss')

describe('startOfTodayMidnight', () => {
  it('summer instant → that day 00:00 CDT (UTC-5)', () => {
    // Wed Jul 1 2026 12:00 Central (17:00 UTC) → Wed Jul 1 2026 00:00 CDT.
    const now = new Date('2026-07-01T17:00:00Z')
    expect(iso(startOfTodayMidnight(now))).toBe('2026-07-01T05:00:00.000Z')
    expect(wall(startOfTodayMidnight(now))).toBe('2026-07-01 00:00:00')
  })

  it('uses the LOCAL day, not the UTC day (late-evening Central is still today)', () => {
    // 2026-07-02 04:00 UTC is still Wed Jul 1 23:00 CDT → today is Jul 1, not Jul 2.
    const now = new Date('2026-07-02T04:00:00Z')
    expect(iso(startOfTodayMidnight(now))).toBe('2026-07-01T05:00:00.000Z')
    expect(wall(startOfTodayMidnight(now))).toBe('2026-07-01 00:00:00')
  })

  it('winter instant → that day 00:00 CST (UTC-6), proving DST handling', () => {
    // Thu Jan 15 2026 12:00 Central (18:00 UTC) → Thu Jan 15 2026 00:00 CST.
    const now = new Date('2026-01-15T18:00:00Z')
    expect(iso(startOfTodayMidnight(now))).toBe('2026-01-15T06:00:00.000Z')
    expect(wall(startOfTodayMidnight(now))).toBe('2026-01-15 00:00:00')
  })
})

describe('rollingWeeksStart', () => {
  it('weeks = 1 is exactly the current week (equals mostRecentMondayMidnight)', () => {
    const now = new Date('2026-07-01T17:00:00Z')
    expect(rollingWeeksStart(1, now).getTime()).toBe(mostRecentMondayMidnight(now).getTime())
  })

  it('weeks = 8 lands on the Monday seven weeks before the current week', () => {
    // now = Wed Jul 1 2026 → current Monday Jun 29 → minus 7 weeks → Mon May 11 2026 00:00 CDT.
    const now = new Date('2026-07-01T17:00:00Z')
    expect(iso(rollingWeeksStart(8, now))).toBe('2026-05-11T05:00:00.000Z')
    const dt = inZone(rollingWeeksStart(8, now))
    expect(dt.weekday).toBe(1) // Monday
    expect(wall(rollingWeeksStart(8, now))).toBe('2026-05-11 00:00:00')
  })

  it('an 8-week window from early April reaches back across spring-forward, still Monday 00:00', () => {
    // US spring-forward 2026 is Sun Mar 8. now = Wed Apr 8 2026 (CDT) → current Monday
    // Apr 6 (CDT) → minus 7 weeks → Mon Feb 16 2026 00:00, which is still CST (UTC-6).
    // A naive fixed-offset subtraction would land at Feb 15 23:00 CST — off by an hour
    // AND a day. The zone-aware calendar math keeps it exactly Monday 00:00.
    const now = new Date('2026-04-08T17:00:00Z')
    expect(iso(rollingWeeksStart(8, now))).toBe('2026-02-16T06:00:00.000Z')
    const dt = inZone(rollingWeeksStart(8, now))
    expect(dt.weekday).toBe(1) // Monday
    expect(wall(rollingWeeksStart(8, now))).toBe('2026-02-16 00:00:00')
  })
})

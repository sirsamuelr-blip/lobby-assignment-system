import { describe, it, expect } from 'vitest'
import { activeTempUnavailableIds } from './unavailable.js'

// Mirrors activePendingIds' tests, but temp docs key on `until` (not expiresAt):
// exclusion is query-time, so a worker is temp-unavailable iff `until` is STRICTLY
// in the future. Same normalization (Timestamp-like / Date / number) and safety.
describe('activeTempUnavailableIds — the 30-min temp-unavailable filter (query-time)', () => {
  it('keeps only until STRICTLY in the future; drops expired and exactly-now', () => {
    const now = new Date('2025-06-25T12:00:00Z')
    const nowMs = now.getTime()
    const docs = [
      { workerId: 'future', until: new Date(nowMs + 1000) },
      { workerId: 'past', until: new Date(nowMs - 1000) },
      { workerId: 'exactly-now', until: new Date(nowMs) },
    ]
    expect(activeTempUnavailableIds(docs, now)).toEqual(['future'])
  })

  it('accepts a Firestore-Timestamp-like value ({toMillis}), a Date, and a raw number', () => {
    const nowMs = 1_000_000
    const now = new Date(nowMs)
    const docs = [
      { workerId: 'ts', until: { toMillis: () => nowMs + 5000 } },
      { workerId: 'date', until: new Date(nowMs + 5000) },
      { workerId: 'num', until: nowMs + 5000 },
      { workerId: 'ts-expired', until: { toMillis: () => nowMs - 1 } },
    ]
    expect(activeTempUnavailableIds(docs, now).sort()).toEqual(['date', 'num', 'ts'])
  })

  it('accepts a raw-number `now` as well as a Date', () => {
    const docs = [{ workerId: 'a', until: 5000 }]
    expect(activeTempUnavailableIds(docs, 4000)).toEqual(['a'])
    expect(activeTempUnavailableIds(docs, 6000)).toEqual([])
  })

  it('dedups repeated workerIds', () => {
    const now = new Date(0)
    const docs = [
      { workerId: 'dup', until: 10_000 },
      { workerId: 'dup', until: 20_000 },
      { workerId: 'other', until: 10_000 },
    ]
    expect(activeTempUnavailableIds(docs, now).sort()).toEqual(['dup', 'other'])
  })

  it('is safe on empty / missing input', () => {
    expect(activeTempUnavailableIds([], new Date())).toEqual([])
    expect(activeTempUnavailableIds(undefined, new Date())).toEqual([])
  })
})

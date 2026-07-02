// src/lib/scheduleForm.js — PURE shaping/validation for the Admin unavailability
// scheduler form. No Firestore, no clock — just turn the form fields into a valid
// `unavailability` entry (or say why it isn't valid yet). Kept pure and separate
// from Admin.jsx so the two fairness-sensitive rules can be unit-tested:
//
//   • Recurring weekday is a Luxon ordinal (Mon=1 … Sun=7) stored as a NUMBER —
//     NEVER JS Date.getDay() (0=Sun..6=Sat), which would offset every recurring
//     absence by a day. buildUnavailabilityEntry coerces to an integer 1..7.
//   • Date fields are the raw 'YYYY-MM-DD' STRINGS straight from <input type=
//     "date">. NEVER a Firestore Timestamp — the whole date engine
//     (supervisorUnavailability.js) compares ISO strings lexicographically.

// The seven weekdays as Luxon ordinals — the single source of truth shared by the
// day-picker UI and describeSchedule. Mon=1 … Sun=7, matching DateTime#weekday.
export const WEEKDAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 7, short: 'Sun', long: 'Sunday' },
]

const WEEKDAY_LONG = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.long]))

/**
 * PURE. Is [startDate, endDate] a valid inclusive range? Both must be present ISO
 * 'YYYY-MM-DD' strings and end must not precede start. ISO date strings sort
 * lexicographically, so `startDate <= endDate` is a correct range check with no
 * Date arithmetic.
 *
 * @param {string} startDate
 * @param {string} endDate
 * @returns {boolean}
 */
export function isValidDateRange(startDate, endDate) {
  if (typeof startDate !== 'string' || typeof endDate !== 'string') return false
  if (!startDate || !endDate) return false
  return startDate <= endDate
}

/**
 * PURE. Shape the scheduler form's fields into an `unavailability` entry payload
 * for addUnavailability, or report the first blocking problem. Returns
 * `{ entry }` on success or `{ error }` on failure — never both. The returned
 * entry carries ONLY the fields the chosen mode needs (date strings / a numeric
 * weekday), never a Timestamp and never client data.
 *
 * @param {{workerId?: string, type?: string, mode?: string, date?: string, startDate?: string, endDate?: string, weekday?: number|string}} fields
 * @returns {{entry: object} | {error: string}}
 */
export function buildUnavailabilityEntry({
  workerId,
  type,
  mode,
  date,
  startDate,
  endDate,
  weekday,
}) {
  if (!workerId) return { error: 'Select a worker.' }
  if (!type) return { error: 'Select a type.' }

  switch (mode) {
    case 'single':
      if (!date) return { error: 'Pick a date.' }
      return { entry: { workerId, type, mode, date } }

    case 'range':
      if (!startDate || !endDate) return { error: 'Pick a start and end date.' }
      if (!isValidDateRange(startDate, endDate))
        return { error: 'End date cannot be before the start date.' }
      return { entry: { workerId, type, mode, startDate, endDate } }

    case 'recurring': {
      const wd = Number(weekday)
      if (!Number.isInteger(wd) || wd < 1 || wd > 7)
        return { error: 'Pick a weekday.' }
      // Store the NUMBER (Luxon ordinal), never a string or a JS getDay() value.
      return { entry: { workerId, type, mode, weekday: wd } }
    }

    default:
      return { error: 'Choose how often.' }
  }
}

/**
 * PURE. The multi-entry builder for the scheduler form. A recurring pick may name
 * SEVERAL weekdays at once (Mon + Wed + Fri) — but the stored shape is unchanged:
 * each weekday fans out to its own single-weekday recurring doc via the singular
 * buildUnavailabilityEntry, so the frozen date engine sees exactly what it does
 * today. single / range still yield a single entry. Returns `{ entries }` (a
 * possibly-multi array) on success or `{ error }` on failure — never both.
 *
 * @param {{workerId?: string, type?: string, mode?: string, date?: string, startDate?: string, endDate?: string, weekdays?: Array<number|string>}} fields
 * @returns {{entries: object[]} | {error: string}}
 */
export function buildUnavailabilityEntries({
  workerId,
  type,
  mode,
  date,
  startDate,
  endDate,
  weekdays,
}) {
  if (mode === 'recurring') {
    // Coerce → integers, keep only 1..7, dedup (order preserved). Each survivor
    // becomes one single-weekday doc.
    const wds = [
      ...new Set(
        (Array.isArray(weekdays) ? weekdays : [])
          .map((w) => Number(w))
          .filter((w) => Number.isInteger(w) && w >= 1 && w <= 7),
      ),
    ]
    if (wds.length === 0) return { error: 'Pick at least one weekday.' }

    const entries = []
    for (const wd of wds) {
      const r = buildUnavailabilityEntry({ workerId, type, mode: 'recurring', weekday: wd })
      if (r.error) return { error: r.error } // e.g. missing worker/type — surface it
      entries.push(r.entry)
    }
    return { entries }
  }

  // single / range: delegate once and wrap the single entry (or pass the error).
  const r = buildUnavailabilityEntry({ workerId, type, mode, date, startDate, endDate })
  if (r.error) return { error: r.error }
  return { entries: [r.entry] }
}

/**
 * PURE. Human-readable schedule text for the admin list (display only):
 *   single    → the date string
 *   range     → 'start – end'
 *   recurring → 'Every <Weekday>'
 * Null-safe: a missing/unknown-mode entry → ''.
 *
 * @param {object} entry
 * @returns {string}
 */
export function describeSchedule(entry) {
  if (!entry || typeof entry !== 'object') return ''
  switch (entry.mode) {
    case 'single':
      return entry.date ?? ''
    case 'range':
      return `${entry.startDate ?? '?'} – ${entry.endDate ?? '?'}`
    case 'recurring':
      return `Every ${WEEKDAY_LONG[entry.weekday] ?? '?'}`
    default:
      return ''
  }
}

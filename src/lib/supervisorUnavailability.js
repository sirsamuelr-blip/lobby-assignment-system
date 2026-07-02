// src/lib/supervisorUnavailability.js — supervisor-set unavailability: the
// DATE-LOGIC engine + its Firestore data layer (Phase 5a). This is the ENGINE
// half of Phase 5; the Admin UI that writes these docs is Phase 5b.
//
// A supervisor can put an advisor "out" for a whole day, a date range, or every
// occurrence of a weekday (WFH / PTO / special project / callout). Unlike Pending
// (10-min timer) and Temp-unavailable (30-min timer), this exclusion is NOT a
// short countdown — it is pure DATE LOGIC evaluated at query time: a worker is
// "out today" iff at least one of their unavailability docs matches the current
// LOCAL calendar day. There is no stored `isOut` flag and no client timer; the
// day rolls over on its own and the pool follows.
//
// CLAUDE.md invariants honored here:
//   #1  No PII: an unavailability doc carries only workerId, type, mode, and date
//       fields (+ a createdAt for ordering the admin list). Never client data.
//   #3/#7  "Today" is the office LOCAL day (WEEK_ZONE) — the SAME zone the weekly
//       reset uses, imported from week.js so there is one definition of "local".
//       All day math runs through Luxon .setZone(WEEK_ZONE) so it is DST-safe:
//       dates are compared as calendar days, never as raw UTC instants.
//
// Design notes:
//   • Dates are stored/compared as ISO 'YYYY-MM-DD' STRINGS. ISO date strings sort
//     lexicographically, so a range check is just `start <= today && today <= end`
//     — no Date arithmetic, no instant/zone bugs. NEVER store a Firestore Timestamp
//     for a date field; that reintroduces the very bug this module avoids.
//   • Recurring weekday is a Luxon ordinal 1..7 (1 = Mon … 7 = Sun), matching
//     DateTime#weekday exactly.
//   • All four types are treated IDENTICALLY for the pool (out while active). Type
//     is display/reporting only — the pool logic never branches on it.
//   • The collection is small (one row per absence), so we read it whole and filter
//     in memory — no composite index, no per-field query.

import { DateTime } from 'luxon'
import {
  collection,
  query,
  getDocs,
  getDocsFromServer,
  addDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore'
import { WEEK_ZONE } from './week.js'

// Human-facing labels for the four absence types — used by the Roster "Out · <TYPE>"
// pill and (later) the Admin list. Order matches the data model.
export const UNAVAIL_TYPE_LABELS = {
  wfh: 'WFH',
  pto: 'PTO',
  special_project: 'Special project',
  callout: 'Callout',
}

// Resolve the LOCAL calendar day for a reference instant: its ISO date string and
// its Luxon weekday (1 = Mon … 7 = Sun). `now` may be a Date or a raw millis number
// (the Roster passes Date.now()). Going through .setZone(WEEK_ZONE) before reading
// the date is what makes this DST-safe — the calendar day is resolved in the
// office's zone, not in UTC.
function localDay(now) {
  const dt = DateTime.fromJSDate(now instanceof Date ? now : new Date(+now)).setZone(WEEK_ZONE)
  return { iso: dt.toISODate(), weekday: dt.weekday }
}

/**
 * PURE. Does a single unavailability doc make its worker "out" on the LOCAL day of
 * `now`? Null-safe: a missing/malformed doc or unknown mode → false.
 *
 *   single    → doc.date === today
 *   range     → doc.startDate <= today <= doc.endDate   (both inclusive; ISO strings
 *               sort lexicographically, so this is a plain string comparison)
 *   recurring → doc.weekday === today's Luxon weekday
 *
 * @param {object} doc  an unavailability doc's data
 * @param {Date|number} [now]
 * @returns {boolean}
 */
export function isSupervisorUnavailableOn(doc, now = new Date()) {
  if (!doc || typeof doc !== 'object') return false
  const { iso, weekday } = localDay(now)
  switch (doc.mode) {
    case 'single':
      return doc.date === iso
    case 'range':
      return (
        typeof doc.startDate === 'string' &&
        typeof doc.endDate === 'string' &&
        doc.startDate <= iso &&
        iso <= doc.endDate
      )
    case 'recurring':
      return doc.weekday === weekday
    default:
      return false
  }
}

/**
 * PURE. Given raw unavailability-doc data objects, return the deduped workerIds
 * with at least one doc active on the LOCAL day of `now`. This is the single
 * source of truth for "who is out today" — the pool excludes exactly these, and
 * the Roster paints them grey. Safe on empty/undefined; accepts Date or millis.
 *
 * @param {Array<object>} docs
 * @param {Date|number} [now]
 * @returns {string[]}
 */
export function activeSupervisorUnavailableIds(docs, now = new Date()) {
  const ids = new Set()
  for (const d of docs ?? []) {
    if (!d || !d.workerId) continue
    if (isSupervisorUnavailableOn(d, now)) ids.add(d.workerId)
  }
  return [...ids]
}

/**
 * The query-time exclusion set, read FROM SERVER so an absence a supervisor just
 * entered is seen immediately (mirrors getPendingIds' getDocsFromServer reasoning —
 * reading cache could hand out a worker who was just marked out). Reads the whole
 * small collection and filters in memory (no composite index).
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {Date} [now]
 * @returns {Promise<string[]>}
 */
export async function getSupervisorUnavailableIds(db, now = new Date()) {
  const snap = await getDocsFromServer(query(collection(db, 'unavailability')))
  return activeSupervisorUnavailableIds(
    snap.docs.map((d) => d.data()),
    now,
  )
}

/**
 * Live subscription for the Roster/Live Status tab and (later) the Admin list.
 * Hands `cb` the array of doc data objects on every change, each carrying its doc
 * id so the Admin UI can delete by id; returns the unsubscribe fn.
 */
export function subscribeUnavailability(db, cb) {
  return onSnapshot(query(collection(db, 'unavailability')), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
  )
}

// --- Data-layer writers (used by Phase 5b's Admin UI; thin, no validation here) --

/**
 * One-shot read of every unavailability doc, each with its id. (Cache-or-server —
 * for the admin list, unlike the pool read which must be server-fresh.)
 */
export async function getAllUnavailability(db) {
  const snap = await getDocs(query(collection(db, 'unavailability')))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

/**
 * Append an unavailability entry (auto doc id) with a server createdAt for ordering
 * the admin list. `entry` is the caller's shape ({ workerId, type, mode, date… }) —
 * validation lives in the 5b UI, not here. Returns the new doc id.
 */
export async function addUnavailability(db, entry) {
  const ref = await addDoc(collection(db, 'unavailability'), {
    ...entry,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

/** Remove one unavailability entry by doc id (the "undo a mis-mark" path). */
export async function deleteUnavailability(db, id) {
  await deleteDoc(doc(db, 'unavailability', id))
}

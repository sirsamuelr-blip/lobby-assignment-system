import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { subscribeWorkers } from '../lib/workers'
import { PROGRAM_LABELS } from '../lib/selection'
import { activePendingIds, subscribePending } from '../lib/pending'
import { activeTempUnavailableIds, subscribeTempUnavailable } from '../lib/unavailable'
import {
  activeSupervisorUnavailableIds,
  isSupervisorUnavailableOn,
  subscribeUnavailability,
  UNAVAIL_TYPE_LABELS,
} from '../lib/supervisorUnavailability'

const PROGRAMS = ['snap', 'tanf', 'mepd', 'medicaid']

/**
 * Derive a worker's live status, in strict precedence order. A deactivated worker
 * ('inactive') outranks everything; then supervisor-set unavailability ('out',
 * grey, date-based — WFH/PTO/special project/callout); then temp-unavailable
 * ('temp', clerk-set 30-min); then pending ('pending', suggested); else available.
 * Higher-precedence states describe a worker who is more firmly out of the pool, so
 * they win even if a lower-precedence doc lingers a moment.
 *
 * @param {{id: string, active?: boolean}} worker
 * @param {{pendingIds?: string[], tempUnavailableIds?: string[], supervisorUnavailableIds?: string[]}} live
 * @returns {'inactive' | 'out' | 'temp' | 'pending' | 'available'}
 */
export function workerStatus(
  worker,
  { pendingIds = [], tempUnavailableIds = [], supervisorUnavailableIds = [] } = {},
) {
  if (worker.active === false) return 'inactive'
  if (supervisorUnavailableIds.includes(worker.id)) return 'out'
  if (tempUnavailableIds.includes(worker.id)) return 'temp'
  if (pendingIds.includes(worker.id)) return 'pending'
  return 'available'
}

// Color coding matches CLAUDE.md's palette: green = available, yellow = pending,
// orange = temp-unavailable (a DISTINCT warm shade so a clerk can tell the two
// apart), and grey = out (supervisor-set) / inactive (deactivated) — both fully
// out of the pool, so they read as neutral-cool, not warm.
const STATUS_STYLES = {
  available: {
    label: 'Available',
    pill: 'bg-green-100 text-green-800',
    dot: 'bg-green-500',
    card: 'border-slate-200',
  },
  pending: {
    label: 'Pending',
    pill: 'bg-amber-100 text-amber-800',
    dot: 'bg-amber-500',
    card: 'border-amber-200 bg-amber-50/40',
  },
  temp: {
    label: 'Unavailable',
    pill: 'bg-orange-200 text-orange-900',
    dot: 'bg-orange-500',
    card: 'border-orange-300 bg-orange-50/60',
  },
  out: {
    label: 'Out',
    pill: 'bg-slate-200 text-slate-700',
    dot: 'bg-slate-500',
    card: 'border-slate-300 bg-slate-50',
  },
  inactive: {
    label: 'Inactive',
    pill: 'bg-slate-100 text-slate-500',
    dot: 'bg-slate-400',
    card: 'border-slate-200 bg-slate-50/60',
  },
}

const formatRemaining = (ms) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

const trainedLabels = (worker) =>
  PROGRAMS.filter((p) => worker.programs?.[p])
    .map((p) => PROGRAM_LABELS[p])
    .join(' · ')

export default function Roster() {
  const [workers, setWorkers] = useState(null)
  const [rosterError, setRosterError] = useState('')
  const [pendingDocs, setPendingDocs] = useState([])
  const [tempDocs, setTempDocs] = useState([])
  const [unavailDocs, setUnavailDocs] = useState([])
  // ~1s tick so expired yellows flip back to green and countdowns move without a
  // manual refresh (Pending is derived from expiresAt > now, not from a delete).
  const [nowTick, setNowTick] = useState(() => Date.now())

  // Live roster — the Admin page can add/edit/deactivate workers, so subscribe
  // (like subscribePending below) rather than loading once; deactivations and
  // edits repaint without a reload.
  useEffect(() => {
    const unsub = subscribeWorkers(db, setWorkers, (err) =>
      setRosterError(err?.message ?? String(err)),
    )
    return () => unsub()
  }, [])

  // Live pending state, shared across all clerks' tabs.
  useEffect(() => {
    const unsub = subscribePending(db, setPendingDocs)
    return () => unsub()
  }, [])

  // Live temp-unavailable state, likewise shared across all tabs.
  useEffect(() => {
    const unsub = subscribeTempUnavailable(db, setTempDocs)
    return () => unsub()
  }, [])

  // Live supervisor-set unavailability (the whole small collection). Who is "out
  // today" is derived from these by date logic against the same 1s nowTick below,
  // so a day roll-over (or a range ending) flips the pill without a refresh.
  useEffect(() => {
    const unsub = subscribeUnavailability(db, setUnavailDocs)
    return () => unsub()
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Same expiry filter the pool uses, evaluated against the live clock.
  const pendingIds = activePendingIds(pendingDocs, nowTick)
  const expiryByWorker = new Map()
  for (const d of pendingDocs) {
    if (!d?.workerId) continue
    const expMs =
      d.expiresAt && typeof d.expiresAt.toMillis === 'function'
        ? d.expiresAt.toMillis()
        : +d.expiresAt
    if (expMs > nowTick) expiryByWorker.set(d.workerId, expMs)
  }

  // Temp-unavailable, same query-time filter but keyed on `until` (30-min window).
  const tempUnavailableIds = activeTempUnavailableIds(tempDocs, nowTick)
  const untilByWorker = new Map()
  for (const d of tempDocs) {
    if (!d?.workerId) continue
    const untilMs =
      d.until && typeof d.until.toMillis === 'function' ? d.until.toMillis() : +d.until
    if (untilMs > nowTick) untilByWorker.set(d.workerId, untilMs)
  }

  // Supervisor-set unavailability: date logic (not a timer) against the live day.
  // Also map each out worker → the type of their FIRST active doc, for the pill's
  // "Out · <TYPE>" label. No countdown — this is calendar-based, not a short window.
  const supervisorUnavailableIds = activeSupervisorUnavailableIds(unavailDocs, nowTick)
  const outTypeByWorker = new Map()
  for (const d of unavailDocs) {
    if (!d?.workerId || outTypeByWorker.has(d.workerId)) continue
    if (isSupervisorUnavailableOn(d, nowTick)) outTypeByWorker.set(d.workerId, d.type)
  }

  if (rosterError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-semibold text-red-800">Could not load the worker roster.</p>
        <p className="mt-1 break-words text-sm text-red-700">{rosterError}</p>
      </div>
    )
  }

  if (!workers) {
    return <p className="text-sm text-slate-500">Loading roster…</p>
  }

  const sorted = [...workers].sort(
    (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
  )
  const live = { pendingIds, tempUnavailableIds, supervisorUnavailableIds }
  // Tallies count only ACTIVE workers — inactive (deactivated) ones are not part of
  // the pool math at all, just rendered greyed with an "Inactive" pill.
  const activeWorkers = sorted.filter((w) => w.active !== false)
  const pendingCount = activeWorkers.filter((w) => workerStatus(w, live) === 'pending').length
  const tempCount = activeWorkers.filter((w) => workerStatus(w, live) === 'temp').length
  const outCount = activeWorkers.filter((w) => workerStatus(w, live) === 'out').length
  // Pending, temp, and out workers are all OUT of the pool, so none count as available.
  const availableCount = activeWorkers.length - pendingCount - tempCount - outCount
  const inactiveCount = sorted.length - activeWorkers.length

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white px-6 py-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Roster · Live Status</h2>
        <p className="mt-1 text-sm text-slate-500">
          Everyone on the roster, updating live as clerks work. A worker turns{' '}
          <span className="font-medium text-amber-700">yellow (Pending)</span> the instant they are
          suggested, <span className="font-medium text-orange-700">orange (Unavailable)</span> when a
          clerk marks them out for 30 minutes, <span className="font-medium text-slate-600">grey
          (Out)</span> when a supervisor has them on WFH / PTO / a special project / a callout, and
          back to <span className="font-medium text-green-700">green</span> when assigned, released,
          or the window lapses.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-green-800">
            <span className="h-2 w-2 rounded-full bg-green-500" /> {availableCount} available
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-500" /> {pendingCount} pending
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-200 px-3 py-1 text-orange-900">
            <span className="h-2 w-2 rounded-full bg-orange-500" /> {tempCount} unavailable
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-200 px-3 py-1 text-slate-700">
            <span className="h-2 w-2 rounded-full bg-slate-500" /> {outCount} out
          </span>
          {inactiveCount > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-slate-500">
              <span className="h-2 w-2 rounded-full bg-slate-400" /> {inactiveCount} inactive
            </span>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sorted.map((worker) => {
          const status = workerStatus(worker, live)
          const style = STATUS_STYLES[status]
          // 'Out' shows the absence type inline (e.g. "Out · PTO"); every other
          // status uses its plain label.
          const outType = status === 'out' ? outTypeByWorker.get(worker.id) : null
          const label =
            outType != null ? `${style.label} · ${UNAVAIL_TYPE_LABELS[outType] ?? outType}` : style.label
          // Only pending (10-min expiresAt) and temp (30-min until) get a countdown.
          // Out/inactive are date-based, not a short timer — no countdown.
          const expMs =
            status === 'pending'
              ? expiryByWorker.get(worker.id)
              : status === 'temp'
                ? untilByWorker.get(worker.id)
                : null
          return (
            <div
              key={worker.id}
              className={[
                'flex items-center justify-between gap-3 rounded-lg border bg-white px-4 py-4 shadow-sm',
                style.card,
              ].join(' ')}
            >
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-700">
                  {worker.firstName[0]}
                  {worker.lastName[0]}
                </div>
                <div>
                  <p className="text-base font-semibold text-slate-900">
                    {worker.firstName} {worker.lastName}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    EA{worker.eaLevel} · {trainedLabels(worker) || 'no programs'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
                    style.pill,
                  ].join(' ')}
                >
                  <span className={['h-2 w-2 rounded-full', style.dot].join(' ')} />
                  {label}
                </span>
                {(status === 'pending' || status === 'temp') && expMs != null && (
                  <span
                    className={[
                      'text-[0.7rem] font-medium tabular-nums',
                      status === 'temp' ? 'text-orange-700' : 'text-amber-700',
                    ].join(' ')}
                  >
                    {formatRemaining(expMs - nowTick)} left
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

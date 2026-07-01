import { useEffect, useState } from 'react'
import { db } from '../firebase'
import { getAllWorkers } from '../lib/workers'
import { PROGRAM_LABELS } from '../lib/selection'
import { activePendingIds, subscribePending } from '../lib/pending'
import { activeTempUnavailableIds, subscribeTempUnavailable } from '../lib/unavailable'

const PROGRAMS = ['snap', 'tanf', 'mepd', 'medicaid']

/**
 * Derive a worker's live status. Kept as a small helper so later phases extend it
 * cleanly: Phase 4 adds 'temp' (temp-unavailable → amber/orange) and Phase 5 adds
 * 'out' (WFH/PTO/etc → grey). Today: temp (out for 30 min) vs pending (yellow) vs
 * available (green). Temp is checked FIRST — a marked-unavailable worker is out of
 * the pool, so that state wins even if a stale pending doc lingers a moment.
 *
 * @param {{id: string}} worker
 * @param {{pendingIds?: string[], tempUnavailableIds?: string[]}} live
 * @returns {'temp' | 'pending' | 'available'}
 */
export function workerStatus(worker, { pendingIds = [], tempUnavailableIds = [] } = {}) {
  if (tempUnavailableIds.includes(worker.id)) return 'temp'
  if (pendingIds.includes(worker.id)) return 'pending'
  return 'available'
}

// Color coding matches CLAUDE.md's warm family: green = available, yellow =
// pending, and temp-unavailable also warm but a DISTINCT orange shade + its own
// "Unavailable" label, so a clerk can tell the two apart at a glance.
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
  // ~1s tick so expired yellows flip back to green and countdowns move without a
  // manual refresh (Pending is derived from expiresAt > now, not from a delete).
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    getAllWorkers(db)
      .then((ws) => !cancelled && setWorkers(ws))
      .catch((err) => !cancelled && setRosterError(err?.message ?? String(err)))
    return () => {
      cancelled = true
    }
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
  const live = { pendingIds, tempUnavailableIds }
  const pendingCount = sorted.filter((w) => workerStatus(w, live) === 'pending').length
  const tempCount = sorted.filter((w) => workerStatus(w, live) === 'temp').length
  // Temp workers are OUT of the pool, so they are NOT counted as available.
  const availableCount = sorted.length - pendingCount - tempCount

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white px-6 py-4 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Roster · Live Status</h2>
        <p className="mt-1 text-sm text-slate-500">
          Everyone on the roster, updating live as clerks work. A worker turns{' '}
          <span className="font-medium text-amber-700">yellow (Pending)</span> the instant they are
          suggested, <span className="font-medium text-orange-700">orange (Unavailable)</span> when a
          clerk marks them out for 30 minutes, and back to{' '}
          <span className="font-medium text-green-700">green</span> when assigned, released, or the
          window lapses.
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
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sorted.map((worker) => {
          const status = workerStatus(worker, live)
          const style = STATUS_STYLES[status]
          // Pending counts down to its 10-min expiresAt; temp to its 30-min until.
          const expMs = status === 'temp' ? untilByWorker.get(worker.id) : expiryByWorker.get(worker.id)
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
                  {style.label}
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

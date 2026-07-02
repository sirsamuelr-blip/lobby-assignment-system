// src/screens/Reports.jsx — the Reports / Balances screen (Phase 7b part 2).
//
// The fairness proof for the pitch: a live, per-advisor picture of how the case
// load is distributed for a chosen window (today / this week / the rolling
// historical span). It is a pure READER over the single source of truth
// (invariant #6): every number is DERIVED from `assignments` on each emit via
// subscribeBalances — this screen writes NOTHING and stores no counter. And it
// holds no client PII (invariant #1): the only things on screen are advisor
// names (from the roster) and counts of assignments — never a client name or a
// case number.

import { useEffect, useState } from 'react'
import { DateTime } from 'luxon'
import { db } from '../firebase'
import { subscribeBalances, DEFAULT_HISTORICAL_WEEKS } from '../lib/counts'
import { subscribeWorkers } from '../lib/workers'
import { WEEK_ZONE } from '../lib/week'

// The three windows, in ascending span order. The third's label is built from
// DEFAULT_HISTORICAL_WEEKS (never a hardcoded 8), so changing the constant in
// counts.js re-labels the toggle automatically. DEFAULT is 'week' — the pitch
// view (fairness over the current fairness period).
const WINDOWS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'historical', label: `Last ${DEFAULT_HISTORICAL_WEEKS} weeks` },
]

// A nonzero count always shows at least a sliver of bar, so a 1 is visibly
// distinct from a 0's empty track. Length still carries the story — this is only
// a floor so the smallest carrier doesn't vanish.
const MIN_BAR_PCT = 4

// Shared styles, lifted from Admin.jsx's slate palette so the toggle matches the
// rest of the tool (segmented, big tap targets, keyboard focus rings).
const toggleClass = (on) =>
  [
    'rounded-lg border px-4 py-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
    on
      ? 'border-blue-700 bg-blue-700 text-white'
      : 'border-slate-300 bg-white text-slate-700 hover:border-blue-400 hover:bg-blue-50',
  ].join(' ')

const LABEL = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500'

// Format a boundary Date in the office zone (WEEK_ZONE), e.g. "Wed, Jul 1".
const fmtBoundary = (d) => DateTime.fromJSDate(d).setZone(WEEK_ZONE).toFormat('ccc, LLL d')

export default function Reports() {
  const [balances, setBalances] = useState(null) // null = loading
  const [workers, setWorkers] = useState(null) // null = loading
  const [error, setError] = useState('')
  const [windowKey, setWindowKey] = useState('week') // the pitch default

  // Live balances — every count DERIVED from `assignments` on each emit; reads
  // only (invariant #6). Gives us the three window Maps plus their boundaries.
  useEffect(() => {
    const unsub = subscribeBalances(db, setBalances, {
      onError: (err) => setError(err?.message ?? String(err)),
    })
    return () => unsub()
  }, [])

  // Live roster — resolves workerId → name / EA / active, and lets us render the
  // zero-count advisors too (the distribution must show everyone).
  useEffect(() => {
    const unsub = subscribeWorkers(db, setWorkers, (err) =>
      setError(err?.message ?? String(err)),
    )
    return () => unsub()
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-semibold text-red-800">Could not load the balances.</p>
        <p className="mt-1 break-words text-sm text-red-700">{error}</p>
      </div>
    )
  }

  if (balances === null || workers === null) {
    return <p className="text-sm text-slate-500">Loading balances…</p>
  }

  // --- Derive everything for the active window (plain, cheap for ~22 workers) --

  const activeMap = balances[windowKey] // Map<workerId, count>
  const boundary =
    windowKey === 'today'
      ? balances.boundaries.todayStart
      : windowKey === 'week'
        ? balances.boundaries.weekStart
        : balances.boundaries.historicalStart

  const boundaryLabel =
    windowKey === 'today'
      ? `Today · ${fmtBoundary(boundary)}`
      : windowKey === 'week'
        ? `This week · since ${fmtBoundary(boundary)}`
        : `Last ${DEFAULT_HISTORICAL_WEEKS} weeks · since ${fmtBoundary(boundary)}`

  // Row set: every active advisor (so a legitimately-idle one shows a 0), plus
  // any DEACTIVATED advisor who still carried cases in this window (kept so the
  // bars reconcile to the Total, and tagged "Inactive").
  const active = workers.filter((w) => w.active !== false)
  const countedInactive = workers.filter((w) => w.active === false && activeMap.has(w.id))
  const rows = [...active, ...countedInactive]
    .map((w) => ({ worker: w, count: activeMap.get(w.id) ?? 0, inactive: w.active === false }))
    // Busiest on top: count DESC, then the roster's alphabetical order — so a
    // spike is obvious and a fair week reads as a gentle, even staircase.
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.worker.lastName.localeCompare(b.worker.lastName) ||
        a.worker.firstName.localeCompare(b.worker.firstName),
    )

  // The quantitative proof — all derived from activeMap only.
  const values = [...activeMap.values()] // every value is > 0 (a worker is in the Map only if bumped)
  const total = values.reduce((sum, v) => sum + v, 0)
  const carrying = activeMap.size
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  const rangeLabel = carrying === 0 ? '—' : min === max ? String(min) : `${min}–${max}`

  // Bar scale: largest count among the rows, floored at 1 to avoid /0.
  const maxCount = Math.max(1, ...rows.map((r) => r.count))

  // Reconciliation: cases whose workerId has NO roster doc at all — genuinely
  // unattributable, so no bar represents them. Defensive: workers are never
  // hard-deleted, so this is normally 0. A DEACTIVATED advisor with cases is NOT
  // counted here — they render as their own "Inactive"-tagged bar above, so their
  // cases are already on the chart. Thus visible bars + N = Total, no double-count.
  const workerById = new Map(workers.map((w) => [w.id, w]))
  let offRosterCases = 0
  for (const [id, count] of activeMap) {
    const w = workerById.get(id)
    if (!w) offRosterCases += count
  }

  return (
    <div className="space-y-6">
      <Card
        title="Case Balances"
        subtitle="Each advisor's case load for the selected window — derived live from the assignment log, the single source of truth. No client names or case numbers are stored anywhere in this system; these bars count assignments only. This is the fairness picture a supervisor sees."
      >
        {/* Window toggle (segmented) + the boundary it resolves to */}
        <div>
          <span className={LABEL}>Window</span>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Report window">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                onClick={() => setWindowKey(w.key)}
                aria-pressed={windowKey === w.key}
                className={toggleClass(windowKey === w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs font-medium text-slate-500">{boundaryLabel}</p>
        </div>

        {total === 0 ? (
          <p className="mt-6 text-sm text-slate-500">No assignments in this window yet.</p>
        ) : (
          <>
            {/* Stat tiles — the quantitative proof */}
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Total cases" value={total} />
              <StatTile
                label="Advisors carrying"
                value={carrying}
                sub={`of ${active.length} active`}
              />
              <StatTile label="Range" value={rangeLabel} sub="low–high per carrier" />
            </div>

            {/* Per-advisor distribution bars */}
            <ul className="mt-6 space-y-3">
              {rows.map(({ worker, count, inactive }) => {
                const pct = count === 0 ? 0 : Math.max((count / maxCount) * 100, MIN_BAR_PCT)
                return (
                  <li key={worker.id} className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-700">
                      {worker.firstName?.[0] ?? ''}
                      {worker.lastName?.[0] ?? ''}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-900">
                            {worker.firstName} {worker.lastName}
                          </span>
                          <span className="shrink-0 text-xs font-medium text-slate-500">
                            EA{worker.eaLevel}
                          </span>
                          {inactive && (
                            <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-[0.65rem] font-semibold text-slate-500">
                              Inactive
                            </span>
                          )}
                        </div>
                        {/* The real, screen-reader-visible value. */}
                        <span
                          className={[
                            'shrink-0 text-sm font-bold tabular-nums',
                            count === 0 ? 'text-slate-500' : 'text-slate-900',
                          ].join(' ')}
                        >
                          {count}
                        </span>
                      </div>
                      {/* Decorative bar — length carries the story; count text above is authoritative. */}
                      <div
                        aria-hidden="true"
                        className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
                      >
                        <div
                          className="h-full rounded-full bg-blue-600 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>

            {offRosterCases > 0 && (
              <p className="mt-5 text-xs text-slate-500">
                Includes {offRosterCases} case{offRosterCases === 1 ? '' : 's'} not attributable to
                a current advisor.
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  )
}

// One quantitative stat, in the shared slate style (label / big number / sub).
function StatTile({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  )
}

// Local Card, matching Assign.jsx / Admin.jsx / Log.jsx (title / subtitle header
// + padded body).
function Card({ title, subtitle, children }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      {(title || subtitle) && (
        <div className="border-b border-slate-200 px-6 py-4">
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
      )}
      <div className="px-6 py-6">{children}</div>
    </section>
  )
}

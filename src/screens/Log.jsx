// src/screens/Log.jsx — the read-only assignment Log (Phase 7a).
//
// A live, chronological record of every confirmed Assign, newest first. It is a
// pure READER over the single source of truth (invariant #6): it subscribes to
// `assignments`, writes NOTHING, and derives no counts. No client PII is stored
// in these docs (invariant #1) — only a sequential ticket, the program(s), the
// advisor, the clerk, and the manual/reassign flags — so nothing sensitive can
// surface here.

import { useEffect, useMemo, useState } from 'react'
import { DateTime } from 'luxon'
import { db } from '../firebase'
import { subscribeAssignments } from '../lib/assignments'
import { subscribeWorkers } from '../lib/workers'
import { subscribeUsers } from '../lib/users'
import { PROGRAM_LABELS } from '../lib/selection'
import { formatTicket } from '../lib/tickets'
import { WEEK_ZONE } from '../lib/week'

// Format an assignment's timestamp (millis) in the office zone. A just-written
// serverTimestamp can still be null on the first local snapshot (the estimate
// notwithstanding), so render 'just now' rather than calling .setZone on null.
const formatWhen = (ms) =>
  ms == null
    ? 'just now'
    : DateTime.fromMillis(ms).setZone(WEEK_ZONE).toFormat('ccc, LLL d · h:mm a')

// Human-readable program list, e.g. "SNAP · MEPD". Never assumes a non-empty or
// known-key array — an unknown key falls back to its raw value, and an empty
// list renders an em dash.
const formatPrograms = (programs) => {
  // Array.isArray (not just `?? []`) so a malformed non-array value can't reach
  // .map and crash the render — matching selection.js's own guard.
  const labels = (Array.isArray(programs) ? programs : []).map((p) => PROGRAM_LABELS[p] ?? p)
  return labels.length ? labels.join(' · ') : '—'
}

// Fallback when a clerkId (a signed-in user's uid) has no matching users doc —
// e.g. an older dev-era assignment. Shows a short prefix with the full id on
// hover (title attr). Never a client identifier.
const truncateClerk = (clerkId) => (clerkId ? `${String(clerkId).slice(0, 8)}…` : '—')

export default function Log() {
  const [rows, setRows] = useState(null) // null = loading
  const [logError, setLogError] = useState('')
  const [workers, setWorkers] = useState([])
  const [users, setUsers] = useState([])

  // Live, read-only feed of the assignment history (newest first, capped at 200).
  useEffect(() => {
    const unsub = subscribeAssignments(db, setRows, (err) =>
      setLogError(err?.message ?? String(err)),
    )
    return () => unsub()
  }, [])

  // Live roster, only to resolve workerId → name. Best-effort: a miss falls back
  // to the raw id, so no onError handling is needed here.
  useEffect(() => {
    const unsub = subscribeWorkers(db, setWorkers)
    return () => unsub()
  }, [])

  // Live users list, only to resolve clerkId (a uid) → name. Best-effort: a miss
  // falls back to a short id, so no onError handling is needed here.
  useEffect(() => {
    const unsub = subscribeUsers(db, setUsers)
    return () => unsub()
  }, [])

  const nameById = useMemo(() => {
    const m = new Map()
    for (const w of workers ?? []) m.set(w.id, `${w.firstName} ${w.lastName}`)
    return m
  }, [workers])

  const clerkNameById = useMemo(() => {
    const m = new Map()
    for (const u of users ?? []) m.set(u.id, u.name)
    return m
  }, [users])

  if (logError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-semibold text-red-800">Could not load the assignment log.</p>
        <p className="mt-1 break-words text-sm text-red-700">{logError}</p>
      </div>
    )
  }

  if (rows === null) {
    return <p className="text-sm text-slate-500">Loading log…</p>
  }

  return (
    <div className="space-y-6">
      <Card
        title="Assignment Log"
        subtitle="A live, read-only record of every confirmed assignment, newest first — derived entirely from the assignments collection. No client names or case numbers are ever stored here; only the ticket, program(s), advisor, and clerk."
      >
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No assignments yet.</p>
        ) : (
          <>
            <p className="mb-3 text-xs font-medium text-slate-500">
              Showing the {rows.length} most recent {rows.length === 1 ? 'assignment' : 'assignments'}
              {rows.length === 200 ? ' (capped at 200)' : ''}.
            </p>
            <div className="space-y-2">
              {rows.map((row) => {
                const workerName = nameById.get(row.workerId) ?? row.workerId
                const fromName = row.reassignedFrom
                  ? nameById.get(row.reassignedFrom) ?? row.reassignedFrom
                  : null
                const clerkName = clerkNameById.get(row.clerkId)
                return (
                  <div
                    key={row.id}
                    className="rounded-lg border border-slate-200 bg-white px-4 py-4 shadow-sm"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold tabular-nums text-slate-900">
                            {formatTicket(row.ticket)}
                          </span>
                          {row.manual === true && (
                            <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                              Manual
                            </span>
                          )}
                          {row.reassignedFrom && (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                              Reassigned
                            </span>
                          )}
                        </div>

                        <p className="mt-1 text-sm font-semibold text-slate-900">
                          {formatPrograms(row.programs)}
                        </p>

                        <p className="mt-0.5 text-sm text-slate-700">
                          <span className="text-slate-500">Worker:</span> {workerName}
                          {fromName && (
                            <span className="text-slate-500"> · from {fromName}</span>
                          )}
                        </p>

                        <p className="mt-0.5 text-xs text-slate-500">
                          Clerk:{' '}
                          <span title={row.clerkId} className={clerkName ? 'text-slate-600' : 'font-mono text-slate-600'}>
                            {clerkName ?? truncateClerk(row.clerkId)}
                          </span>
                        </p>
                      </div>

                      <div className="shrink-0 sm:text-right">
                        <p className="text-sm font-medium tabular-nums text-slate-700">
                          {formatWhen(row.timestamp)}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        <p className="mt-4 text-xs text-slate-500">
          Clerk shows the staff member who recorded each assignment. Older development entries may
          show a short identifier instead of a name.
        </p>
      </Card>
    </div>
  )
}

// Local Card, matching Assign.jsx / Admin.jsx (title / subtitle header + padded body).
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

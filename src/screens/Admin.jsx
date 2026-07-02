// src/screens/Admin.jsx — the supervisor Staff Management page (Phase 5b).
//
// Two sections, both in the shared Card/slate visual language:
//   1. STAFF MANAGEMENT — add / edit / (de)activate the advisor roster.
//   2. UNAVAILABILITY SCHEDULER — put an advisor "out" for a day, a range, or a
//      recurring weekday, and list/delete existing absences.
//
// Everything is live: workers and unavailability are subscriptions, so an edit
// here repaints the Roster and reshapes the Assign pool without a reload.
//
// GUARDRAILS honored here:
//   #1  No client PII anywhere on this screen. Worker docs carry only name / EA /
//       training / active; absence docs only worker / type / mode / date fields.
//   #2  NO admin action ever writes a count. This page writes only `workers` and
//       `unavailability` — never `assignments` or a counter.
//   #3  Workers are DEACTIVATED (active:false), never hard-deleted — assignment
//       history references workerId forever (setWorkerActive is the only path).
//   #4/#5  Recurring weekday is a Luxon ordinal (Mon=1…Sun=7) stored as a NUMBER;
//       dates are the raw 'YYYY-MM-DD' strings from <input type="date">. Both are
//       enforced by buildUnavailabilityEntry (see lib/scheduleForm.js).
//
// Role-gating (Admin = supervisor-only) arrives in Phase 8; for now the tab is
// open to everyone (see App.jsx).

import { useEffect, useMemo, useState } from 'react'
import { db } from '../firebase'
import { subscribeWorkers, upsertWorker, setWorkerActive } from '../lib/workers'
import {
  subscribeUnavailability,
  addUnavailability,
  deleteUnavailability,
  UNAVAIL_TYPE_LABELS,
} from '../lib/supervisorUnavailability'
import { PROGRAM_LABELS } from '../lib/selection'
import { buildUnavailabilityEntries, describeSchedule, WEEKDAYS } from '../lib/scheduleForm'

const PROGRAMS = ['snap', 'tanf', 'mepd', 'medicaid']
const EA_LEVELS = [1, 2, 3]
const TYPE_OPTIONS = Object.entries(UNAVAIL_TYPE_LABELS) // [['wfh','WFH'], …]
const MODE_OPTIONS = [
  { value: 'single', label: 'Single day' },
  { value: 'range', label: 'Date range' },
  { value: 'recurring', label: 'Recurring weekly' },
]

const emptyPrograms = () => ({ snap: false, tanf: false, mepd: false, medicaid: false })
const normalizePrograms = (p) => ({
  snap: !!p?.snap,
  tanf: !!p?.tanf,
  mepd: !!p?.mepd,
  medicaid: !!p?.medicaid,
})
const trainedLabels = (programs) =>
  PROGRAMS.filter((p) => programs?.[p])
    .map((p) => PROGRAM_LABELS[p])
    .join(' · ')
const fullName = (w) => `${w.firstName} ${w.lastName}`

// --- Shared button/field styles (slate palette, big tap targets) --------------

const toggleClass = (on) =>
  [
    'rounded-lg border px-4 py-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
    on
      ? 'border-blue-700 bg-blue-700 text-white'
      : 'border-slate-300 bg-white text-slate-700 hover:border-blue-400 hover:bg-blue-50',
  ].join(' ')

const PRIMARY_BTN =
  'inline-flex items-center justify-center rounded-md bg-blue-700 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BTN =
  'inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'
const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500'
const LABEL = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500'

// A small reusable segmented picker of EA levels (1/2/3) and the four training
// toggles — used by both the per-row editor and the Add form.
function EaLevelPicker({ value, onChange, disabled }) {
  return (
    <div className="flex gap-2">
      {EA_LEVELS.map((lvl) => (
        <button
          key={lvl}
          type="button"
          onClick={() => onChange(lvl)}
          disabled={disabled}
          aria-pressed={value === lvl}
          className={toggleClass(value === lvl)}
        >
          EA{lvl}
        </button>
      ))}
    </div>
  )
}

function TrainingToggles({ programs, onToggle, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {PROGRAMS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onToggle(p)}
          disabled={disabled}
          aria-pressed={!!programs[p]}
          className={toggleClass(!!programs[p])}
        >
          {PROGRAM_LABELS[p]}
        </button>
      ))}
    </div>
  )
}

// --- Staff Management: one worker row (read summary + inline edit form) --------

function WorkerRow({ worker, onSave, onToggleActive }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draftEa, setDraftEa] = useState(worker.eaLevel)
  const [draftPrograms, setDraftPrograms] = useState(() => normalizePrograms(worker.programs))

  const inactive = worker.active === false

  function startEdit() {
    // Seed the draft from the CURRENT (live) worker each time edit opens.
    setDraftEa(worker.eaLevel)
    setDraftPrograms(normalizePrograms(worker.programs))
    setError('')
    setEditing(true)
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      // active is preserved as-is — (de)activation is a separate action below.
      await onSave({ ...worker, eaLevel: draftEa, programs: draftPrograms })
      setEditing(false)
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive() {
    setBusy(true)
    setError('')
    try {
      // inactive → reactivate (true); active → deactivate (false). Never a delete.
      await onToggleActive(worker.id, inactive)
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={[
        'rounded-lg border bg-white px-4 py-4 shadow-sm',
        inactive ? 'border-slate-200 bg-slate-50/60 opacity-70' : 'border-slate-200',
      ].join(' ')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-700">
            {worker.firstName[0]}
            {worker.lastName[0]}
          </div>
          <div>
            <p className="text-base font-semibold text-slate-900">{fullName(worker)}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              EA{worker.eaLevel} · {trainedLabels(worker.programs) || 'no programs'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className={[
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
              inactive ? 'bg-slate-100 text-slate-500' : 'bg-green-100 text-green-800',
            ].join(' ')}
          >
            <span
              className={['h-2 w-2 rounded-full', inactive ? 'bg-slate-400' : 'bg-green-500'].join(
                ' ',
              )}
            />
            {inactive ? 'Inactive' : 'Active'}
          </span>
          {!editing && (
            <>
              <button type="button" onClick={startEdit} disabled={busy} className={SECONDARY_BTN}>
                Edit
              </button>
              <button
                type="button"
                onClick={toggleActive}
                disabled={busy}
                className={
                  inactive
                    ? 'inline-flex items-center justify-center rounded-md border border-green-300 bg-white px-5 py-3 text-sm font-semibold text-green-800 shadow-sm transition hover:bg-green-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'
                    : 'inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60'
                }
              >
                {inactive ? 'Reactivate' : 'Deactivate'}
              </button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
          <div>
            <span className={LABEL}>EA level</span>
            <EaLevelPicker value={draftEa} onChange={setDraftEa} disabled={busy} />
          </div>
          <div>
            <span className={LABEL}>Trained programs</span>
            <TrainingToggles
              programs={draftPrograms}
              onToggle={(p) => setDraftPrograms((prev) => ({ ...prev, [p]: !prev[p] }))}
              disabled={busy}
            />
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy} className={PRIMARY_BTN}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className={SECONDARY_BTN}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!editing && error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  )
}

// --- Staff Management: the Add-a-worker form (collapsed behind a button) -------

function AddWorkerForm({ onAdd }) {
  const [open, setOpen] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [eaLevel, setEaLevel] = useState(1)
  const [programs, setPrograms] = useState(emptyPrograms)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function reset() {
    setFirstName('')
    setLastName('')
    setEaLevel(1)
    setPrograms(emptyPrograms())
    setError('')
  }

  async function submit() {
    if (!firstName.trim() || !lastName.trim()) {
      setError('First and last name are required.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onAdd({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        eaLevel,
        programs,
        active: true,
      })
      reset() // keep the form open so several advisors can be added in a row
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={PRIMARY_BTN}>
        + Add advisor
      </button>
    )
  }

  return (
    <div className="space-y-4 rounded-lg border border-dashed border-blue-300 bg-blue-50/40 px-4 py-4">
      <p className="text-sm font-semibold text-slate-900">Add a new advisor</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>First name</label>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={INPUT}
            placeholder="First"
          />
        </div>
        <div>
          <label className={LABEL}>Last name</label>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={INPUT}
            placeholder="Last"
          />
        </div>
      </div>
      <div>
        <span className={LABEL}>EA level</span>
        <EaLevelPicker value={eaLevel} onChange={setEaLevel} disabled={busy} />
      </div>
      <div>
        <span className={LABEL}>Trained programs</span>
        <TrainingToggles
          programs={programs}
          onToggle={(p) => setPrograms((prev) => ({ ...prev, [p]: !prev[p] }))}
          disabled={busy}
        />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={busy} className={PRIMARY_BTN}>
          {busy ? 'Adding…' : 'Add advisor'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          disabled={busy}
          className={SECONDARY_BTN}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// --- Unavailability Scheduler: the add-absence form ---------------------------

function SchedulerForm({ activeWorkers, onAdd }) {
  const [workerId, setWorkerId] = useState('')
  const [type, setType] = useState('wfh')
  const [mode, setMode] = useState('single')
  const [date, setDate] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  // Recurring is MULTI-select: a set of Luxon ordinals (Mon=1). Each chosen day
  // becomes its own single-weekday recurring doc (the engine's stored shape is
  // unchanged). Default: none selected.
  const [weekdays, setWeekdays] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const toggleWeekday = (value) =>
    setWeekdays((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })

  async function submit() {
    // All shaping/validation lives in the pure helper — including weekday-as-
    // number, the end-not-before-start rule, and fanning a multi-weekday pick out
    // into one entry per weekday.
    const result = buildUnavailabilityEntries({
      workerId,
      type,
      mode,
      date,
      startDate,
      endDate,
      weekdays: [...weekdays],
    })
    if (result.error) {
      setError(result.error)
      return
    }
    setBusy(true)
    setError('')
    try {
      // One addUnavailability write per entry (a single-weekday recurring pick or
      // single/range yields one; Mon+Wed+Fri yields three independent docs).
      await Promise.all(result.entries.map((e) => onAdd(e)))
      // Reset for the next entry.
      setWorkerId('')
      setType('wfh')
      setMode('single')
      setDate('')
      setStartDate('')
      setEndDate('')
      setWeekdays(new Set())
    } catch (err) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className={LABEL}>Advisor</label>
        <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} className={INPUT}>
          <option value="">Select an advisor…</option>
          {activeWorkers.map((w) => (
            <option key={w.id} value={w.id}>
              {fullName(w)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <span className={LABEL}>Type</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TYPE_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setType(value)}
              aria-pressed={type === value}
              className={toggleClass(type === value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className={LABEL}>How often</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              aria-pressed={mode === m.value}
              className={toggleClass(mode === m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mode-dependent inputs. Dates are the raw <input type="date"> strings. */}
      {mode === 'single' && (
        <div>
          <label className={LABEL}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        </div>
      )}

      {mode === 'range' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL}>Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className={INPUT}
            />
          </div>
          <div>
            <label className={LABEL}>End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>
      )}

      {mode === 'recurring' && (
        <div>
          <span className={LABEL}>Weekdays</span>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleWeekday(d.value)}
                aria-pressed={weekdays.has(d.value)}
                title={d.long}
                className={toggleClass(weekdays.has(d.value))}
              >
                {d.short}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Pick one or more — each becomes its own weekly absence.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <button type="button" onClick={submit} disabled={busy} className={PRIMARY_BTN}>
        {busy ? 'Adding…' : 'Add absence'}
      </button>
    </div>
  )
}

// --- Unavailability Scheduler: one existing-absence row -----------------------

function UnavailRow({ entry, workerName, onDelete }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    setBusy(true)
    setError('')
    try {
      await onDelete(entry.id)
    } catch (err) {
      setError(err?.message ?? String(err))
      setBusy(false)
    }
    // On success the subscription drops this row, so no need to clear busy.
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900">{workerName}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
            {UNAVAIL_TYPE_LABELS[entry.type] ?? entry.type}
          </span>{' '}
          · {describeSchedule(entry)}
        </p>
        {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
      </div>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        className="inline-flex shrink-0 items-center justify-center rounded-md border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 shadow-sm transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Removing…' : 'Delete'}
      </button>
    </div>
  )
}

// --- The page -----------------------------------------------------------------

export default function Admin() {
  const [workers, setWorkers] = useState(null)
  const [workersError, setWorkersError] = useState('')
  const [unavailDocs, setUnavailDocs] = useState([])

  useEffect(() => {
    const unsub = subscribeWorkers(db, setWorkers, (err) =>
      setWorkersError(err?.message ?? String(err)),
    )
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = subscribeUnavailability(db, setUnavailDocs)
    return () => unsub()
  }, [])

  const sortedWorkers = useMemo(
    () =>
      [...(workers ?? [])].sort(
        (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
      ),
    [workers],
  )
  const activeWorkers = useMemo(
    () => sortedWorkers.filter((w) => w.active !== false),
    [sortedWorkers],
  )
  const workerNameById = useMemo(() => {
    const m = new Map()
    for (const w of workers ?? []) m.set(w.id, fullName(w))
    return m
  }, [workers])

  // Group each worker's absences together (by name), then by schedule text.
  const sortedUnavail = useMemo(
    () =>
      [...unavailDocs].sort((a, b) => {
        const na = workerNameById.get(a.workerId) ?? ''
        const nb = workerNameById.get(b.workerId) ?? ''
        return na.localeCompare(nb) || describeSchedule(a).localeCompare(describeSchedule(b))
      }),
    [unavailDocs, workerNameById],
  )

  if (workersError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <p className="text-sm font-semibold text-red-800">Could not load the worker roster.</p>
        <p className="mt-1 break-words text-sm text-red-700">{workersError}</p>
      </div>
    )
  }

  if (!workers) {
    return <p className="text-sm text-slate-500">Loading staff…</p>
  }

  return (
    <div className="space-y-6">
      {/* Section 1 — Staff Management */}
      <Card
        title="Staff Management"
        subtitle="Add advisors, edit EA level and program training, and deactivate anyone who leaves. Deactivated advisors stay in the record (their past assignments still count) but drop out of every pool."
      >
        <div className="space-y-3">
          {sortedWorkers.map((w) => (
            <WorkerRow
              key={w.id}
              worker={w}
              onSave={(next) => upsertWorker(db, next)}
              onToggleActive={(id, active) => setWorkerActive(db, id, active)}
            />
          ))}
        </div>
        <div className="mt-5 border-t border-slate-200 pt-5">
          <AddWorkerForm onAdd={(w) => upsertWorker(db, w)} />
        </div>
      </Card>

      {/* Section 2 — Unavailability Scheduler */}
      <Card
        title="Unavailability Scheduler"
        subtitle="Put an advisor out for a single day, a date range, or every occurrence of a weekday (WFH / PTO / special project / callout). All four remove them from the pool identically while active."
      >
        <SchedulerForm activeWorkers={activeWorkers} onAdd={(entry) => addUnavailability(db, entry)} />

        <div className="mt-6 border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Scheduled absences</h3>
          {sortedUnavail.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No absences scheduled.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {sortedUnavail.map((entry) => (
                <UnavailRow
                  key={entry.id}
                  entry={entry}
                  workerName={workerNameById.get(entry.workerId) ?? 'Unknown advisor'}
                  onDelete={(id) => deleteUnavailability(db, id)}
                />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

// Local Card, matching Assign.jsx's (title / subtitle header + padded body).
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

// src/lib/selection.js — the fairness engine.
//
// suggestWorker is the single most important function in the system. It is a
// PURE function: same inputs → same output, no Firebase, no clock, no I/O. All
// the operational state it needs (counts, who's pending/unavailable) is passed
// in, so it can be unit-tested exhaustively and reasoned about in isolation.
//
// Invariants enforced here (CLAUDE.md):
//   #3  Sort key is EXACTLY weeklyCount ASC → lastName ASC → firstName ASC.
//       The count is the GLOBAL per-worker weekly tally across ALL programs —
//       never filter the count by program.
//   #4  The pool must exclude pending workers (concurrency guard).
//   #5  EA3 is last resort — eligible only when no trained EA1/EA2 is available.
//   #7  WFH / supervisor-unavailable are fully skipped (passed in as exclusions).
//
// Spec amendment (multi-program cases): a client may apply for several programs
// in one visit. The clerk selects ALL of them and ONE advisor — trained in
// EVERY selected program — takes the whole case. Eligibility is therefore the
// INTERSECTION of each program's trained set. It is still one case → one
// assignment → +1 to the worker's GLOBAL weekly count (per case, never per
// program), so the sort key and the count are unchanged.

// Human-facing program labels, used in the "No staff available" message.
export const PROGRAM_LABELS = {
  snap: 'SNAP',
  tanf: 'TANF',
  mepd: 'MEPD',
  medicaid: 'Medicaid',
}

// weeklyCounts may be a Map or a plain object keyed by workerId. A worker absent
// from it counts as 0 (no assignments this week). Never throws on a missing id.
function countFor(weeklyCounts, workerId) {
  if (!weeklyCounts) return 0
  const raw =
    weeklyCounts instanceof Map ? weeklyCounts.get(workerId) : weeklyCounts[workerId]
  return typeof raw === 'number' ? raw : 0
}

/**
 * Suggest the fairest eligible worker for one or more programs, or report no
 * staff. A candidate must be trained in EVERY selected program (intersection).
 *
 * @param {object}   args
 * @param {Array}    args.workers   roster: { id, firstName, lastName, eaLevel, programs, active }
 * @param {Map|object} args.weeklyCounts  workerId -> GLOBAL weekly count (missing = 0)
 * @param {string[]} args.programs  one or more of 'snap' | 'tanf' | 'mepd' | 'medicaid'
 * @param {string[]} [args.pendingIds]              excluded (suggested, awaiting reply)
 * @param {string[]} [args.tempUnavailableIds]      excluded (clerk-set, 30-min)
 * @param {string[]} [args.supervisorUnavailableIds] excluded (WFH/PTO/special/callout)
 * @returns {{ok: true, worker: object} | {ok: false, message: string}}
 */
export function suggestWorker({
  workers,
  weeklyCounts,
  programs,
  pendingIds = [],
  tempUnavailableIds = [],
  supervisorUnavailableIds = [],
}) {
  // A case must name at least one program. An empty or malformed selection has
  // no meaningful pool — surface that distinctly from "no staff available".
  if (!Array.isArray(programs) || programs.length === 0) {
    return { ok: false, message: 'No program selected' }
  }

  // Human-facing label for the (possibly multi-program) case, e.g. "SNAP + MEPD".
  const label = programs.map((p) => PROGRAM_LABELS[p] ?? p).join(' + ')

  // One set of everyone who is out of the running, for any reason.
  const excluded = new Set([
    ...pendingIds,
    ...tempUnavailableIds,
    ...supervisorUnavailableIds,
  ])

  // Eligibility = active, not excluded, and trained in EVERY selected program.
  // The intersection narrows the pool: a worker missing even one of the chosen
  // programs cannot take the whole case.
  const candidates = (workers ?? []).filter(
    (w) =>
      w.active === true &&
      programs.every((p) => w.programs?.[p] === true) &&
      !excluded.has(w.id),
  )

  // #5 EA3 last resort: try EA1/EA2 first; only if that pool is empty do EA3
  // workers become eligible.
  let pool = candidates.filter((w) => w.eaLevel !== 3)
  if (pool.length === 0) pool = candidates

  if (pool.length === 0) {
    return { ok: false, message: `No staff available for ${label}` }
  }

  // #3 Selection key — copy then sort so we never mutate the caller's array.
  const sorted = [...pool].sort((a, b) => {
    const ca = countFor(weeklyCounts, a.id)
    const cb = countFor(weeklyCounts, b.id)
    if (ca !== cb) return ca - cb
    const byLast = a.lastName.localeCompare(b.lastName)
    if (byLast !== 0) return byLast
    return a.firstName.localeCompare(b.firstName)
  })

  return { ok: true, worker: sorted[0] }
}

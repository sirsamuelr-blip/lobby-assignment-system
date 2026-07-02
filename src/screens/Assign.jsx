import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../firebase'
import { getAllWorkers } from '../lib/workers'
import { getWeeklyCounts } from '../lib/counts'
import { createAssignment, reassignAssignment } from '../lib/assignments'
import { PROGRAM_LABELS, eligibleWorkers } from '../lib/selection'
import { formatTicket } from '../lib/tickets'
import {
  getPendingIds,
  getMyPendingClaim,
  claimWorker,
  releasePending,
  suggestAndClaim,
  PENDING_TTL_MS,
} from '../lib/pending'
import { getTempUnavailableIds, markTempUnavailable } from '../lib/unavailable'
import { getSupervisorUnavailableIds } from '../lib/supervisorUnavailability'

const PROGRAMS = ['snap', 'tanf', 'mepd', 'medicaid']

// Fixed staffing reasons for Mark-unavailable — one tap each. NEVER client data
// (invariant #1); "Other" is a short free-text staffing note, not a case field.
const PRESET_REASONS = ['Away from desk', 'Busy with a client', 'Left for the day']

// Human-readable list of the selected programs, in canonical order, for display
// inside the UI (e.g. "SNAP, MEPD"). The "No staff" message is joined with " + "
// by selection.js itself.
const joinLabels = (programs) => programs.map((p) => PROGRAM_LABELS[p]).join(', ')

// Base Teams message. The clerk appends the EWMS case number (a separate input)
// before sending — that reference is clipboard-only and is NEVER stored.
const messageFor = (firstName) =>
  `${firstName}, you have been assigned the next lobby case. Please advise on availability.`

// Cosmetic "Xm Ys left" for the pending countdown. Clamped at zero.
const formatRemaining = (ms) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m ${String(s).padStart(2, '0')}s left`
}

// Read a worker's weekly count from whatever getWeeklyCounts returns (a Map) —
// tolerant of a plain object too. Missing worker → 0.
const weeklyCountOf = (counts, id) =>
  counts instanceof Map ? counts.get(id) ?? 0 : counts?.[id] ?? 0

export default function Assign({ clerkId }) {
  // Roster is static for a session; load once.
  const [workers, setWorkers] = useState(null)
  const [rosterError, setRosterError] = useState('')

  // Current case — the clerk may select SEVERAL programs (one advisor trained in
  // all of them takes the whole case). Held as a Set; we derive a canonical
  // ordered array for display and for the pure functions.
  const [selectedPrograms, setSelectedPrograms] = useState(() => new Set())
  const [suggestion, setSuggestion] = useState(null) // {ok:true,worker} | {ok:false,message}
  const [busy, setBusy] = useState(false) // suggesting or assigning
  const [actionError, setActionError] = useState('')

  // This clerk's single in-progress claim (one client at a time per clerk). The
  // worker is already Pending in Firestore; expiresAt is client-computed for the
  // cosmetic countdown (≈ the server-written value; correctness lives server-side).
  const [activeClaim, setActiveClaim] = useState(null) // { workerId, expiresAt } | null

  // Teams message composer
  const [messageText, setMessageText] = useState('')
  const [caseNumber, setCaseNumber] = useState('')
  // Assign-after-copy gate: Assign stays disabled until the EXACT message last
  // shown has been copied. Any change to the worker, the program selection, the
  // message text, or the case number re-closes the gate (resets this to false).
  const [copied, setCopied] = useState(false)

  // Confirmation of the last completed assignment
  const [lastAssigned, setLastAssigned] = useState(null) // {ticket, assignmentId, workerName, fromWorkerId, programs, programsLabel, manual, reassigned}

  // Reassign (Phase 6b) — corrects a wrong-worker Assign on the green confirmation
  // card. Fully SEPARATE from the suggestion machinery: it never touches
  // activeClaim / suggestion / runningRef / suggestSeq / rerunRef. A completed case
  // has no active claim, and a reassign re-attributes the EXISTING assignment doc
  // rather than making a new claim, so its busy/picker/error state lives on its own.
  const [reassigning, setReassigning] = useState(false)
  const [reassignOptions, setReassignOptions] = useState(null) // null=loading | [] | [{worker,count}]
  const [reassignBusy, setReassignBusy] = useState(false)
  const [reassignError, setReassignError] = useState('')
  // Reassign's OWN generation guard — deliberately separate from the suggestion
  // machinery's suggestSeq (guardrail: keep reassign fully independent). Bumped
  // whenever the reassign context changes (a new open, a new/cleared card), so a
  // slow openReassign read for a PRIOR card can't overwrite the current card's
  // picker with advisors ineligible for the current case.
  const reassignSeq = useRef(0)

  // Mark-unavailable reason picker (collapsed by default). `otherOpen` reveals the
  // free-text staffing note; `otherReason` holds it. All three reset whenever the
  // suggested worker changes (see the [suggestion] effect below).
  const [markingUnavailable, setMarkingUnavailable] = useState(false)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherReason, setOtherReason] = useState('')

  // Manual-override picker (collapsed by default; mirrors the reason picker).
  // `overrideOptions` is null while its fresh eligibility read is in flight, then
  // an array of { worker, count } rows to choose from. Both reset when the
  // suggestion changes (see the [suggestion] effect below).
  const [overriding, setOverriding] = useState(false)
  const [overrideOptions, setOverrideOptions] = useState(null)

  // ~1s clock so the pending countdown moves and an untouched claim can auto
  // re-suggest at expiry. Cosmetic only — the real release is the server-side
  // expiresAt query-time filter.
  const [nowTick, setNowTick] = useState(() => Date.now())

  // suggestSeq: bumped whenever the selection is CLEARED, to invalidate any
  // in-flight resuggest so it neither commits stale UI nor leaks a fresh claim.
  const suggestSeq = useRef(0)
  // runningRef + rerunRef serialize resuggest: only one runs at a time, and a
  // selection change mid-flight is queued to run right after. This guarantees two
  // overlapping resuggests can never both hold a claim.
  const runningRef = useRef(false)
  const rerunRef = useRef(null)
  // Mirror of activeClaim so effects read the latest value without taking it as a
  // dependency.
  const activeClaimRef = useRef(null)
  // The expiresAt we last auto-re-suggested for, so the cosmetic timer fires
  // exactly ONCE per claim expiry — not every ~1s tick. A successful re-suggest
  // mints a fresh expiresAt (re-arming it); a failing one keeps the same expiresAt
  // (so we don't storm re-suggests during, say, a network outage).
  const expiryHandledRef = useRef(null)
  // Reload recovery: run the claim reconstruction exactly once, and suppress the
  // single resuggest that restoring the selection would otherwise fire (we want
  // the EXACT reclaimed worker, not a fresh pick against possibly-shifted counts).
  const reconstructedRef = useRef(false)
  const skipNextResuggestRef = useRef(false)
  // Whether the CURRENT suggestion is a manual override (a clerk-chosen worker)
  // rather than the system's automatic pick. Read at Assign time to flag the
  // assignment doc manual:true. A ref (not state) so it can't lag the claim it
  // describes: every AUTO commit resets it to false; only overrideTo sets it true.
  const manualRef = useRef(false)

  // Set the active claim and its mirror ref in the SAME statement, so the ref is
  // synchronously authoritative — no effect-tick lag. The queued rerun fired from
  // resuggest's finally reads activeClaimRef.current before React commits, so it
  // must see the latest claim (not the value from one commit ago) to release the
  // intermediate worker's pending doc.
  const setClaim = useCallback((next) => {
    activeClaimRef.current = next // synchronously authoritative — no effect-tick lag
    setActiveClaim(next)
  }, [])

  // Canonical-ordered list + a stable key the suggest effect can depend on.
  const programsList = PROGRAMS.filter((p) => selectedPrograms.has(p))
  const programsKey = programsList.join(',')

  // Redundant safety net: setClaim already maintains activeClaimRef synchronously;
  // this effect only re-affirms it after each commit.
  useEffect(() => {
    activeClaimRef.current = activeClaim
  }, [activeClaim])

  useEffect(() => {
    let cancelled = false
    getAllWorkers(db)
      .then((ws) => !cancelled && setWorkers(ws))
      .catch((err) => !cancelled && setRosterError(err?.message ?? String(err)))
    return () => {
      cancelled = true
    }
  }, [])

  // Reload recovery: a reload wipes React state but the pending doc persists in
  // Firestore, so this clerk (identified by their signed-in Firebase Auth uid,
  // which Auth persists across reloads) restores their own unexpired claim rather
  // than orphaning the worker for 10 minutes. Runs once, and restores the EXACT
  // worker without re-deriving (counts may have moved and the clerk may already
  // have messaged this person).
  useEffect(() => {
    if (!workers || reconstructedRef.current) return
    reconstructedRef.current = true
    let cancelled = false
    getMyPendingClaim(db, clerkId)
      .then((claim) => {
        if (cancelled || !claim) return
        const worker = workers.find((w) => w.id === claim.workerId)
        if (!worker) return
        // Suppress the one resuggest the selection change would otherwise trigger.
        skipNextResuggestRef.current = true
        // The pending doc doesn't record manual-ness, so treat a restored claim as
        // an automatic pick (default false) — worst case an override loses its flag
        // across a reload, never the reverse.
        manualRef.current = false
        setSelectedPrograms(new Set(claim.programs))
        setClaim({ workerId: claim.workerId, expiresAt: claim.expiresAtMs })
        setSuggestion({ ok: true, worker })
      })
      .catch(() => {}) // best-effort; on failure the claim just expires via query-time
    return () => {
      cancelled = true
    }
  }, [workers])

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // NOTE: there is deliberately NO unmount-release effect. Deleting the pending
  // doc was never the release mechanism — the query-time `expiresAt > now` filter
  // is — and an unmount release fired spuriously on tab navigation (viewing the
  // Roster used to unmount this screen), dropping an in-progress claim the instant
  // the clerk peeked at another tab. Real release still happens on: empty-selection
  // abandon, re-suggest to a different worker, and the atomic delete inside
  // createAssignment. Anything else simply expires within 10 minutes.

  // Re-suggest whenever the (non-empty) program selection changes. An empty
  // selection clears the suggestion AND abandons any active claim.
  useEffect(() => {
    if (!workers) return
    if (programsList.length === 0) {
      // Invalidate any in-flight resuggest (so a slow claim for a prior selection
      // can't resurrect a suggestion/claim after we've gone empty) and cancel any
      // queued rerun.
      suggestSeq.current++
      rerunRef.current = null
      manualRef.current = false // no suggestion → not a manual one either
      const claim = activeClaimRef.current
      if (claim) {
        releasePending(db, claim.workerId)
        setClaim(null)
      }
      setSuggestion(null)
      setBusy(false)
      return
    }
    // Reload restore set the selection to match an already-held claim — skip the
    // resuggest it would trigger so we keep the exact reclaimed worker.
    if (skipNextResuggestRef.current) {
      skipNextResuggestRef.current = false
      return
    }
    resuggest(programsList)
    // programsKey captures the selection; resuggest/workers are stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programsKey, workers])

  // Keep the editable message in sync when the suggested worker changes, and
  // re-close the copy gate — copying only counts for the content on screen now.
  useEffect(() => {
    setCopied(false)
    // A new (or cleared) suggestion → collapse the reason picker AND the override
    // picker; they belonged to the previous worker.
    setMarkingUnavailable(false)
    setOtherOpen(false)
    setOtherReason('')
    setOverriding(false)
    setOverrideOptions(null)
    if (suggestion?.ok) setMessageText(messageFor(suggestion.worker.firstName))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion])

  // Cosmetic 10-min timer: when an untouched claim reaches 0, re-suggest the
  // still-open case (re-picks next-lowest — possibly the same person, whom
  // claimWorker reclaims via its own-clerk branch). The !runningRef guard avoids
  // firing during the re-suggest round-trip; expiryHandledRef ensures we fire
  // exactly once per distinct expiry (a failed re-suggest keeps the same
  // expiresAt, so we don't re-fire every tick).
  //
  // ALSO guard on !busy: while another action awaits (assign's transaction, or
  // markUnavailable's markTempUnavailable write), a competing auto-expiry
  // resuggest would run with runningRef still false and get QUEUED behind that
  // action's own resuggest — and a queued rerun reads a stale prevClaim (the
  // activeClaimRef sync lags setActiveClaim by a passive-effect tick), which can
  // orphan a just-made pending claim. Deferring auto-expiry until idle avoids that
  // re-entrancy entirely; the fire simply happens on the next 1s tick once busy
  // clears (well within the cosmetic window). Never affects a count (still just a
  // re-suggest) — this is purely about not leaking a pending liveState doc.
  useEffect(() => {
    if (!activeClaim || programsList.length === 0) return
    if (
      nowTick >= activeClaim.expiresAt &&
      !busy &&
      !runningRef.current &&
      expiryHandledRef.current !== activeClaim.expiresAt
    ) {
      expiryHandledRef.current = activeClaim.expiresAt
      resuggest(programsList)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTick, activeClaim, programsKey, busy])

  function toggleProgram(p) {
    setActionError('')
    setLastAssigned(null)
    // The confirmation card (and its reassign picker) belonged to the completed
    // case — collapse and clear it alongside lastAssigned, and invalidate any
    // in-flight openReassign read so it can't repopulate the picker for a stale card.
    reassignSeq.current++
    setReassigning(false)
    setReassignOptions(null)
    setReassignError('')
    setCopied(false) // the program selection changed → re-close the gate
    setSelectedPrograms((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  // Claim-aware re-suggest. Derives fresh server counts + pending exclusions,
  // then picks AND claims the fairest available worker (going them Pending). The
  // claim is the concurrency guard: two clerks can never both hold the same
  // person. Serialized via runningRef so overlapping runs can't both claim.
  async function resuggest(progs) {
    if (!workers) return
    if (runningRef.current) {
      // One already in flight — remember the latest selection and let that run
      // pick it up when it finishes (below).
      rerunRef.current = progs
      return
    }
    runningRef.current = true
    const seq = ++suggestSeq.current
    const prevClaim = activeClaimRef.current
    setBusy(true)
    setActionError('')
    // Drop any stale suggestion up front so the card never shows a prior worker
    // against the new selection's labels while the fresh reads are in flight.
    setSuggestion(null)
    try {
      // The roster is now editable live from the Admin page, so it is a volatile
      // pool input like counts/pending — read it fresh here too, so a worker
      // added, retrained, or deactivated moments ago is reflected in THIS pick.
      // (The one-time state `workers` still backs render + reload-recovery.)
      const [freshWorkers, weeklyCounts, pendingIds, tempUnavailableIds, supervisorUnavailableIds] =
        await Promise.all([
          getAllWorkers(db),
          getWeeklyCounts(db),
          getPendingIds(db),
          getTempUnavailableIds(db),
          getSupervisorUnavailableIds(db),
        ])
      // Exclude everyone pending EXCEPT our own active claim, so a re-suggest can
      // land back on the same person (claimWorker then reclaims via own-clerk).
      const excludeForSuggest = prevClaim
        ? pendingIds.filter((id) => id !== prevClaim.workerId)
        : pendingIds
      const r = await suggestAndClaim({
        workers: freshWorkers,
        weeklyCounts,
        pendingIds: excludeForSuggest,
        // Temp-unavailable is a SEPARATE, global exclusion (not filtered against
        // our own claim): a worker we just marked here must NOT be re-suggested
        // for this same case — this fresh server read is exactly what excludes them.
        tempUnavailableIds,
        // Supervisor-unavailable (WFH/PTO/special/callout) is likewise a global,
        // date-based exclusion — never filtered against our own claim.
        supervisorUnavailableIds,
        programs: progs,
        clerkId,
        claimFn: (a) => claimWorker(db, a),
      })

      if (seq !== suggestSeq.current) {
        // Superseded (selection cleared mid-flight). Don't commit; release any
        // claim we just made so it isn't orphaned. The clearing branch already
        // released the previous claim.
        if (r.ok) releasePending(db, r.worker.id)
        return
      }

      // Either branch is an AUTOMATIC pick — clear the manual flag (only an
      // explicit Override sets it true).
      manualRef.current = false
      if (r.ok) {
        // Moved to a different worker → release the one we were holding.
        if (prevClaim && prevClaim.workerId !== r.worker.id) {
          releasePending(db, prevClaim.workerId)
        }
        setClaim({
          workerId: r.worker.id,
          expiresAt: Date.now() + PENDING_TTL_MS,
        })
        setSuggestion({ ok: true, worker: r.worker })
      } else {
        // No one available — drop any claim we were holding.
        if (prevClaim) releasePending(db, prevClaim.workerId)
        setClaim(null)
        setSuggestion(r)
      }
    } catch (err) {
      if (seq === suggestSeq.current) setActionError(err?.message ?? String(err))
    } finally {
      if (seq === suggestSeq.current) setBusy(false)
      runningRef.current = false
      // A selection change arrived while we ran → serve it now.
      const queued = rerunRef.current
      rerunRef.current = null
      if (queued && queued.length > 0) resuggest(queued)
    }
  }

  async function assign() {
    const claim = activeClaimRef.current
    // The gate: a real suggestion, an active claim, the exact message copied, and
    // not mid-flight.
    if (busy || programsList.length === 0 || !suggestion?.ok || !copied || !claim) return
    const worker = suggestion.worker
    const progsSnapshot = programsList
    const programsLabel = joinLabels(progsSnapshot)
    // Snapshot the manual flag for THIS assignment before any reset can move it.
    const manual = manualRef.current
    setBusy(true)
    setActionError('')
    let needsResuggest = false
    try {
      const { ticket, id } = await createAssignment(db, {
        programs: progsSnapshot,
        workerId: worker.id,
        clerkId,
        manual,
      })
      // Confirm, then clear for the next case (one client at a time per clerk).
      // The transaction already deleted the pending doc, so just drop the claim.
      // Carry the doc id + who now holds it + the programs, so the confirmation
      // card's Reassign can re-attribute THIS exact assignment (Phase 6b).
      setLastAssigned({
        ticket,
        assignmentId: id,
        workerName: `${worker.firstName} ${worker.lastName}`,
        fromWorkerId: worker.id,
        programs: progsSnapshot,
        programsLabel,
        manual,
        reassigned: false,
      })
      // The fresh card starts with its reassign picker collapsed; invalidate any
      // in-flight openReassign read from the prior card.
      reassignSeq.current++
      setReassigning(false)
      setReassignOptions(null)
      setReassignError('')
      manualRef.current = false // cleared for the next (automatic) case
      setClaim(null)
      setSelectedPrograms(new Set())
      setSuggestion(null)
      setMessageText('')
      setCaseNumber('')
      setCopied(false)
      // Next program selection re-derives counts from the server, which now
      // reflects this assignment (the count++ is implicit in the new doc).
    } catch (err) {
      const msg = err?.message ?? String(err)
      if (msg.includes('Claim expired')) {
        // Our claim lapsed or was reassigned between suggest and Assign. Re-close
        // the gate and re-pick for the still-open selection rather than surfacing
        // the raw error.
        needsResuggest = true
        setCopied(false)
      } else {
        setActionError(msg)
      }
    } finally {
      setBusy(false)
    }
    if (needsResuggest) resuggest(progsSnapshot)
  }

  // Mark the currently-suggested worker temp-unavailable (30 min) and immediately
  // re-suggest the still-open case. Order matters:
  //   1. AWAIT the temp write first, so resuggest's fresh getTempUnavailableIds
  //      server read is guaranteed to exclude this worker → next-lowest instantly.
  //   2. releasePending (best-effort) drops their pending doc; the temp doc is what
  //      actually keeps them out of the pool for 30 min.
  //   3. Clear our claim, then resuggest.
  // This NEVER writes an assignment, so no count changes (invariant #2). The marked
  // worker re-enters the pool purely via the query-time `until > now` filter — no
  // per-case timer needed.
  async function markUnavailable(reason) {
    const claim = activeClaimRef.current
    if (busy || programsList.length === 0 || !suggestion?.ok || !claim) return
    const worker = suggestion.worker
    const progsSnapshot = programsList
    setBusy(true)
    setActionError('')
    try {
      await markTempUnavailable(db, { workerId: worker.id, reason })
      releasePending(db, worker.id)
      setClaim(null)
      setMarkingUnavailable(false)
      setOtherOpen(false)
      setOtherReason('')
      // resuggest re-derives busy itself; its fresh temp read excludes this worker.
      resuggest(progsSnapshot)
    } catch (err) {
      // The temp write failed → nothing was released or re-suggested; surface it
      // and clear busy so the clerk can retry.
      setActionError(err?.message ?? String(err))
      setBusy(false)
    }
  }

  // Open (or refresh) the Override picker: read the SAME fresh pool inputs as
  // resuggest, then list EVERY eligible worker (all EA levels) for the still-open
  // case. Pending is excluded EXCEPT our own current claim, so the currently
  // suggested worker and every other free eligible advisor appear. No claim is
  // made here — just building the menu. `overrideOptions` stays null while in
  // flight (renders a loading line).
  async function openOverride() {
    const claim = activeClaimRef.current
    const progsSnapshot = programsList
    if (progsSnapshot.length === 0) return
    setOverrideOptions(null)
    setActionError('')
    try {
      const [freshWorkers, weeklyCounts, pendingIds, tempUnavailableIds, supervisorUnavailableIds] =
        await Promise.all([
          getAllWorkers(db),
          getWeeklyCounts(db),
          getPendingIds(db),
          getTempUnavailableIds(db),
          getSupervisorUnavailableIds(db),
        ])
      // Keep our own claim in the list; exclude everyone else's pending claim.
      const excludePending = pendingIds.filter((id) => id !== claim?.workerId)
      const list = eligibleWorkers({
        workers: freshWorkers,
        weeklyCounts,
        programs: progsSnapshot,
        pendingIds: excludePending,
        tempUnavailableIds,
        supervisorUnavailableIds,
      })
      setOverrideOptions(list.map((w) => ({ worker: w, count: weeklyCountOf(weeklyCounts, w.id) })))
    } catch (err) {
      setActionError(err?.message ?? String(err))
      setOverrideOptions([]) // render the empty state rather than a stuck spinner
    }
  }

  function toggleOverride() {
    if (busy) return
    if (overriding) {
      setOverriding(false)
      return
    }
    setOverriding(true)
    openOverride()
  }

  // Commit a manual override to `worker`: claim them (the SAME concurrency guard as
  // an automatic pick), release the previous claim, and make them the active
  // suggestion — flagged manual. This writes NO count; the +1 happens only when the
  // clerk re-copies the message and hits Assign (createAssignment), exactly like an
  // automatic pick.
  //
  // Serialized EXACTLY like resuggest (runningRef + suggestSeq + rerunRef), because
  // program buttons stay enabled during busy: without this, a program toggle fired
  // mid-claim would run a concurrent resuggest that claims a SECOND worker and moves
  // activeClaimRef — and this function, holding a stale captured claim, would then
  // release the wrong worker and orphan the other's pending doc. Holding runningRef
  // blocks that concurrent resuggest; the seq check abandons cleanly if the
  // selection is CLEARED mid-claim; and any queued selection CHANGE is served in the
  // finally (which re-derives for the new selection, so a manual pick can never
  // stick against a program set it wasn't chosen for).
  async function overrideTo(worker) {
    if (busy || runningRef.current) return
    const claim = activeClaimRef.current
    // Choosing the already-suggested worker is a no-op — just close the picker.
    if (claim && worker.id === claim.workerId) {
      setOverriding(false)
      return
    }
    runningRef.current = true
    const seq = ++suggestSeq.current
    const progsSnapshot = programsList
    setBusy(true)
    setActionError('')
    try {
      const { claimed } = await claimWorker(db, {
        workerId: worker.id,
        clerkId,
        programs: progsSnapshot,
      })
      if (seq !== suggestSeq.current) {
        // Superseded (selection cleared mid-claim). Release what we grabbed and
        // bail; the clearing branch already dropped the previous claim.
        if (claimed) releasePending(db, worker.id)
        return
      }
      if (!claimed) {
        // Another clerk claimed them between listing and picking — re-list so the
        // taken worker drops off, and let the clerk choose again. Our previous
        // claim is untouched.
        setActionError('That advisor was just taken — pick another.')
        openOverride()
        return
      }
      // Won the claim → release the worker we were holding (if different) and make
      // this the active, MANUAL suggestion.
      if (claim && claim.workerId !== worker.id) releasePending(db, claim.workerId)
      manualRef.current = true
      setClaim({ workerId: worker.id, expiresAt: Date.now() + PENDING_TTL_MS })
      // The [suggestion] effect re-syncs the Teams message and re-closes the copy
      // gate, so the clerk re-copies and Assigns this worker normally → manual:true.
      setSuggestion({ ok: true, worker })
      setOverriding(false)
      setOverrideOptions(null)
    } catch (err) {
      if (seq === suggestSeq.current) setActionError(err?.message ?? String(err))
    } finally {
      if (seq === suggestSeq.current) setBusy(false)
      runningRef.current = false
      // A selection change queued while we claimed → serve it now: it re-derives
      // for the new selection, releasing us if we moved and clearing manualRef.
      const queued = rerunRef.current
      rerunRef.current = null
      if (queued && queued.length > 0) resuggest(queued)
    }
  }

  // --- Reassign (Phase 6b) -------------------------------------------------
  // Correct a wrong-worker Assign FROM the green confirmation card. This is fully
  // separate from the suggestion flow above: no activeClaim, no suggestion, no
  // runningRef/suggestSeq/rerunRef — a completed case has none of those, and the
  // reassign re-attributes the EXISTING assignment doc rather than making a claim.

  // Open the Reassign picker: read the SAME fresh pool inputs as the suggestion
  // engine, list every eligible advisor for the just-assigned case, then DROP the
  // current holder (you reassign to someone else). Makes no claim and writes
  // nothing — just builds the menu. `reassignOptions` stays null while in flight.
  async function openReassign() {
    if (!lastAssigned) return
    // Claim this generation up front; a newer open (or a card change) bumps it and
    // makes our late-resolving read a no-op below.
    const seq = ++reassignSeq.current
    const programs = lastAssigned.programs
    const currentHolder = lastAssigned.fromWorkerId
    setReassignOptions(null)
    setReassignError('')
    try {
      const [freshWorkers, weeklyCounts, pendingIds, tempUnavailableIds, supervisorUnavailableIds] =
        await Promise.all([
          getAllWorkers(db),
          getWeeklyCounts(db),
          getPendingIds(db),
          getTempUnavailableIds(db),
          getSupervisorUnavailableIds(db),
        ])
      if (seq !== reassignSeq.current) return // superseded by a newer open / a new case
      const list = eligibleWorkers({
        workers: freshWorkers,
        weeklyCounts,
        programs,
        pendingIds,
        tempUnavailableIds,
        supervisorUnavailableIds,
      })
        // You reassign to a DIFFERENT advisor — drop whoever currently holds it.
        .filter((w) => w.id !== currentHolder)
      setReassignOptions(list.map((w) => ({ worker: w, count: weeklyCountOf(weeklyCounts, w.id) })))
    } catch (err) {
      if (seq !== reassignSeq.current) return
      setReassignError(err?.message ?? String(err))
      setReassignOptions([]) // render the empty state rather than a stuck spinner
    }
  }

  function toggleReassign() {
    if (reassignBusy) return
    if (reassigning) {
      reassignSeq.current++ // invalidate any in-flight open read on close
      setReassigning(false)
      return
    }
    setReassigning(true)
    openReassign()
  }

  // Commit the reassign to `worker`: re-attribute the EXISTING assignment doc from
  // the current holder to them. Writes NO new count and NO ticket — the derived
  // weekly count shifts net-zero (old −1, new +1) purely because it is keyed on
  // workerId (invariant #8). On success fromWorkerId becomes this worker, so a
  // SECOND reassign chains from here (reassignedFrom then records this worker).
  async function reassignTo(worker) {
    if (reassignBusy || !lastAssigned) return
    setReassignBusy(true)
    setReassignError('')
    try {
      await reassignAssignment(db, {
        assignmentId: lastAssigned.assignmentId,
        fromWorkerId: lastAssigned.fromWorkerId,
        toWorkerId: worker.id,
      })
      // Guard against a mid-flight card change: if a program button was tapped
      // while this updateDoc was in flight, lastAssigned was cleared and a new case
      // is underway — do NOT resurrect a phantom card ({...null}) over it. The
      // reassign write already committed durably regardless of the UI.
      setLastAssigned((prev) =>
        prev
          ? {
              ...prev,
              workerName: `${worker.firstName} ${worker.lastName}`,
              fromWorkerId: worker.id,
              manual: true,
              reassigned: true,
            }
          : prev,
      )
      setReassigning(false)
      setReassignOptions(null)
    } catch (err) {
      setReassignError(err?.message ?? String(err))
    } finally {
      setReassignBusy(false)
    }
  }

  async function copyMessage() {
    const composed = caseNumber.trim()
      ? `${messageText}\n\nEWMS Case #: ${caseNumber.trim()}`
      : messageText
    try {
      await navigator.clipboard.writeText(composed)
      setCopied(true) // opens the Assign gate for this exact content
    } catch {
      // Insecure context / older browser: the async Clipboard API is unavailable.
      // The clerk copies manually (Ctrl+C), so still unlock the Assign gate.
      setActionError('Could not copy automatically — select the message and press Ctrl+C.')
      setCopied(true)
    }
  }

  // --- Render --------------------------------------------------------------

  if (rosterError) {
    return (
      <Card>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-semibold text-red-800">Could not load the worker roster.</p>
          <p className="mt-1 break-words text-sm text-red-700">{rosterError}</p>
        </div>
      </Card>
    )
  }

  const hasSelection = programsList.length > 0
  // One-at-a-time, so this is 0 or 1 row: show it once we know the worker.
  const showPending = activeClaim && suggestion?.ok
  const remainingMs = activeClaim ? activeClaim.expiresAt - nowTick : 0

  return (
    <div className="space-y-6">
      {lastAssigned && (
        <div
          className="rounded-lg border border-green-200 bg-green-50 px-5 py-4"
          aria-live="polite"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-green-800">
                Assigned · Ticket {formatTicket(lastAssigned.ticket)}
                {lastAssigned.manual && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 align-middle text-xs font-semibold text-blue-800">
                    Manual
                  </span>
                )}
                {lastAssigned.reassigned && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 align-middle text-xs font-semibold text-amber-800">
                    Reassigned
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-green-700">
                {lastAssigned.reassigned ? (
                  <>
                    <span className="font-medium">{lastAssigned.workerName}</span> now holds this{' '}
                    {lastAssigned.programsLabel} case (reassigned) — their weekly count +1, the
                    previous advisor −1. Select a program to assign the next case.
                  </>
                ) : (
                  <>
                    <span className="font-medium">{lastAssigned.workerName}</span> took the next{' '}
                    {lastAssigned.programsLabel} case. Their weekly count is now +1. Select a program
                    to assign the next case.
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleReassign}
              disabled={reassignBusy}
              aria-expanded={reassigning}
              className="inline-flex shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reassign
            </button>
          </div>

          {/* Reassign picker — re-attributes THIS assignment to a different eligible
              advisor. Writes no new count and no ticket; the derived weekly count
              shifts net-zero (invariant #8). Fully separate from the suggestion
              machinery; rendered only while the card exists and the picker is open. */}
          {reassigning && (
            <div className="mt-4 rounded-md border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-semibold text-slate-900">
                Reassign — correct the assigned advisor
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Re-attributes this case to a different eligible advisor — no new ticket, same case.
                The one you pick gains +1 this week and the current advisor drops −1 (net-zero).
                Flagged as a manual correction.
              </p>
              {reassignError && (
                <p className="mt-3 break-words text-sm text-red-700">{reassignError}</p>
              )}
              {reassignOptions === null ? (
                <p className="mt-3 text-sm text-slate-500">Loading eligible advisors…</p>
              ) : reassignOptions.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600">
                  No other eligible advisor to reassign to.
                </p>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-2">
                  {reassignOptions.map(({ worker, count }) => (
                    <button
                      key={worker.id}
                      type="button"
                      onClick={() => reassignTo(worker)}
                      disabled={reassignBusy}
                      className="flex items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-4 py-3 text-left shadow-sm transition hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                          {worker.firstName[0]}
                          {worker.lastName[0]}
                        </span>
                        <span>
                          <span className="block text-sm font-semibold text-slate-900">
                            {worker.firstName} {worker.lastName}
                          </span>
                          <span className="mt-0.5 block text-xs text-slate-500">
                            EA Level {worker.eaLevel} · {count} this week
                          </span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 1 — program(s) */}
      <Card
        title="1 · Select program(s)"
        subtitle="Choose every program this client is applying for. One advisor trained in all of them takes the whole case."
      >
        {!workers ? (
          <p className="text-sm text-slate-500">Loading roster…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PROGRAMS.map((p) => {
              const active = selectedPrograms.has(p)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleProgram(p)}
                  aria-pressed={active}
                  className={[
                    'rounded-lg border px-4 py-5 text-base font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
                    active
                      ? 'border-blue-700 bg-blue-700 text-white'
                      : 'border-slate-300 bg-white text-slate-800 hover:border-blue-400 hover:bg-blue-50',
                  ].join(' ')}
                >
                  {PROGRAM_LABELS[p]}
                </button>
              )
            })}
          </div>
        )}
      </Card>

      {/* Step 2 — suggestion */}
      {hasSelection && (
        <Card
          title="2 · Suggested worker"
          subtitle="Lowest weekly count, trained in every selected program. Alphabetical breaks ties."
        >
          {busy && !suggestion && <p className="text-sm text-slate-500">Finding the fairest worker…</p>}

          {suggestion?.ok && (
            <div className="space-y-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-green-100 text-lg font-bold text-green-800">
                    {suggestion.worker.firstName[0]}
                    {suggestion.worker.lastName[0]}
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-slate-900">
                      {suggestion.worker.firstName} {suggestion.worker.lastName}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500">
                      EA Level {suggestion.worker.eaLevel} · eligible for {joinLabels(programsList)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={assign}
                      disabled={busy || !copied || !activeClaim}
                      className="inline-flex items-center justify-center gap-2 rounded-md bg-green-700 px-8 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-green-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy && (
                        <span
                          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                          aria-hidden="true"
                        />
                      )}
                      {busy ? 'Assigning…' : 'Assign'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMarkingUnavailable((v) => !v)}
                      disabled={!suggestion?.ok || !activeClaim || busy}
                      aria-expanded={markingUnavailable}
                      className="inline-flex items-center justify-center rounded-md border border-amber-300 bg-white px-6 py-4 text-base font-semibold text-amber-800 shadow-sm transition hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Mark unavailable
                    </button>
                    <button
                      type="button"
                      onClick={toggleOverride}
                      disabled={!suggestion?.ok || busy}
                      aria-expanded={overriding}
                      className="inline-flex items-center justify-center rounded-md border border-blue-300 bg-white px-6 py-4 text-base font-semibold text-blue-800 shadow-sm transition hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Override
                    </button>
                  </div>
                  {!copied && (
                    <p className="text-xs text-slate-500">Copy the Teams message below and send it to the Advisor to enable Assign.</p>
                  )}
                </div>
              </div>

              {/* Reason picker — one tap per staffing reason, then instant
                  re-suggest. Fixed reasons only; "Other" is a short staffing note,
                  never client information (invariant #1). */}
              {markingUnavailable && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4">
                  <p className="text-sm font-semibold text-amber-900">
                    Why is {suggestion.worker.firstName} unavailable?
                  </p>
                  <p className="mt-0.5 text-xs text-amber-700">
                    Staffing reason only — never client information. Held out of the pool for 30 minutes,
                    then auto-returns. The next-lowest worker is suggested immediately.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {PRESET_REASONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => markUnavailable(r)}
                        disabled={busy}
                        className="rounded-md border border-amber-300 bg-white px-4 py-3 text-sm font-semibold text-amber-900 shadow-sm transition hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {r}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setOtherOpen(true)}
                      disabled={busy}
                      aria-pressed={otherOpen}
                      className={[
                        'rounded-md border px-4 py-3 text-sm font-semibold shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                        otherOpen
                          ? 'border-amber-500 bg-amber-100 text-amber-900'
                          : 'border-amber-300 bg-white text-amber-900 hover:bg-amber-100',
                      ].join(' ')}
                    >
                      Other
                    </button>
                  </div>
                  {otherOpen && (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={otherReason}
                        onChange={(e) => setOtherReason(e.target.value)}
                        placeholder="Reason (staffing only — no client info)"
                        className="flex-1 rounded-md border border-amber-300 px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                      <button
                        type="button"
                        onClick={() => markUnavailable(otherReason.trim() || 'Other')}
                        disabled={busy}
                        className="inline-flex items-center justify-center rounded-md bg-amber-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Confirm unavailable
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Override picker — every eligible advisor (all EA levels) for the
                  still-open case, fairest first. Picking one claims them (the same
                  concurrency guard) and makes them the suggested worker; the clerk
                  then re-copies and Assigns normally → the doc is flagged manual.
                  No count is written here. */}
              {overriding && (
                <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-4">
                  <p className="text-sm font-semibold text-blue-900">
                    Override — choose a different advisor
                  </p>
                  <p className="mt-0.5 text-xs text-blue-700">
                    Manual staffing choice. The one you pick is held Pending; re-copy the message and
                    Assign as usual. Their weekly count still goes up by one on Assign — the
                    assignment is just flagged as a manual override.
                  </p>
                  {overrideOptions === null ? (
                    <p className="mt-3 text-sm text-slate-500">Loading eligible advisors…</p>
                  ) : overrideOptions.length === 0 ? (
                    <p className="mt-3 text-sm text-blue-800">
                      No other eligible advisor is free right now.
                    </p>
                  ) : (
                    <div className="mt-3 grid grid-cols-1 gap-2">
                      {overrideOptions.map(({ worker, count }) => {
                        const isCurrent = activeClaim?.workerId === worker.id
                        return (
                          <button
                            key={worker.id}
                            type="button"
                            onClick={() => overrideTo(worker)}
                            disabled={busy}
                            aria-current={isCurrent ? 'true' : undefined}
                            className={[
                              'flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                              isCurrent
                                ? 'border-blue-400 bg-blue-100'
                                : 'border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50',
                            ].join(' ')}
                          >
                            <span className="flex items-center gap-3">
                              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-xs font-bold text-slate-700 ring-1 ring-slate-200">
                                {worker.firstName[0]}
                                {worker.lastName[0]}
                              </span>
                              <span>
                                <span className="block text-sm font-semibold text-slate-900">
                                  {worker.firstName} {worker.lastName}
                                </span>
                                <span className="mt-0.5 block text-xs text-slate-500">
                                  EA Level {worker.eaLevel} · {count} this week
                                </span>
                              </span>
                            </span>
                            {isCurrent && (
                              <span className="shrink-0 rounded-full bg-blue-200 px-2.5 py-0.5 text-xs font-semibold text-blue-900">
                                Current
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {suggestion && !suggestion.ok && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-sm font-semibold text-amber-800">{suggestion.message}</p>
              <p className="mt-1 text-sm text-amber-700">
                No eligible, available worker is trained in every selected program right now.
              </p>
            </div>
          )}

          {actionError && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3">
              <p className="break-words text-sm text-red-700">{actionError}</p>
            </div>
          )}
        </Card>
      )}

      {/* Pending list (spec §8.1) — this clerk's current claim, held Pending with
          a live countdown. One client at a time, so 0 or 1 row. */}
      {showPending && (
        <Card
          title="Your pending suggestion"
          subtitle="This advisor is held Pending (out of everyone's pool) until you Assign, mark them unavailable, or the 10-minute window lapses."
        >
          <div className="flex items-center justify-between gap-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {suggestion.worker.firstName} {suggestion.worker.lastName}
              </p>
              <p className="mt-0.5 text-xs text-amber-700">{joinLabels(programsList)}</p>
            </div>
            <span className="shrink-0 rounded-full bg-amber-200 px-3 py-1 text-xs font-semibold text-amber-900 tabular-nums">
              {formatRemaining(remainingMs)}
            </span>
          </div>
        </Card>
      )}

      {/* Step 3 — Teams message */}
      {hasSelection && suggestion?.ok && (
        <Card
          title="3 · Teams message"
          subtitle="Copy this into Teams. Add the EWMS case number below — it is copied with the message but never stored."
        >
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Message
          </label>
          <textarea
            value={messageText}
            onChange={(e) => {
              setMessageText(e.target.value)
              setCopied(false) // edited content → re-close the gate
            }}
            rows={3}
            className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            EWMS case number <span className="font-normal normal-case text-slate-500">(clipboard only — not saved)</span>
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input
              type="text"
              value={caseNumber}
              onChange={(e) => {
                setCaseNumber(e.target.value)
                setCopied(false) // changed case number → re-close the gate
              }}
              placeholder="e.g. 1234567890"
              className="flex-1 rounded-md border border-slate-300 px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={copyMessage}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-700 px-8 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {copied ? 'Copied ✓' : 'Copy message'}
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}

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

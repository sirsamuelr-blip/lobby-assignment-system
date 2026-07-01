# Lobby Case Assignment System — Build Spec

A standalone tool for a Texas HHSC benefits office to fairly distribute lobby
case intake assignments so no single advisor gets drained. It is **independent**
— it connects to nothing (no EWMS, no TIERS), stores **no client PII**, and must
be usable on day one.

---

## 1. Purpose & core problem

Today, 3–4 advisors are "assigned" to lobby each day, but cases are pulled
voluntarily from EWMS. Nobody wants to pull them, so clients wait too long and
the same reliable people keep getting bugged. This tool removes the volunteering
step: the moment a clerk enters a case, the app names the fairest eligible
advisor to take it.

**Volume / hours context (not enforced by the app):** ~20–30 lobby cases/day,
peaking around lunch. Office stops accepting lobby tasks at 3:30pm unless the
client has a missed-interview notice. Time limits per task type (20 min
missing-info, 35 min redetermination, 40 min application) are background only —
they are **not** modeled in the app.

---

## 2. The fairness engine (the heart of it)

There is **no moving pointer / no literal alphabetical line**. Every assignment
builds a fresh candidate pool and picks the lowest-loaded eligible person.

**Selection algorithm — runs on every case entry and every re-suggest:**

```
suggestWorker(program):
  candidates = workers where:
      active == true
      trainedIn(program) == true
      NOT supervisorUnavailableToday(worker)   # WFH / PTO / special project / callout
      NOT tempUnavailable(worker)              # clerk-set, 30-min
      NOT pending(worker)                       # suggested, awaiting reply, 10-min window

  # EA3 is last resort
  pool = candidates where eaLevel != 3
  if pool is empty: pool = candidates          # only now are EA3 eligible

  if pool is empty: return "No staff available for {program}"

  sort pool by: weeklyCount ASC, then lastName ASC, then firstName ASC
  return pool[0]
```

**Key rules:**
- **Weekly count wins. Alphabetical breaks ties.** Weekly (not daily) is
  deliberate: the exhaustion pattern is the *same person pulling every day*,
  which only a weekly view catches.
- **Week rolls over Monday 00:00 (midnight).** Every worker's weekly count
  effectively resets to 0 for selection purposes at the start of Monday.
- **One global weekly count per worker**, across all programs — so total load is
  balanced regardless of which programs someone is trained in. (Note: this means
  a worker trained in a scarce program like MEPD will naturally receive fewer
  cases of other programs once their weekly count climbs. That's intended — it
  balances *total* load per person. If during the build this feels wrong, the
  alternative is per-program counts, but global is the right default for "don't
  drain any one person.")
- **Count only increments on a confirmed Assign** (including manual override
  assigns). Being suggested, being marked unavailable, or expiring do **not**
  increment.
- Because selection is count-based, the old "WFH resumes spot / callout goes to
  front" distinction is **gone** — there is no spot. A returner simply re-enters
  the pool against everyone's weekly totals. No special-casing needed.

---

## 3. Programs & training

- Programs: **SNAP, TANF, MEPD, Medicaid.** Task type (app / redet / missing-info)
  does **not** matter — only program.
- Each of the 22 advisors has a per-program training flag (a worker × program
  grid). A worker is only eligible for a case in a program they're cleared for.

---

## 4. Workers & roles

**Workers (the assignable pool): 22 advisors, EA levels 1–3.**
- EA3 are last resort — only eligible when no trained EA1/EA2 is available for
  that program.
- Workers do **not** log into the app. They receive Teams messages and reply;
  the clerk records the outcome.

**App users (login accounts): clerks + supervisors only.** Per-person logins via
Firebase Auth, role-gated:
- **Clerk:** enter case, view suggestion, Assign / mark unavailable / override,
  generate the Teams message.
- **Supervisor:** everything a clerk can do **plus** the admin/staff-management
  page.

(A supervisor or clerk is not necessarily in the 22-advisor worker pool — keep
the login accounts and the worker roster as separate concepts.)

---

## 5. Worker states

| State | Set by | Behavior | Auto-resolve |
|---|---|---|---|
| Available | — | In the candidate pool | — |
| Pending | system (on suggestion) | Removed from pool so no one else gets double-booked | Released back to pool after **10 min** if no action |
| Temporarily unavailable | clerk (live) | Skipped, with a reason recorded | Returns to pool after **30 min** |
| Unavailable (WFH / PTO / special project / callout) | supervisor/admin | Out of the pool while active | Per the schedule set on the admin page |

- **WFH = skipped entirely.** Lobby cases cannot be done remotely.
- Supervisor-set unavailability supports **single-day, date-range, and recurring**
  schedules (e.g., PTO range, recurring WFH every Tuesday, single-day callout).

---

## 6. The intake & assignment flow

1. Client walks in, gets/fills an application at a clerk window or the lobby room
   (or arrives with a missed-interview notice and skips the application).
2. Clerk takes the completed application or the notice, sends the client to a
   seat, and opens the app at their desktop.
3. Clerk **selects the program** (SNAP / TANF / MEPD / Medicaid).
4. App suggests the lowest-weekly-count eligible worker. That worker enters
   **Pending** (removed from the pool, 10-min timer starts).
5. App displays a **copy-paste** Teams message. Base template:
   > *"{Name}, you have been assigned the next lobby case. Please advise on
   > availability."*
   The clerk appends the **EWMS case number/name** to this message before
   sending — that's how the assignment links to EWMS while keeping all case data
   out of this app.
6. Worker replies in Teams. Clerk records the outcome:
   - **Available →** clerk hits **Assign**. Count increments, assignment is
     logged, pending clears.
   - **Unavailable →** clerk marks **temporarily unavailable** (+reason, 30-min).
     App **immediately** suggests the next-lowest eligible worker for the same
     still-open case.
7. **Manual override:** the clerk can ignore the suggestion and pick any eligible
   worker. The count still increments, and the log + UI clearly flag it as a
   manual assignment.
8. **One client assigned at a time per clerk.**

**Concurrency:** multiple clerks operate independently at different windows.
Because a suggested worker goes **Pending** (out of the pool) the instant they're
named — before they confirm — a second clerk entering a different case a moment
later will *not* be handed the same worker. This is the rule that prevents the
lowest-count person from being double/triple-booked during the lunch peak. If a
pending suggestion isn't acted on within 10 minutes, the worker is released back
to the pool and that still-open case re-suggests the next-lowest (which may be
the same person if they're still lowest; the clerk can override or mark them
unavailable to break a loop).

---

## 7. Notification

- Channel is **Teams**, manual. The app does not send anything — it generates the
  message and the clerk copy-pastes it.
- The copy-paste affordance must be obvious (a clear "Copy" button).
- Fire-and-forget from the app's side; the human confirmation loop happens in
  Teams and the clerk records the result.

---

## 8. Screens / tabs

1. **Assign** (clerk's main screen)
   - Program selector
   - Suggested worker, prominently displayed
   - Buttons: **Assign**, **Mark Unavailable** (with reason), **Override**
     (pick someone else)
   - Copy-paste message box with case-number field for the clerk to fill
   - List of this clerk's currently-pending suggestions

2. **Roster / Live Status**
   - All 22 workers with current state, color-coded
   - At-a-glance view of who's available / pending / temp-unavailable / out

3. **Admin — Staff Management** (supervisor only)
   - Add / edit / deactivate workers
   - Set EA level (1–3)
   - Per-program training grid (worker × SNAP/TANF/MEPD/Medicaid)
   - Set unavailability: single-day, date-range, and recurring schedules for
     WFH / PTO / special project / callout

4. **Log**
   - Chronological assignments: ticket #, timestamp, program, worker, clerk,
     and a manual-assignment flag

5. **Reports / Balances**
   - Counts per worker for **today**, **this week**, and **historical**
   - This is the fairness proof for the pitch

---

## 9. Look & feel

- **Official, government-tool aesthetic** — clean and professional.
- **Big, tap-friendly buttons.** Clerks are not fast users; prioritize obvious,
  low-friction UX over density.
- **Color-coded statuses** (e.g., green = available, yellow = temporarily
  unavailable / pending, grey = out). Pick a clean, accessible palette.
- Separate tabs as listed above.

---

## 10. Edge cases

- **No eligible worker for the program:** show "No staff available for
  {program}." (Rare — coverage almost always exists.)
- **Only one eligible worker:** keep assigning them.
- **Supervisor mis-marks someone unavailable:** easy undo (remove the
  unavailability entry).
- **Wrong person assigned:** quick reassign that **corrects the counts** —
  decrement the wrongly-assigned worker, increment the new one.

---

## 11. Data model (Firestore)

- **`users`** — login accounts. `{ uid, name, role: "clerk"|"supervisor" }`
- **`workers`** — the 22 advisors. `{ id, firstName, lastName, eaLevel: 1|2|3,
  programs: { snap, tanf, mepd, medicaid: bool }, active: bool }`
- **`unavailability`** — supervisor-set. `{ workerId, type:
  "wfh"|"pto"|"special_project"|"callout", mode: "single"|"range"|"recurring",
  date | startDate+endDate | weekday }`
- **`assignments`** — the source-of-truth log. `{ ticket, timestamp, program,
  workerId, clerkId, manual: bool }`. **Weekly counts and all reports are derived
  from this** (filter by `timestamp >= mostRecentMonday00:00`), so there's a
  single source of truth and nothing to reset by hand.
- **`liveState`** — ephemeral operational state:
  - pending suggestions `{ workerId, caseTicket, clerkId, suggestedAt,
    expiresAt }`
  - temp-unavailable `{ workerId, reason, until }`

Firestore gives you the shared state the multi-clerk setup requires and the
overnight persistence (counts carry across days within the week, reports persist
historically).

---

## 12. Recommended stack

- **Firebase**: Firestore (shared state), Auth (per-person logins, role-gated),
  Hosting (deploy). You already know this stack from prior projects.
- **Framework:** your call. Given several stateful screens and reusable
  status components, React + Tailwind will move fastest, but plain HTML/CSS/JS
  works too. Use the `frontend-design` skill in Claude Code for the official look.

---

## 13. Suggested build order (for Claude Code)

1. Data model + seed the 22 workers (EA levels, training grid) and a couple of
   test login accounts.
2. The selection algorithm as a pure function, with the Assign flow and count
   increment. Get one clerk, one program working end to end.
3. Pending state + 10-min release + the multi-clerk concurrency guard.
4. Temp-unavailable (30-min) + immediate re-suggest.
5. Admin page: training grid + single/range/recurring unavailability.
6. Override, reassign-with-count-correction, and the edge cases.
7. Log + Reports (today / week / historical) from the assignments collection.
8. Auth + role gating, then polish the look and the copy-paste message UX.

---

## 14. Decisions still open (decide during build, low stakes)

- **Alphabetical tiebreak field:** by last name (default in the algorithm above)
  or first name?
- **"Historical" reporting window:** all-time cumulative, or rolling N weeks?
- **Global vs per-program weekly count:** global is the default and the right
  call for total-load fairness; revisit only if MEPD/scarce-program coverage
  looks lopsided in testing.
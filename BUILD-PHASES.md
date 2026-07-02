# Lobby Assignment System — Build Phases

Trackable phases derived from the spec. Each phase has a goal, tasks, and a
**Definition of Done (DoD)** — don't move on until the DoD passes. Build in
order; each phase depends on the ones before it.

Full requirements live in `lobby-assignment-system-spec.md`. Invariants Claude
Code must never break live in `CLAUDE.md`.

**Status: all phases (0–8) complete and verified.** The checkboxes below are
ticked to reflect the shipped build.

---

## Phase 0 — Scaffold & Firebase setup

**Goal:** empty app deploys and talks to Firebase.

- [x] Init repo + framework (React + Tailwind recommended) + `frontend-design` skill
- [x] Create Firebase project; enable Firestore, Auth, Hosting
- [x] Wire Firebase config; basic deploy to Hosting works
- [x] Confirm Firestore read/write from the app

**DoD:** a blank app is live on Firebase Hosting and can write a test doc to
Firestore.

---

## Phase 1 — Data model + seed

**Goal:** the roster and accounts exist to build against.

- [x] Define collections: `users`, `workers`, `unavailability`, `assignments`, `liveState`
- [x] Seed 22 workers: `firstName`, `lastName`, `eaLevel (1–3)`, `programs {snap, tanf, mepd, medicaid: bool}`, `active`
- [x] Seed 2 test logins: one `clerk`, one `supervisor`
- [x] Make the training grid varied across workers (so program filtering is testable)

**DoD:** can read all 22 seeded workers with their training flags; both test
accounts exist.

---

## Phase 2 — Selection algorithm + Assign flow (one clerk, one program, end to end)

**Goal:** the fairness engine works for the happy path.

- [x] `suggestWorker(program)` as a **pure function**
- [x] Weekly count derived from `assignments` where `timestamp >= mostRecentMonday00:00`
- [x] Sort: `weeklyCount ASC → lastName ASC → firstName ASC`
- [x] EA3 last-resort logic (only when no trained EA1/EA2 available)
- [x] Program selector on the Assign screen
- [x] **Assign** button → writes an `assignments` doc → count reflects it
- [x] Generate the copy-paste message + case-number field

**DoD:** enter a SNAP case → the correct lowest-weekly-count trained worker is
suggested → Assign logs it and that worker's weekly count goes up by exactly 1.

---

## Phase 3 — Pending state + 10-min release + concurrency guard

**Goal:** two clerks never get handed the same worker. **(Highest-risk phase —
test hardest.)**

- [x] On suggestion, write a `pending` entry to `liveState` and remove the worker from the pool **immediately** (before confirm)
- [x] 10-min `expiresAt`; on expiry, release the worker and re-suggest for the still-open case
- [x] Per-clerk "currently-pending suggestions" list on the Assign screen
- [x] Start the Roster/Live Status tab (Available + Pending states)

**DoD:** open two browser windows as two clerks; enter two different cases
seconds apart → they get **different** workers. A pending suggestion left
untouched releases after 10 minutes.

---

## Phase 4 — Temp-unavailable (30-min) + immediate re-suggest

**Goal:** "worker says they can't take it" is handled live.

- [x] **Mark Unavailable** (+reason) writes temp-unavailable to `liveState`, `until = now + 30min`
- [x] Marking unavailable does **NOT** increment count
- [x] Immediately re-suggest the next-lowest eligible worker for the same open case
- [x] Auto-resolve back into the pool after 30 min
- [x] Add temp-unavailable (yellow) to the Roster/Live Status tab

**DoD:** mark the suggested worker unavailable → next-lowest is suggested
instantly, no count change → the marked worker reappears in the pool after 30 min.

---

## Phase 5 — Admin / Staff Management (supervisor)

**Goal:** supervisors control the roster and absences.

- [x] Add / edit / deactivate workers; set EA level; per-program training grid
- [x] Set unavailability: **single-day, date-range, recurring** (WFH / PTO / special project / callout)
- [x] `supervisorUnavailableToday(worker)` respects all three modes
- [x] WFH = fully skipped
- [x] Complete the Roster/Live Status tab (add "out" / grey state)

**DoD:** set a recurring WFH every Tuesday → that worker is skipped on Tuesdays
only. Set a PTO range → skipped for the whole range, back in afterward.

---

## Phase 6 — Override, reassign-with-count-correction, edge cases

**Goal:** the escape hatches and rare paths work.

- [x] **Override:** clerk picks any eligible worker; count still increments; log + UI flag it **manual**
- [x] **Reassign:** decrement the wrongly-assigned worker, increment the new one
- [x] No eligible worker → "No staff available for {program}"
- [x] Only one eligible → keep assigning them
- [x] Undo a supervisor unavailability entry (mis-mark fix)

**DoD:** an override shows a clear "manual" flag in the log; a reassign moves the
count from one worker to the other (net zero); the no-staff message appears when
the pool is empty.

---

## Phase 7 — Log + Reports / Balances

**Goal:** the fairness proof for the pitch.

- [x] **Log tab:** chronological — ticket #, timestamp, program, worker, clerk, manual flag
- [x] **Reports tab:** counts per worker for **today / this week / historical**
- [x] All numbers derived from the `assignments` collection (single source of truth)
- [x] Week window uses most-recent Monday 00:00

**DoD:** the weekly report shows a roughly flat distribution after a test run —
this is the screen you demo first.

---

## Phase 8 — Auth + role gating + polish

**Goal:** real logins, locked-down roles, finished UX.

- [x] Firebase Auth per-person login
- [x] Role gate: Admin tab is **supervisor-only**; clerks can't reach it
- [x] Big tap-friendly buttons; color-coded statuses (green/yellow/grey)
- [x] Obvious **Copy** button on the message box
- [x] Official, clean government-tool look (`frontend-design` skill)

**DoD:** a clerk login cannot see or open the Admin page; the copy button works;
a non-technical user can complete an assignment without instruction.

---

## Decisions to lock during the build (low stakes)

- [x] Alphabetical tiebreak: **last name** (settled in `selection.js` — `lastName ASC → firstName ASC`).
- [x] "Historical" report window: **rolling 8 weeks** (DEFAULT_HISTORICAL_WEEKS in counts.js).
- [x] Global vs per-program weekly count: **global** — one weekly tally per worker across all programs.
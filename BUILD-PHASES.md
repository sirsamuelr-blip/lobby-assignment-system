# Lobby Assignment System — Build Phases

Trackable phases derived from the spec. Each phase has a goal, tasks, and a
**Definition of Done (DoD)** — don't move on until the DoD passes. Build in
order; each phase depends on the ones before it.

Full requirements live in `lobby-assignment-system-spec.md`. Invariants Claude
Code must never break live in `CLAUDE.md`.

---

## Phase 0 — Scaffold & Firebase setup

**Goal:** empty app deploys and talks to Firebase.

- [ ] Init repo + framework (React + Tailwind recommended) + `frontend-design` skill
- [ ] Create Firebase project; enable Firestore, Auth, Hosting
- [ ] Wire Firebase config; basic deploy to Hosting works
- [ ] Confirm Firestore read/write from the app

**DoD:** a blank app is live on Firebase Hosting and can write a test doc to
Firestore.

---

## Phase 1 — Data model + seed

**Goal:** the roster and accounts exist to build against.

- [ ] Define collections: `users`, `workers`, `unavailability`, `assignments`, `liveState`
- [ ] Seed 22 workers: `firstName`, `lastName`, `eaLevel (1–3)`, `programs {snap, tanf, mepd, medicaid: bool}`, `active`
- [ ] Seed 2 test logins: one `clerk`, one `supervisor`
- [ ] Make the training grid varied across workers (so program filtering is testable)

**DoD:** can read all 22 seeded workers with their training flags; both test
accounts exist.

---

## Phase 2 — Selection algorithm + Assign flow (one clerk, one program, end to end)

**Goal:** the fairness engine works for the happy path.

- [ ] `suggestWorker(program)` as a **pure function**
- [ ] Weekly count derived from `assignments` where `timestamp >= mostRecentMonday00:00`
- [ ] Sort: `weeklyCount ASC → lastName ASC → firstName ASC`
- [ ] EA3 last-resort logic (only when no trained EA1/EA2 available)
- [ ] Program selector on the Assign screen
- [ ] **Assign** button → writes an `assignments` doc → count reflects it
- [ ] Generate the copy-paste message + case-number field

**DoD:** enter a SNAP case → the correct lowest-weekly-count trained worker is
suggested → Assign logs it and that worker's weekly count goes up by exactly 1.

---

## Phase 3 — Pending state + 10-min release + concurrency guard

**Goal:** two clerks never get handed the same worker. **(Highest-risk phase —
test hardest.)**

- [ ] On suggestion, write a `pending` entry to `liveState` and remove the worker from the pool **immediately** (before confirm)
- [ ] 10-min `expiresAt`; on expiry, release the worker and re-suggest for the still-open case
- [ ] Per-clerk "currently-pending suggestions" list on the Assign screen
- [ ] Start the Roster/Live Status tab (Available + Pending states)

**DoD:** open two browser windows as two clerks; enter two different cases
seconds apart → they get **different** workers. A pending suggestion left
untouched releases after 10 minutes.

---

## Phase 4 — Temp-unavailable (30-min) + immediate re-suggest

**Goal:** "worker says they can't take it" is handled live.

- [ ] **Mark Unavailable** (+reason) writes temp-unavailable to `liveState`, `until = now + 30min`
- [ ] Marking unavailable does **NOT** increment count
- [ ] Immediately re-suggest the next-lowest eligible worker for the same open case
- [ ] Auto-resolve back into the pool after 30 min
- [ ] Add temp-unavailable (yellow) to the Roster/Live Status tab

**DoD:** mark the suggested worker unavailable → next-lowest is suggested
instantly, no count change → the marked worker reappears in the pool after 30 min.

---

## Phase 5 — Admin / Staff Management (supervisor)

**Goal:** supervisors control the roster and absences.

- [ ] Add / edit / deactivate workers; set EA level; per-program training grid
- [ ] Set unavailability: **single-day, date-range, recurring** (WFH / PTO / special project / callout)
- [ ] `supervisorUnavailableToday(worker)` respects all three modes
- [ ] WFH = fully skipped
- [ ] Complete the Roster/Live Status tab (add "out" / grey state)

**DoD:** set a recurring WFH every Tuesday → that worker is skipped on Tuesdays
only. Set a PTO range → skipped for the whole range, back in afterward.

---

## Phase 6 — Override, reassign-with-count-correction, edge cases

**Goal:** the escape hatches and rare paths work.

- [ ] **Override:** clerk picks any eligible worker; count still increments; log + UI flag it **manual**
- [ ] **Reassign:** decrement the wrongly-assigned worker, increment the new one
- [ ] No eligible worker → "No staff available for {program}"
- [ ] Only one eligible → keep assigning them
- [ ] Undo a supervisor unavailability entry (mis-mark fix)

**DoD:** an override shows a clear "manual" flag in the log; a reassign moves the
count from one worker to the other (net zero); the no-staff message appears when
the pool is empty.

---

## Phase 7 — Log + Reports / Balances

**Goal:** the fairness proof for the pitch.

- [ ] **Log tab:** chronological — ticket #, timestamp, program, worker, clerk, manual flag
- [ ] **Reports tab:** counts per worker for **today / this week / historical**
- [ ] All numbers derived from the `assignments` collection (single source of truth)
- [ ] Week window uses most-recent Monday 00:00

**DoD:** the weekly report shows a roughly flat distribution after a test run —
this is the screen you demo first.

---

## Phase 8 — Auth + role gating + polish

**Goal:** real logins, locked-down roles, finished UX.

- [ ] Firebase Auth per-person login
- [ ] Role gate: Admin tab is **supervisor-only**; clerks can't reach it
- [ ] Big tap-friendly buttons; color-coded statuses (green/yellow/grey)
- [ ] Obvious **Copy** button on the message box
- [ ] Official, clean government-tool look (`frontend-design` skill)

**DoD:** a clerk login cannot see or open the Admin page; the copy button works;
a non-technical user can complete an assignment without instruction.

---

## Decisions to lock during the build (low stakes)

- [ ] Alphabetical tiebreak: last name (default) or first name?
- [ ] "Historical" report window: all-time, or rolling N weeks?
- [ ] Global vs per-program weekly count (global is the default; revisit only if scarce-program coverage looks lopsided)
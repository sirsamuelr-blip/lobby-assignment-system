# CLAUDE.md

Project guidance for Claude Code. Read this before writing any code. The full
requirements are in `lobby-assignment-system-spec.md`; the phased build plan is
in `BUILD-PHASES.md`. This file is the **invariants** — the rules that, if
broken, silently destroy fairness or compliance.

---

## What this is

A standalone tool for a Texas HHSC benefits office that assigns each incoming
lobby case to the fairest eligible advisor, so no one person gets drained. It is
**independent** — it connects to nothing (no EWMS, no TIERS) and stores **no
client PII**.

---

## Spec amendments

These supersede the corresponding wording in
`lobby-assignment-system-spec.md`:

- **Multi-program cases (Phase 2 amendment).** A client may apply for **multiple
  programs in one visit**. The clerk selects **all** of them; **one** advisor
  trained in **every** selected program takes the whole case. It is **one case →
  one `assignments` doc → +1** to that worker's global weekly count — the count
  is **per case, never per program**. This supersedes the single-program
  wording (`suggestWorker(program)`, `trainedIn(program)`, the `program` field)
  throughout the spec: selection now intersects training across `programs[]`,
  and the assignment doc stores `programs: string[]`.

- **Ticket timing (Phase 3 amendment).** The sequential ticket is issued at
  **Assign**, not at Pending, so the sequence stays dense — only confirmed
  Assigns consume a number. Pending docs carry **no ticket**. A reloaded tab
  restores its own unexpired claim by `clerkId`.

---

## Golden rules (never violate these)

1. **No client PII. Ever.** Firestore stores only: a sequential ticket label,
   the program(s) (an array — one case may cover several), assigned worker,
   clerk, timestamp, manual-flag. The real EWMS case number/name lives **only**
   in the Teams message the clerk pastes — never in the database. Do not add a
   "case name" or "client" field to any collection.

2. **Count increments ONLY on a confirmed Assign** (including manual override
   assigns). Being suggested, going pending, being marked unavailable, or
   expiring must **never** change a count.

3. **Selection key is weekly count; alphabetical breaks ties.** Sort order is
   exactly `weeklyCount ASC → lastName ASC → firstName ASC`. "Weekly" = since the
   most recent **Monday 00:00** (local). The weekly count is **GLOBAL per
   worker across all programs** — one shared tally, not per-program — and is
   **always derived** from `assignments` (`timestamp >= most-recent-Monday`).
   Never store or hand-reset a count.

4. **Suggesting a worker puts them Pending immediately — before they confirm.**
   The candidate pool must always exclude pending workers. This is the
   concurrency guard that stops two clerks from being handed the same person.
   Never build a pool that can include a pending worker.

5. **EA3 is last resort.** EA3 workers are eligible only when no trained EA1/EA2
   is available for that program.

6. **`assignments` is the single source of truth.** All counts and reports
   (today / weekly / historical) are **derived** from it by filtering on
   `timestamp`. Do not keep a separate mutable counter that can drift.

7. **WFH = fully skipped.** Lobby cases cannot be done remotely.

8. **Reassign corrects counts:** decrement the wrongly-assigned worker, increment
   the new one (net zero).

9. **Workers do not log in.** Only clerks and supervisors have accounts. The
   `workers` roster and the `users` login accounts are **separate concepts** — a
   clerk/supervisor is not necessarily one of the 22 advisors.

---

## The selection algorithm (the heart of it)

Runs on every case entry and every re-suggest. Build it as a **pure function.**

```
suggestWorker(programs):                        # programs is an array of 1+ keys
  if programs is empty / not an array: return "No program selected"
  candidates = workers where:
      active == true
      trainedInAll(programs) == true            # trained in EVERY selected program
      NOT supervisorUnavailableToday(worker)   # WFH / PTO / special project / callout
      NOT tempUnavailable(worker)              # clerk-set, 30-min
      NOT pending(worker)                       # suggested, awaiting reply, 10-min window

  pool = candidates where eaLevel != 3
  if pool is empty: pool = candidates          # EA3 only now eligible
  if pool is empty: return "No staff available for {labels joined with ' + '}"

  sort pool by: weeklyCount ASC, then lastName ASC, then firstName ASC
  return pool[0]
```

---

## Worker states

| State | Set by | Pool effect | Auto-resolve | Increments count? |
|---|---|---|---|---|
| Available | — | in pool | — | — |
| Pending | system (on suggest) | out | 10 min → released | No |
| Temp unavailable | clerk (+reason) | out | 30 min → returns | No |
| Unavailable (WFH/PTO/special project/callout) | supervisor | out | per admin schedule | No |

Supervisor unavailability supports **single-day, date-range, and recurring**
schedules.

---

## Roles & permissions

- **Clerk:** enter case, view suggestion, Assign / Mark Unavailable / Override,
  generate Teams message.
- **Supervisor:** everything a clerk can do **plus** the Admin / Staff Management
  page. The Admin page is supervisor-only — gate it.

---

## Data model (Firestore)

- `users` — `{ uid, name, role: "clerk"|"supervisor" }`
- `workers` — `{ id, firstName, lastName, eaLevel: 1|2|3, programs: { snap, tanf, mepd, medicaid: bool }, active: bool }`
- `unavailability` — `{ workerId, type: "wfh"|"pto"|"special_project"|"callout", mode: "single"|"range"|"recurring", date | startDate+endDate | weekday }`
- `assignments` — `{ ticket, timestamp, programs: string[], workerId, clerkId, manual: bool }`  ← source of truth (one case, one doc, +1 — even when `programs` lists several)
- `liveState` — pending `{ kind: 'pending', workerId, programs: string[], clerkId, suggestedAt, expiresAt }` (doc id `pending_<workerId>`); temp-unavailable `{ kind: 'tempUnavailable', workerId, reason, until, markedAt }` (doc id `tempunavail_<workerId>`)

---

## Flow (one case)

Program(s) selected → suggest lowest-weekly-count eligible worker (now Pending,
10-min timer) → show copy-paste message `"{Name}, you have been assigned the next
lobby case. Please advise on availability."` (clerk appends EWMS case # before
sending) → worker replies in Teams → clerk hits **Assign** (count++, logged,
pending cleared) **or** **Mark Unavailable** (+reason, 30-min, auto re-suggest
next-lowest). One client at a time per clerk.

---

## Stack & conventions

- **Firebase**: Firestore (shared state), Auth (role-gated logins), Hosting.
- **Framework:** React + Tailwind preferred; use the `frontend-design` skill for
  the official, government-tool look.
- **UX bias:** big tap-friendly buttons, color-coded statuses (green = available,
  yellow = pending/temp-unavailable, grey = out), low-friction for slow users.
- Keep `suggestWorker` and count derivation as **pure, testable functions** —
  they are the part most worth unit-testing.

## Commands

- `npm install` — install dependencies.
- `npm run dev` — start the Vite dev server (http://localhost:5173).
- `npm run build` — production build to `dist/`.
- `npm run preview` — preview the production build locally.
- `firebase deploy` — deploy `dist/` to Firebase Hosting (run `firebase login`
  first; Hosting config is in `firebase.json`, default project in `.firebaserc`).

Firebase web config is read from `import.meta.env.VITE_FB_*` (see `.env.local` /
`.env.example`) and wired up in `src/firebase.js`, which exports `db` and `auth`.
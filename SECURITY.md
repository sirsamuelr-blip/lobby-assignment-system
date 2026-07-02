# Security

This document describes the security posture of the Lobby Assignment System, how
secrets are handled, and how to report a problem. For a full accounting of what
data is stored, see [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md).

## Design principles

- **No client PII.** The app never stores client names, SSNs, dates of birth,
  addresses, phone numbers, case notes, or eligibility determinations. See the
  data-handling doc for the field-by-field breakdown.
- **No external connections.** The app does not connect to EWMS, TIERS, or any
  other agency system. Its only backend is the office's own Firebase project.
- **Per-person authentication.** Every clerk and supervisor logs in with their
  own Firebase Auth account. Workers (the 22 advisors) do not log in at all.
- **Role-gating at the data layer.** Access is controlled by Firestore Security
  Rules, not just by hiding UI. The Admin/Staff-Management area is restricted to
  supervisor accounts; clerks cannot reach it or read/write admin data even if
  they craft requests directly.
- **Audit trail by design.** The `assignments` collection is an append-oriented
  log — who was assigned what, when, by which clerk, and whether it was a manual
  override. Accountability is a feature, not a side effect.

## Implementation status

The controls above are **implemented**. Per-person Firebase Auth gates the whole
app, and Firestore Security Rules (`firestore.rules`) enforce role-gating at the
data layer: only signed-in staff can read; only supervisors can write the
`workers` / `unavailability` collections; the `assignments` log is append-only
and records only the acting clerk's own id; and no extra field (e.g. client
data) can be written to any collection. The rules ship with the repo and are
covered by an emulator test suite (`npm run test:rules`).

- **Deploy the rules before real data.** A fresh Firebase project starts in
  test-mode (open) rules; run `firebase deploy --only firestore:rules` before an
  instance goes in front of staff, and confirm in the Firebase console that the
  deployed rules are the ones in this repo — not the test-mode default.
- Before any pilot, verify that unauthenticated reads/writes are denied and that
  a clerk account cannot write the admin collections. The Rules Playground in
  the Firebase console can simulate both.

## Secrets and configuration

- **The `VITE_FB_*` values are the public Firebase web app config, not secrets.**
  Firebase web config is designed to ship in client-side code; it identifies the
  project but does not grant access — access is governed by Auth and Security
  Rules. It is safe for these values to appear in the built bundle.
- **`.env.local` is git-ignored.** `.env.example` is committed with blank
  placeholder values only, as a reference for which keys are needed.
- **Never commit a Firebase service-account key** (the private admin JSON), an
  API token, or any other private credential. Those grant privileged server-side
  access and must stay out of the repository entirely.
- If a private credential is ever committed by accident, rotate it immediately;
  removing it from the latest commit does not remove it from git history.

## Deploying safely

- Each office deploys its **own** instance against its **own** Firebase project.
  Instances do not share a database.
- Enable Firestore Security Rules before putting an instance in front of real
  staff; do not rely on client-side role checks alone.
- Choose the most privacy-preserving configuration available for your project
  (least-privilege Auth, restrictive rules).

## Reporting a security issue

If you find a vulnerability or a data-handling concern, please report it
privately rather than opening a public issue:

- Open a **private security advisory** on the repository (if enabled), **or**
- Email the maintainer at: `<sirsamuelr@gmail.com>`

Please include steps to reproduce and the potential impact. We ask that you give
a reasonable window to address the issue before any public disclosure.

## Scope

This policy covers the application code in this repository. It does not cover
the security of any individual office's Firebase project, Microsoft Teams tenant,
or workstation configuration — those are the responsibility of the deploying
office and its IT/security team.
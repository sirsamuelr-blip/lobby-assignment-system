# Lobby Assignment System

A standalone web tool that assigns each incoming **lobby case** in a Texas HHSC
benefits office to the **fairest eligible advisor** — the trained, available
person with the lowest weekly load. It removes the "who wants to pull this one?"
step so clients wait less and the same reliable people don't get drained.

It is deliberately **independent**:

- **Connects to nothing** — no EWMS, no TIERS, no other agency system.
- **Stores no client PII** — see [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md)
  for the exact, field-by-field accounting of what it does and does not keep.
- **Usable on day one** — each office runs its own self-contained instance.

## What this is / is not

**It is:** a fairness and workload-balancing tool for staff. It names the next
advisor, generates a copy-paste Teams message, and keeps an audit log of who was
assigned what, when, and by whom.

**It is not:** a system of record, an eligibility system, or an integration. It
does not read or write EWMS/TIERS, does not make eligibility determinations, and
does not store client case data. The link to EWMS is a single opaque case/ticket
number the clerk types in — nothing more.

## Project status

**Phase 0 — scaffold + Firebase connectivity check.** The app deploys and can
read/write Firestore. **No assignment logic exists yet.** The full plan lives in
[`BUILD-PHASES.md`](BUILD-PHASES.md) and the complete requirements in
[`lobby-assignment-system-spec.md`](lobby-assignment-system-spec.md).

## Stack

- [Vite](https://vite.dev/) + [React 19](https://react.dev/)
- [Tailwind CSS v4](https://tailwindcss.com/) (via the `@tailwindcss/vite` plugin)
- [Firebase 12](https://firebase.google.com/) — Firestore, Auth, Hosting

## Stand up your own instance

Each adopting office runs its **own** Firebase project with its **own** roster,
logins, and data. No instance shares a database with another — you get a clean,
private copy.

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Firebase CLI](https://firebase.google.com/docs/cli)
  (`npm install -g firebase-tools`) for deploys
- A Firebase project of your own (Firestore + Auth + Hosting enabled)

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file from the template and fill in **your**
   Firebase web config values:

   ```bash
   cp .env.example .env.local
   ```

   The `VITE_FB_*` values are the public Firebase **web app** config (not
   secrets — see [`SECURITY.md`](SECURITY.md)). `.env.local` is git-ignored;
   `.env.example` is committed with blank values as a key reference.

3. Point deploys at your own project by editing `.firebaserc` (the default here
   is `lobby-assignment`).

### Run

```bash
# Start the dev server (http://localhost:5173)
npm run dev

# Production build → dist/
npm run build

# Preview the production build locally
npm run preview
```

### Seed test data

To populate a fresh instance with sample data, run the seed script:

```bash
npm run seed
```

It writes **22 test workers** (the advisor roster) plus **2 test login
accounts** — one clerk and one supervisor. The script is **idempotent**: workers
use deterministic doc IDs so re-running overwrites in place (never duplicates),
and the login accounts recover their existing uid instead of erroring if they
already exist.

Configuration comes from `.env.local`. Alongside the `VITE_FB_*` values, set the
`SEED_*` variables (see `.env.example`): the login **passwords**
(`SEED_CLERK_PASSWORD` / `SEED_SUPERVISOR_PASSWORD`) are **required** and must be
at least 6 characters; the emails and names are optional and fall back to
sensible defaults. No client PII is written — workers carry roster attributes
only.

> **Note:** The seed uses the Firebase **client** SDK, so it relies on
> test-mode (open) Firestore rules. Phase 8 locks the rules down; after that,
> re-seed via the Admin SDK or by temporarily relaxing the rules.

### Connectivity check

With the dev server running, open the app and click **"Write test doc to
Firestore."** On success it shows the new document's ID; on failure it shows the
error message. The test writes a single `{ ok: true, at: <serverTimestamp> }`
document to the `healthcheck` collection.

### Deploy (Firebase Hosting)

```bash
# One-time login
firebase login

# Build, then deploy the contents of dist/
npm run build
firebase deploy
```

Hosting config lives in `firebase.json` (serves `dist/`, SPA rewrite of all
routes to `/index.html`). The default project is set in `.firebaserc`.

## Documentation

- [`lobby-assignment-system-spec.md`](lobby-assignment-system-spec.md) —
  full requirements and the fairness-engine rationale.
- [`BUILD-PHASES.md`](BUILD-PHASES.md) — the phased build plan with a
  Definition of Done for each phase.
- [`SECURITY.md`](SECURITY.md) — security posture, secrets handling, and how to
  report a problem.
- [`docs/DATA_HANDLING.md`](docs/DATA_HANDLING.md) — exactly what data is stored,
  what is deliberately excluded, and why none of it is client PII.

## Accessibility

This is a tool used by public-sector staff, so accessibility is a requirement,
not a nice-to-have. The design goals are **WCAG 2.1 AA**:

- Status is never conveyed by **color alone** — every colored state also carries
  a text label or icon.
- Full **keyboard operability** with visible focus states.
- Sufficient **color contrast** on all text and controls.

## License

Released under the **Apache License 2.0** — see [`LICENSE`](LICENSE). This means
anyone may use, modify, and deploy it, including inside their own office, at no
cost. (Apache 2.0 includes an explicit patent grant, which reviewers in
government settings often prefer; MIT is a reasonable simpler alternative.)

## Support

The code is free and self-serviceable — the setup steps above are meant to let
an office stand up its own instance without help. Formal support (guaranteed
response times, hands-on setup, managed hosting) is not currently offered.
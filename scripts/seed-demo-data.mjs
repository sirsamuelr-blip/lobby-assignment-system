// scripts/seed-demo-data.mjs — populate a realistic, screenshot-ready demo:
//   • assignments  — ~8 weeks of fair, backdated cases (Reports + Log)
//   • assignments  — a slice flagged Manual and a slice Reassigned (Log badges)
//   • unavailability — recurring / range / single entries (Admin scheduler + grey Roster)
//   • liveState    — a few temp-unavailable + pending docs (yellow Roster states)
//   • counters/tickets — advanced past the last seeded ticket
//
// It does NOT fabricate a distribution — it REPLAYS your real fairness engine
// (selection.js semantics: trained-in-EVERY-program intersection, EA3 last
// resort, sort = weeklyCount ASC → lastName ASC → firstName ASC) against a
// simulated week of arrivals, and respects supervisor-unavailability per day the
// same way the app does. The result is exactly what your tool would produce.
//
// Schemas verified against src/lib (assignments.js, selection.js, tickets.js,
// supervisorUnavailability.js, scheduleForm.js, unavailable.js, pending.js) and
// scripts/seed.js. No client PII is written anywhere.
//
// WHY firebase-admin: Phase 8 locked the Firestore rules, and rules reject a
// backdated `timestamp`. The Admin SDK bypasses rules, which is the only way to
// write the spread-out timestamps the Reports/Log tabs need.
//
// SETUP
//   npm i -D firebase-admin           # luxon is already a project dep
//   # Firebase console → Project settings → Service accounts → Generate new
//   # private key, then point to it (you manage this file, not me):
//   export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/serviceAccountKey.json"
//
// RUN (against a freshly-reset DB: workers + users present, nothing else)
//   node scripts/seed-demo-data.mjs              # DRY RUN — prints plan + spread
//   CONFIRM=yes node scripts/seed-demo-data.mjs  # writes, after you read the target
//
// Re-running without a reset duplicates docs. Set WIPE_FIRST=true to have the
// script clear assignments / unavailability / liveState itself before seeding.

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { DateTime } from 'luxon'

// ===========================================================================
// KNOBS (shapes are already matched to your code — these are just taste dials)
// ===========================================================================
const TIMEZONE = 'America/Chicago'   // == WEEK_ZONE in week.js
const WEEKS = 8                      // == DEFAULT_HISTORICAL_WEEKS in counts.js
const CASES_PER_DAY = [20, 30]       // spec: ~20–30 lobby cases/day
const MANUAL_RATE = 0.06             // ~6% pure overrides  → "Manual" badge
const REASSIGN_RATE = 0.03           // ~3% corrected cases → "Reassigned" badge
const MULTI_PROGRAM_RATE = 0.06      // ~6% two-program cases (e.g. SNAP · Medicaid)
const FIRST_TICKET = 1               // == FIRST_TICKET in tickets.js
const WIPE_FIRST = false             // true = delete existing demo docs first

// Program mix (Texas reality: SNAP-heavy, Medicaid solid, MEPD modest, TANF rare).
const PROGRAM_MIX = { snap: 0.48, medicaid: 0.30, mepd: 0.14, tanf: 0.08 }
// Safe two-program combos with reliable EA1/EA2 coverage in your roster.
const MULTI_COMBOS = [['snap', 'medicaid'], ['snap', 'tanf']]
// ===========================================================================

initializeApp({ credential: applicationDefault() })
const db = getFirestore()
const CONFIRMED = process.env.CONFIRM === 'yes'

const rnd = (a, b) => a + Math.random() * (b - a)
const rndInt = (a, b) => Math.floor(rnd(a, b + 1))
const pick = (arr) => arr[rndInt(0, arr.length - 1)]

function weightedProgram() {
  const r = Math.random()
  let acc = 0
  for (const [k, w] of Object.entries(PROGRAM_MIX)) {
    acc += w
    if (r <= acc) return k
  }
  return 'snap'
}

// trained-in-EVERY-selected-program (the intersection selection.js uses).
const trainedInAll = (w, programs) => programs.every((p) => w.programs?.[p] === true)

// selection.js sort key: weeklyCount ASC → lastName ASC → firstName ASC.
function fairest(pool, counts) {
  return [...pool].sort(
    (a, b) =>
      (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0) ||
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  )[0]
}

// Mirror of supervisorUnavailability.isSupervisorUnavailableOn (single/range/
// recurring), so the replay skips out-workers exactly like the live pool does.
function isOutOn(u, isoDate, weekday) {
  switch (u.mode) {
    case 'single': return u.date === isoDate
    case 'range': return u.startDate <= isoDate && isoDate <= u.endDate
    case 'recurring': return u.weekday === weekday
    default: return false
  }
}

// Business-hours arrival, weighted toward the lunch peak (spec §1).
function arrivalOn(dayStart) {
  const r = Math.random()
  const hour = r < 0.25 ? rndInt(8, 10) : r < 0.7 ? rndInt(11, 13) : rndInt(13, 15)
  return dayStart.set({ hour, minute: rndInt(0, 59), second: rndInt(0, 59) })
}

async function wipe(coll) {
  const snap = await db.collection(coll).get()
  let batch = db.batch(), n = 0
  for (const d of snap.docs) {
    batch.delete(d.ref)
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch() }
  }
  await batch.commit()
  return snap.size
}

async function main() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? (await db.listCollections(), db.projectId) ?? '(unknown)'
  console.log(`\n=== Target project: ${projectId} ===`)
  console.log(CONFIRMED ? '>>> CONFIRM=yes — WILL WRITE <<<\n' : '>>> DRY RUN — no writes (set CONFIRM=yes) <<<\n')

  // --- Load roster + login accounts live ---
  const workers = (await db.collection('workers').where('active', '==', true).get())
    .docs.map((d) => ({ id: d.id, ...d.data() }))
  if (!workers.length) throw new Error('No active workers — run scripts/seed.js first.')

  const users = (await db.collection('users').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  const clerkIds = users.filter((u) => ['clerk', 'supervisor'].includes(u.role)).map((u) => u.id)
  if (!clerkIds.length) {
    console.warn('⚠️  No clerk/supervisor users found — Log will show truncated ids, not names.')
    clerkIds.push('seed-clerk')
  }
  const has = (id) => workers.some((w) => w.id === id)
  console.log(`Loaded ${workers.length} active workers, ${clerkIds.length} clerk/supervisor account(s).`)

  // --- Time anchors (office zone) ---
  const now = DateTime.now().setZone(TIMEZONE)
  const thisMonday = now.startOf('week')          // Luxon week starts Monday
  const lastMonday = thisMonday.minus({ weeks: 1 })
  const todayISO = now.toISODate()

  // --- Supervisor unavailability (Admin scheduler): all 4 types, all 3 modes ---
  // Curated by the deterministic seed ids. Only kept if the worker still exists.
  const UNAVAILABILITY = [
    { workerId: 'worker-05', type: 'wfh', mode: 'recurring', weekday: 2 },                                   // Aisha Edwards — WFH every Tuesday
    { workerId: 'worker-13', type: 'pto', mode: 'range', startDate: lastMonday.toISODate(), endDate: lastMonday.plus({ days: 4 }).toISODate() }, // Grace Martin — PTO all last week
    { workerId: 'worker-20', type: 'callout', mode: 'single', date: todayISO },                              // Henry Tucker — called out today
    { workerId: 'worker-09', type: 'special_project', mode: 'single', date: todayISO },                      // Sarah Ibarra — special project today
  ].filter((u) => has(u.workerId))

  // --- Replay the engine, oldest week → newest, respecting daily absences ---
  const assignments = []
  let ticket = FIRST_TICKET
  let currentWeekCounts = null

  for (let wk = WEEKS - 1; wk >= 0; wk--) {
    const weekStart = thisMonday.minus({ weeks: wk })
    const counts = new Map(workers.map((w) => [w.id, 0]))

    // Build this week's arrivals (Mon–Fri, nothing in the future).
    const arrivals = []
    for (let d = 0; d < 5; d++) {
      const dayStart = weekStart.plus({ days: d })
      if (dayStart > now.endOf('day')) continue
      const isoDate = dayStart.toISODate()
      const weekday = dayStart.weekday
      const outToday = new Set(UNAVAILABILITY.filter((u) => isOutOn(u, isoDate, weekday)).map((u) => u.workerId))
      const n = rndInt(CASES_PER_DAY[0], CASES_PER_DAY[1])
      for (let c = 0; c < n; c++) {
        const t = arrivalOn(dayStart)
        if (t > now) continue // don't create future timestamps for today
        const programs =
          Math.random() < MULTI_PROGRAM_RATE ? pick(MULTI_COMBOS) : [weightedProgram()]
        arrivals.push({ t, programs, outToday })
      }
    }
    arrivals.sort((a, b) => a.t - b.t)

    for (const a of arrivals) {
      // Eligibility = active + trained in EVERY program + not out today.
      const eligible = workers.filter((w) => trainedInAll(w, a.programs) && !a.outToday.has(w.id))
      if (!eligible.length) continue // no coverage that day — skip (rare)

      const roll = Math.random()
      let workerId, manual = false, reassignedFrom

      if (roll < REASSIGN_RATE && eligible.length > 1) {
        // Corrected case: engine's fair pick is the FINAL (credited) worker;
        // reassignedFrom = a different eligible advisor (the wrong one). manual:true.
        let pool = eligible.filter((w) => w.eaLevel !== 3)
        if (!pool.length) pool = eligible
        const finalW = fairest(pool, counts)
        const wrongW = pick(eligible.filter((w) => w.id !== finalW.id))
        workerId = finalW.id
        reassignedFrom = wrongW.id
        manual = true
      } else if (roll < REASSIGN_RATE + MANUAL_RATE) {
        // Pure override: clerk picks any eligible advisor (all EA levels). manual:true.
        workerId = pick(eligible).id
        manual = true
      } else {
        // Normal fair suggestion: EA1/EA2 first, EA3 only as last resort.
        let pool = eligible.filter((w) => w.eaLevel !== 3)
        if (!pool.length) pool = eligible
        workerId = fairest(pool, counts).id
      }

      counts.set(workerId, (counts.get(workerId) ?? 0) + 1) // credit the final holder
      const doc = {
        ticket: ticket++,
        timestamp: Timestamp.fromDate(a.t.toJSDate()),
        programs: a.programs,
        workerId,
        clerkId: pick(clerkIds),
        manual,
      }
      if (reassignedFrom) doc.reassignedFrom = reassignedFrom
      assignments.push(doc)
    }

    if (wk === 0) currentWeekCounts = counts
  }

  // --- liveState: yellow Roster states (ephemeral — screenshot promptly) ---
  const soon = (mins) => Timestamp.fromMillis(Date.now() + mins * 60 * 1000)
  const liveState = []
  const tempUnavail = [
    { workerId: 'worker-02', reason: 'With a client' },   // James Bennett
    { workerId: 'worker-15', reason: 'Away from desk' },  // Beth Owens
  ].filter((t) => has(t.workerId))
  for (const t of tempUnavail) {
    liveState.push({
      id: `tempunavail_${t.workerId}`,
      data: { kind: 'tempUnavailable', workerId: t.workerId, reason: t.reason, until: soon(28), markedAt: Timestamp.now() },
    })
  }
  const pendings = [
    { workerId: 'worker-03', programs: ['snap'] },        // Priya Chen
    { workerId: 'worker-11', programs: ['medicaid'] },    // Nina Khan
  ].filter((p) => has(p.workerId))
  for (const p of pendings) {
    liveState.push({
      id: `pending_${p.workerId}`,
      data: { kind: 'pending', workerId: p.workerId, programs: p.programs, clerkId: clerkIds[0], suggestedAt: Timestamp.now(), expiresAt: soon(8) },
    })
  }

  // --- Report the plan + current-week spread so you can sanity-check flatness ---
  const nameById = new Map(workers.map((w) => [w.id, `${w.lastName}, ${w.firstName}`]))
  const outTodayIds = new Set(UNAVAILABILITY.filter((u) => isOutOn(u, todayISO, now.weekday)).map((u) => u.workerId))
  const spread = workers
    .map((w) => ({
      advisor: nameById.get(w.id),
      ea: w.eaLevel,
      thisWeek: currentWeekCounts.get(w.id) ?? 0,
      note: outTodayIds.has(w.id) ? 'out today' : w.eaLevel === 3 ? 'EA3 last-resort' : '',
    }))
    .sort((a, b) => a.thisWeek - b.thisWeek)

  const wkVals = spread.filter((r) => r.ea !== 3).map((r) => r.thisWeek)
  console.log(`Planned: ${assignments.length} assignments · ${UNAVAILABILITY.length} unavailability · ${liveState.length} liveState`)
  console.log(`Current-week spread (EA1/EA2): min ${Math.min(...wkVals)}  max ${Math.max(...wkVals)}  (tight = fair)\n`)
  console.table(spread)
  console.log('\nUnavailability entries (Admin scheduler):')
  for (const u of UNAVAILABILITY) {
    const when = u.mode === 'recurring' ? `every weekday ${u.weekday}` : u.mode === 'range' ? `${u.startDate}→${u.endDate}` : u.date
    console.log(`  ${nameById.get(u.workerId)} — ${u.type} (${u.mode}: ${when})`)
  }

  if (!CONFIRMED) {
    console.log('\nDry run complete. Re-run with CONFIRM=yes to write.\n')
    return
  }

  // --- Optional self-reset ---
  if (WIPE_FIRST) {
    for (const c of ['assignments', 'unavailability', 'liveState']) {
      const n = await wipe(c)
      console.log(`Wiped ${n} ${c} docs.`)
    }
  }

  // --- Write everything ---
  let batch = db.batch(), n = 0
  const flush = async () => { if (n % 400 === 0) { await batch.commit(); batch = db.batch() } }

  for (const doc of assignments) { batch.set(db.collection('assignments').doc(), doc); n++; await flush() }
  for (const u of UNAVAILABILITY) { batch.set(db.collection('unavailability').doc(), { ...u, createdAt: Timestamp.now() }); n++; await flush() }
  for (const l of liveState) { batch.set(db.collection('liveState').doc(l.id), l.data); n++; await flush() }
  // Advance the ticket counter past the last seeded ticket (tickets.js shape).
  batch.set(db.collection('counters').doc('tickets'), { next: ticket }, { merge: true }); n++
  await batch.commit()

  console.log(`\n✅ Wrote ${assignments.length} assignments, ${UNAVAILABILITY.length} unavailability, ${liveState.length} liveState, counters/tickets.next=${ticket} → ${projectId}.`)
  console.log('   Roster yellow states (pending/temp-unavailable) expire in ~8–28 min — screenshot the Roster soon.\n')
}

main().catch((e) => { console.error(e); process.exit(1) })

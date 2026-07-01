// scripts/seed.js — Phase 1 seed: the `workers` roster + 2 test `users` accounts.
//
// IMPORTANT: this seed uses the Firebase *client* SDK, so it relies on Firestore
// being in test-mode (open) security rules. Phase 8 locks the rules down; after
// that, re-seed via the Firebase Admin SDK (service-account credentials) or by
// temporarily relaxing rules. Run against locked rules and the writes get denied.
//
// Idempotent by design:
//   - workers use DETERMINISTIC doc IDs (the `id` field) via setDoc, so re-running
//     overwrites in place — exactly 22 docs, never duplicates.
//   - users recover an existing uid via signInWithEmailAndPassword when the auth
//     account already exists, so re-running reuses the same uid + users doc.
//
// This phase only writes `workers` and `users`. The `unavailability`,
// `assignments`, and `liveState` collections are intentionally NOT seeded — they
// are created implicitly by later phases on first write (Firestore has no empty
// collections, and placeholder docs would pollute the source-of-truth log).
//
// No client PII is written anywhere. Workers carry only roster attributes.

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { initializeApp } from 'firebase/app'
import { getFirestore, doc, setDoc, getDocs, collection } from 'firebase/firestore'
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth'

// --- Firebase config: the same VITE_FB_* vars the app reads (src/firebase.js) ---
const firebaseConfig = {
  apiKey: process.env.VITE_FB_API_KEY,
  authDomain: process.env.VITE_FB_AUTH_DOMAIN,
  projectId: process.env.VITE_FB_PROJECT_ID,
  storageBucket: process.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FB_MSG_SENDER_ID,
  appId: process.env.VITE_FB_APP_ID,
}

// --- The 22-advisor roster. Doc ID == the `id` field. Transcribed verbatim. ---
const WORKERS = [
  { id: 'worker-01', firstName: 'Maria', lastName: 'Alvarez', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-02', firstName: 'James', lastName: 'Bennett', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-03', firstName: 'Priya', lastName: 'Chen', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-04', firstName: 'David', lastName: 'Diaz', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-05', firstName: 'Aisha', lastName: 'Edwards', eaLevel: 1, programs: { snap: true, tanf: true, mepd: true, medicaid: true }, active: true },
  { id: 'worker-06', firstName: 'Robert', lastName: 'Foster', eaLevel: 3, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-07', firstName: 'Linda', lastName: 'Garcia', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-08', firstName: 'Kevin', lastName: 'Hill', eaLevel: 2, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-09', firstName: 'Sarah', lastName: 'Ibarra', eaLevel: 1, programs: { snap: true, tanf: false, mepd: true, medicaid: true }, active: true },
  { id: 'worker-10', firstName: 'Marcus', lastName: 'Jones', eaLevel: 2, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-11', firstName: 'Nina', lastName: 'Khan', eaLevel: 1, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-12', firstName: 'Tom', lastName: 'Lopez', eaLevel: 3, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-13', firstName: 'Grace', lastName: 'Martin', eaLevel: 1, programs: { snap: true, tanf: true, mepd: true, medicaid: true }, active: true },
  { id: 'worker-14', firstName: 'Omar', lastName: 'Nguyen', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
  { id: 'worker-15', firstName: 'Beth', lastName: 'Owens', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-16', firstName: 'Carlos', lastName: 'Perez', eaLevel: 2, programs: { snap: false, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-17', firstName: 'Dana', lastName: 'Quinn', eaLevel: 1, programs: { snap: true, tanf: true, mepd: false, medicaid: false }, active: true },
  { id: 'worker-18', firstName: 'Eric', lastName: 'Reed', eaLevel: 3, programs: { snap: true, tanf: false, mepd: false, medicaid: true }, active: true },
  { id: 'worker-19', firstName: 'Fatima', lastName: 'Silva', eaLevel: 1, programs: { snap: true, tanf: false, mepd: true, medicaid: false }, active: true },
  { id: 'worker-20', firstName: 'Henry', lastName: 'Tucker', eaLevel: 2, programs: { snap: true, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-21', firstName: 'Iris', lastName: 'Vance', eaLevel: 1, programs: { snap: false, tanf: true, mepd: false, medicaid: true }, active: true },
  { id: 'worker-22', firstName: 'Jack', lastName: 'Wong', eaLevel: 2, programs: { snap: true, tanf: false, mepd: false, medicaid: false }, active: true },
]

// --- Test login accounts. Emails/names default; passwords MUST come from env. ---
const SEED_USERS = [
  {
    email: process.env.SEED_CLERK_EMAIL || 'clerk@example.com',
    password: process.env.SEED_CLERK_PASSWORD,
    name: process.env.SEED_CLERK_NAME || 'Test Clerk',
    role: 'clerk',
  },
  {
    email: process.env.SEED_SUPERVISOR_EMAIL || 'supervisor@example.com',
    password: process.env.SEED_SUPERVISOR_PASSWORD,
    name: process.env.SEED_SUPERVISOR_NAME || 'Test Supervisor',
    role: 'supervisor',
  },
]

function requireEnv() {
  const missing = []
  if (!firebaseConfig.apiKey) missing.push('VITE_FB_API_KEY')
  if (!firebaseConfig.projectId) missing.push('VITE_FB_PROJECT_ID')
  for (const u of SEED_USERS) {
    if (!u.password) {
      missing.push(u.role === 'clerk' ? 'SEED_CLERK_PASSWORD' : 'SEED_SUPERVISOR_PASSWORD')
    }
  }
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}.\n` +
        `Set them in .env.local (Firebase passwords must be at least 6 characters).`,
    )
  }
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)
const auth = getAuth(app)

async function seedWorkers() {
  console.log(`Seeding ${WORKERS.length} workers (deterministic IDs, idempotent)...`)
  for (const w of WORKERS) {
    // Doc ID == w.id; the full object (incl. id) is stored verbatim.
    await setDoc(doc(db, 'workers', w.id), w)
  }
  console.log(`  wrote ${WORKERS.length} workers/* docs.`)
}

// Create the auth account, or recover its uid if it already exists, then write
// the users/{uid} role doc. Passwords are NEVER stored in Firestore.
async function seedUser({ email, password, name, role }) {
  let uid
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    uid = cred.user.uid
    console.log(`  created auth account ${email} (${role})`)
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      uid = cred.user.uid
      console.log(`  auth account ${email} already existed — recovered uid (${role})`)
    } else {
      throw err
    }
  }
  await setDoc(doc(db, 'users', uid), { uid, name, role })
  return { uid, name, role }
}

async function main() {
  requireEnv()
  console.log(`Project: ${firebaseConfig.projectId}\n`)

  await seedWorkers()

  console.log('\nSeeding 2 test login accounts...')
  const seededUsers = []
  for (const u of SEED_USERS) {
    seededUsers.push(await seedUser(u))
  }

  // --- Read back as proof of readability (DoD: read all 22 workers + accounts) ---
  console.log('\nReading back to verify...')
  const snap = await getDocs(collection(db, 'workers'))
  console.log(`  workers in Firestore: ${snap.size} (expected 22)`)
  const sample = snap.docs
    .map((d) => d.data())
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((w) => `${w.id}: ${w.firstName} ${w.lastName} (EA${w.eaLevel})`)
  console.log('  sample workers:')
  for (const line of sample) console.log(`    ${line}`)

  console.log('  users:')
  for (const u of seededUsers) {
    console.log(`    ${u.role.padEnd(10)} ${u.name} (uid ${u.uid})`)
  }

  if (snap.size !== WORKERS.length) {
    throw new Error(
      `Expected ${WORKERS.length} workers but read back ${snap.size}. Check the seed.`,
    )
  }

  console.log('\nSeed complete.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSeed FAILED:', err.message || err)
    process.exit(1)
  })

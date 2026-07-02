// src/lib/users.js — read-only access to the `users` login-account collection.
//
// `users` maps a Firebase Auth uid → { uid, name, role: 'clerk'|'supervisor' }.
// It is seeded out-of-band (scripts/seed.js) and NEVER written by the app — the
// Firestore rules deny all client writes to it. These readers back two things:
// the role lookup at login (getUserProfile) and the Log's clerkId→name join
// (subscribeUsers), mirroring the worker-name join already in Log.jsx.
//
// No client PII: a users doc holds only a staff member's name and role.

import { collection, doc, getDoc, onSnapshot } from 'firebase/firestore'

/**
 * One-shot read of a single login account by uid. Returns { uid, name, role }
 * or null when there is no role doc for this uid (an authed account with no app
 * role — the caller treats that as "not a valid app user").
 */
export async function getUserProfile(db, uid) {
  if (!uid) return null
  const snap = await getDoc(doc(db, 'users', uid))
  if (!snap.exists()) return null
  const data = snap.data()
  return { uid, name: data.name, role: data.role }
}

/**
 * Live subscription over the whole `users` collection, for resolving a clerkId
 * (a uid) to a display name in the Log. Hands `cb` an array of {id, ...data}
 * (id === the uid); `onError` (optional) receives a read error. Mirrors
 * subscribeWorkers.
 */
export function subscribeUsers(db, cb, onError) {
  return onSnapshot(
    collection(db, 'users'),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => onError && onError(err),
  )
}

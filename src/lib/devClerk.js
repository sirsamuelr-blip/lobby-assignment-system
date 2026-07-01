// src/lib/devClerk.js — a stable-per-tab clerk identity for the pre-auth phases.
//
// Two browser windows must read as two DIFFERENT clerks so the concurrency guard
// (Phase 3) can be exercised and each clerk's pending claim is attributed
// correctly. We mint one id per tab, backed by sessionStorage (survives reloads
// of the same tab, distinct across tabs/windows), with an in-memory fallback for
// environments where storage is blocked/unavailable (private mode, etc.).
//
// TODO(Phase 8): replace getDevClerkId() with auth.currentUser.uid once real
// per-person logins exist. Everything that writes a clerkId — the pending claim
// (pending.js) AND the assignment doc (assignments.js) — funnels through here.

const STORAGE_KEY = 'devClerkId'

// Per-load fallback so a single tab stays internally consistent even when
// sessionStorage throws (the two windows would then collide, but a page with no
// storage can't run the multi-clerk demo meaningfully anyway).
let memoryId = null

// crypto.randomUUID needs a secure context; getRandomValues does not. Falling
// back keeps a per-tab id minting on http / older browsers — the same insecure
// contexts the clipboard-copy fallback (Assign.jsx) is built for.
function mintId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A stable id for THIS browser tab. Stored in sessionStorage so it survives a
 * reload but differs across tabs/windows.
 * @returns {string}
 */
export function getDevClerkId() {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const minted = mintId()
    sessionStorage.setItem(STORAGE_KEY, minted)
    return minted
  } catch {
    if (!memoryId) memoryId = mintId()
    return memoryId
  }
}

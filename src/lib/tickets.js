// src/lib/tickets.js — sequential ticket-label logic, kept isolated as a pure,
// testable unit. The ticket is issued at ASSIGN time (assignments.js), not when a
// case goes Pending, so the sequence stays dense — only confirmed Assigns consume
// a number (abandoned or re-picked pending cases never burn one).
//
// The authoritative counter lives in Firestore at counters/tickets.next and is
// read+incremented inside the assignment transaction (see assignments.js). The
// MATH and FORMATTING live here as PURE functions so they're testable without
// Firebase and there's exactly one definition of "what's the next ticket".
//
// The ticket is a sequential LABEL only — never a case identifier and never PII.

// Where the authoritative counter lives. assignments.js reads/writes this doc
// inside its transaction; centralizing the location avoids drift.
export const TICKET_COUNTER = {
  collection: 'counters',
  doc: 'tickets',
  field: 'next',
}

// First ticket number when the counter doc doesn't exist yet.
export const FIRST_TICKET = 1

/**
 * Given the counter's current `next` value (or undefined/absent), return the
 * ticket to assign now and the value to persist back. Pure — the caller does
 * the actual Firestore read/write inside a transaction.
 *
 * @param {number|undefined} currentNext  stored counters/tickets.next, if any
 * @returns {{ticket: number, next: number}}
 */
export function advanceTicket(currentNext) {
  const ticket =
    Number.isInteger(currentNext) && currentNext >= FIRST_TICKET
      ? currentNext
      : FIRST_TICKET
  return { ticket, next: ticket + 1 }
}

/**
 * Display formatting for a ticket. The STORED value is the bare integer; this is
 * presentation only (e.g. confirmation banner, future Log tab).
 *
 * @param {number} ticket
 * @returns {string} e.g. "#0001"
 */
export function formatTicket(ticket) {
  return `#${String(ticket).padStart(4, '0')}`
}

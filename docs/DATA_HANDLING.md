# Data Handling

This document is a plain-language, field-by-field accounting of every piece of
data the Lobby Assignment System stores. It exists so that a program manager,
privacy officer, or IT/security reviewer can confirm the app's boundaries
without reading the code.

## Core principle

The app balances **staff workload**. To do that it needs to know about the
office's **advisors, clerks, and supervisors** — not about clients. It therefore
stores staff and operational data, and deliberately holds **no client PII**.

The one point of contact with the outside world is a case/ticket **reference
number** the clerk types in so an assignment can be traced back to EWMS. That
reference is an identifier the office already uses internally; the app stores the
number and nothing else about the case.

## What is stored (by collection)

All data lives in the office's own Firebase (Firestore) project.

### `users` — login accounts (staff)
| Field | Purpose |
| --- | --- |
| `uid`, `name`, `role` (`clerk` \| `supervisor`) | Identifies who can log in and what they may do. |

Contains **staff** names, not client data.

### `workers` — the advisor roster (staff)
| Field | Purpose |
| --- | --- |
| `firstName`, `lastName` | Names the advisor in suggestions, the Teams message, and the log. |
| `eaLevel` (1–3) | Drives the "EA3 is last resort" rule. |
| `programs` {snap, tanf, mepd, medicaid} | Which programs the advisor is trained for. |
| `active` | Whether the advisor is in the assignable pool. |

Contains **staff** (advisor) names and training flags, not client data.

### `unavailability` — supervisor-set absences (staff scheduling)
| Field | Purpose |
| --- | --- |
| `workerId`, `type` (wfh/pto/special_project/callout), `mode`, dates/weekday | Keeps unavailable advisors out of the pool on the right days. |

Staff scheduling only.

### `assignments` — the audit log (source of truth)
| Field | Purpose |
| --- | --- |
| `ticket` | The EWMS case/ticket **reference number** the clerk enters. Used only to trace the assignment back to EWMS. |
| `timestamp` | When the assignment was made; drives the weekly-count window. |
| `program` | Which program the case was for. |
| `workerId` | Which advisor was assigned. |
| `clerkId` | Which clerk recorded the assignment. |
| `manual` | Whether it was a manual override. |

This is the single source of truth for all counts and reports. It contains a
**case reference number**, but no client name, no case content, and no
eligibility information.

### `liveState` — ephemeral operational state
| Shape | Purpose | Lifetime |
| --- | --- | --- |
| pending { workerId, caseTicket, clerkId, suggestedAt, expiresAt } | Holds a suggested advisor out of the pool so two clerks can't double-book. | Auto-expires (~10 min). |
| temp-unavailable { workerId, reason, until } | Skips an advisor who said they can't take the case. | Auto-expires (~30 min). |

Short-lived operational state; nothing here is client PII.

## What is deliberately NOT stored

- Client names, SSNs, dates of birth, addresses, or phone numbers
- Case notes, documents, or application contents
- Eligibility determinations or benefit amounts
- Any live connection to EWMS or TIERS (there is none)

The client's name may be typed by the clerk into the **copy-paste Teams
message** so the receiving advisor knows whose case it is — but that message is
handed to Microsoft Teams and is **not persisted by this app**. The app stores
only the fields listed above.

## A note on the case/ticket number

The `ticket` field is the app's only reference to external case data. On its own
it is an internal case identifier, not client content — but whether a bare case
number is treated as sensitive can vary by agency policy. Before a pilot, we
recommend confirming with your office's privacy/records team how case reference
numbers should be handled, and restricting who can view the log accordingly.

## Retention

- `assignments` is retained as the historical fairness/audit record.
- `liveState` entries auto-expire and are not part of the permanent record.
- Counts and reports are **derived** from `assignments` (filtered by timestamp),
  so there is a single source of truth and nothing to reset by hand.

## Where the data lives

Everything is stored in the **individual office's own Firebase project**.
Instances do not share a database, and no data is sent to the maintainer or to
any third party beyond Google Cloud (Firebase's underlying provider) and, for
the assignment notification, the office's own Microsoft Teams.
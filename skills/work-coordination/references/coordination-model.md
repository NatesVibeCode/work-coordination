# Coordination model

What a record means, and what it deliberately does not.

## The fence (operator-ratified, 2026-08-27)

Work binding in an observation record is a declaration of **presence** toward
an outcome — "hey, I'm working on this outcome in this space. Not *you can't
work here*; just *I'm also here*."

Coordinates (worktree, repo, paths) are **shared space**. Same-worktree overlap
is a normal, expected condition that the observer exists to make visible early
— not a conflict to prevent.

**Nothing may be refused entry based on an observation record.**

**Capture ≠ promotion.** Observation feeds candidates only. Promotion stays
human-gated, always.

## The flow

```text
typed work
  → participating harness sessions
  → ephemeral communication groups
  → advisory messages
```

A harness is a port into work. It can launch, join, observe, or contribute a
message. It is not the center of the model.

## What the system does not do

- No ownership, claims-as-control, locks, leases, gates, assignment, or
  completion state.
- No stop, interrupt, resume, steer, or lifecycle actions.
- No prompt injection or transcript mutation.
- No network transport or harness configuration.
- No mandatory user-facing fields. Missing information is omitted or marked
  unknown; it never blocks work.

## Records

| Record | Written by | Means | Does not mean |
| --- | --- | --- | --- |
| Observation | `observe` | This session declared presence under this work, here | A claim on the work or the path |
| Message | `message` | Someone said this, advisably | An instruction that must be followed |
| Group | `group create` | An ephemeral address with an expiry | A team, a permission, or a boundary |
| Membership | `group join` | This session answers at this address | Entitlement to anything |
| Subscription | `subscribe` | Send this session's blocked/done reports there | A watch that can stop or steer anything |

## Statuses

`started` · `milestone` · `blocked` · `done`

Only `blocked` and `done` fan out to the subscribers of the reporting session. The other
two are recorded and readable. This vocabulary is shared with the
`harness-handoff` contracts and the `work-seam.dag.json` seam; a drift test
checks the package against the seam DAG (and against the handoff contract when
it is checked out beside this repo).

## Storage

A store is a `.work-coordination/` directory: `0700`, with `0600` JSON state
records inside. New observations, group memberships, messages, and mailbox
receipts are immutable per-record JSON. Mutable collections use a small
`<state-file>.journal/` of immutable JSON mutations and a deterministic fold.
Older JSONL and snapshot files remain readable; `state-status` identifies
legacy logs and reports damaged or conflicting records.

- No file lock, lease, session claim, or wait is used. A journal append is
  write-once. Independent entity changes merge; divergent changes to one
  entity remain in the journal and show as `state · conflict` instead of
  silently replacing each other. This is optimistic merge, not an atomic
  compare-and-swap.
- An incomplete or unknown JSON record is not treated as absent. Reads report
  `state · unknown` through `state-status`; mutation paths refuse a damaged
  journal. Each mutation journal is capped at 16,384 records and reports a
  state limit rather than growing without bound.
- Message filenames use SHA-256 of the complete sanitized message ID.
  Mailbox directories use SHA-256 of the complete normalized recipient and
  acknowledge each exact immutable message ID. Equal timestamps cannot hide
  a different message, and punctuation cannot collide through filename
  sanitization.
- New writes are JSON only. Expired message and outbox items, expired groups
  and subscriptions, and orphaned member records are reclaimed through their
  existing bounded retention paths. Legacy JSONL remains read-only.
- The outbox is advisory state, not a daemon: nothing drains it on a schedule,
  `retry` does, and a successful delivery retires pending work for that
  destination. A concurrent failure and success can remain uncertain; inspect
  `state-status` before treating a conflicting journal as settled.

## Expiry

Opt-in retention window on record **age**:

```sh
work-coordination init --expiry-ms 900000   # 15 minutes
work-coordination init --expiry-ms 0        # off (default)
```

Past the window, records are invisible everywhere (messages, sessions,
subscriptions, groups — it also caps group TTL) and stale message files are
reclaimed on the next send. Addressing something expired says so explicitly
(`work expired`, `group expired`, `subscription expired`); a missing record
says `unavailable`. Sending to an expired work is new activity: the work
revives with just the fresh record.

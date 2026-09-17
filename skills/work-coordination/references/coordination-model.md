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
| Subscription | `subscribe` | Send this lane's blocked/done reports there | A watch that can stop or steer the lane |

## Statuses

`started` · `milestone` · `blocked` · `done`

Only `blocked` and `done` fan out to subscribers of the same lane. The other
two are recorded and readable. This vocabulary is shared with the
`harness-handoff` contracts and the `work-seam.dag.json` seam; a drift test
checks the package against the seam DAG (and against the handoff contract when
it is checked out beside this repo).

## Storage

A store is a `.work-coordination/` directory: `0700`, with `0600` files
inside. It holds `participation.jsonl`, `messages/*.json`, `groups.json`,
`members.jsonl`, `subscriptions.json`, and optionally `config.json`.

- Observations and memberships are **append-only logs**. Readers fold them, so
  concurrent observers and joins cannot lose each other.
- Messages are one file per record; group and subscription records are
  compare-and-swap JSON.
- Writes are **lock-free**: read, compute, rename into place only if nobody
  wrote in between, retry briefly, then report a conflict. There is no lock
  file, no lease, no owner claim, and no writer ever waits on another.
- A store contains state records and nothing else — no scratch files, no
  lock artifacts.

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

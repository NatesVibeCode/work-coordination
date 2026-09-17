---
name: work-coordination
description: Coordinate concurrent agent sessions in a shared local tree using the work-coordination CLI or its MCP server — declare presence under typed work, send advisory messages, read a work's participants and messages, run ephemeral groups, and subscribe a session's blocked/done reports to a destination. Use when several sessions work the same tree and you need presence and advisory traffic without ownership, locks, assignment, or control over another session.
---

# Work coordination

Local, work-first coordination for concurrent agent sessions. You can declare
presence under typed work, send advisory messages, read what a work's
participants have said, run ephemeral groups, and subscribe a session's
`blocked`/`done` reports.

**Read this first:** this system carries *information*, never *authority*.

- A presence record is a declaration toward an outcome — "I'm also working
  here." It is **not** a claim, a reservation, or a lock. Nothing may be
  refused entry because a record exists.
- Nothing here assigns, gates, steers, interrupts, or completes work. If you
  need control over another session, this is the wrong tool.
- Capture feeds candidates only. Promotion is human-gated, always.

## Hard rules

1. **Never run `init` unless the user asked.** Init creates a private store
   inside their repository. If a tree has no store, coordination is simply
   unavailable there — that is a valid state, not a problem to fix.
2. **Never treat absence of an observation as permission, and never treat
   presence as a conflict.** Overlap is normal and expected.
3. **Only `blocked` and `done` fan out** to subscribers. `started` and
   `milestone` are recorded and readable; they notify nobody.
4. **Exit code 1 means your command was malformed** (unknown flag, unknown
   status, a bodyless message, a non-numeric timeout) — not "no work found."
   Read the message; do not retry the same shape. A legitimate answer such as
   `no sessions observed`, `unavailable`, or `expired` exits 0.
5. **Read-only commands never create anything.** `sessions`, `groups`,
   `subscriptions`, `work`, `group messages`, and `roadmap` answer from an
   empty tree without touching disk. Only `init` and the writing commands
   create the store.
6. **Do not invent flags.** Each command accepts a fixed set; a typo'd flag is
   rejected rather than folded into message text.

## Find out whether coordination is available

```sh
# A store exists in this tree (or an ancestor)?
ls -d .work-coordination 2>/dev/null || ls -d ../.work-coordination 2>/dev/null

# What is happening here right now?
work-coordination sessions
work-coordination groups
work-coordination subscriptions
```

If nothing is initialized, say so and continue with the work. Do not create a
store to make the output look better.

Where the store lives, in order: an explicit `--state <path>`, else the nearest
`.work-coordination` walking up from the current directory, else
`.work-coordination` in the current directory. There is **no home-directory
store** — coordination never leaves the tree you are standing in, so two
unrelated directories cannot see each other's sessions.

## Words that mean something specific

Four words are the whole vocabulary, and confusing them is the usual reason a
session cannot work out what to do.

| Word | What it is | What it is not |
| --- | --- | --- |
| **work** | A typed outcome reference (`"Ticket T-123"`). The join key everything hangs off. | Not a tracker, not a ticket system, not a status board. A string. |
| **session** | The identity a harness reports for one running thing (`codex:parser`). This is what `--session` takes and what a participant list shows. | Not a lane, not a role, not a person. |
| **group** | An ephemeral address with an expiry that sessions can join, so one message scoped to it reaches all of them. | Not a team, not a permission, not a boundary, not durable. |
| **subscription** | "Send this session's `blocked`/`done` reports to that destination." Made by `subscribe`. | Not a watch, not a hook, nothing that can steer anything. |

**A lane is none of these.** A lane is a process the host harness spawns —
`harness-handoff`'s word. This tool has no lane command, no lane object, and no
lane state. A spawned lane reports itself as a *session*, and that session is
all work-coordination ever sees. Anything about spawning, managing, or listing
lanes belongs to the harness, not here. (Your fleet also calls a discovery
query config in `lanes/<name>.json` a "lane" — a third, unrelated meaning. Ask
which one is meant.)

So when a work has several things on it, you do not "add a lane" here: you
`observe` each session under the work, and optionally `subscribe` one.

## The four moves

### 1. Declare presence

```sh
work-coordination observe \
  --work "Ticket T-123" \
  --session codex:one \
  --harness codex
```

One observation per (session, work). Re-observing the same pair updates it
rather than accumulating. `--directory` defaults to the current directory; the
worktree is resolved from git when available.

### 2. Send an advisory message

```sh
work-coordination message "Tokenizer now returns spans." \
  --work "Ticket T-123" \
  --from "Codex / parser-repair" \
  --session codex:one \
  --status milestone
```

Statuses: `started`, `milestone`, `blocked`, `done`. Omit `--status` for a
plain advisory. Scope it to a group instead of work with `--group <ref>`.

Deliver through a harness transport only when the user wants a real send
(`codex`, `pi`, and `hermes` have verified local seams; anything else reports
unavailable):

```sh
work-coordination message "Auth wall, need creds." \
  --work "Ticket T-123" \
  --from "Codex / parser-repair" \
  --session codex:parser \
  --status blocked \
  --to codex:<thread-id> \
  --deliver
```

Delivery is best-effort and bounded by a 60s idle timeout
(`--idle-timeout-ms` overrides it). A failed send is reported, never fatal.

### 3. Read state

```sh
work-coordination work "Ticket T-123"   # participants + messages for one work
work-coordination sessions              # observed sessions
work-coordination groups                # active groups
work-coordination subscriptions         # who reports where, and to whom
```

`work` answers `no work context observed` when there is nothing, and
`work expired` when records existed but aged past the store's retention
window. Prefer `work` over guessing from `sessions`.

### 4. Groups and subscriptions

```sh
work-coordination group create parser-work
work-coordination group join <group-ref> codex:one
work-coordination group messages <group-ref>
work-coordination ungroup <group-ref>

work-coordination subscribe --session codex:parser --work "Ticket T-123" --to hermes:ops
work-coordination subscriptions
work-coordination unsubscribe <subscription-id>
```

Groups expire (one hour by default). A join to an expired or unknown group is
refused with `group unavailable` / `group expired` — it does not resurrect the
group.

## Syntax rules worth knowing

- `--flag value` and `--flag=value` both work.
- A bare `--` ends flags, so a body may begin with a dash:
  `message --work "T-1" -- "-dash body"`. Without it, a body token starting
  with `-` is read as a flag and the call fails with `unknown flag`.
- A flag value may not start with a dash: `--work -x` is refused instead of
  quietly storing a work ref named `-x`.
- A repeated flag is an error, not last-wins.
- `--state <path>` works before or after the subcommand and pins the store
  explicitly; without it, the nearest `.work-coordination` walking up from the
  current directory is used.
- Output is one record per line. Fields are folded to a single line, so a
  newline in your text cannot forge a record.
- Re-observing the same work as the same session inside a short window says
  nothing new and is not appended again; outside it, the observation is
  re-declared so the session still reads as recently active.

## Expiry

A store may have an optional retention window on record **age** (not activity).
When one is set, records older than the window are invisible everywhere and
stale message files are reclaimed; the window also caps a group's TTL. Default
is off — a store keeps everything for audit. You cannot tell from the outside
whether it is on; `work expired` / `group expired` / `subscription expired`
means records existed and aged out, `unavailable` means nothing was there.

## When to use the MCP server instead

If the user's client already has the MCP server registered, prefer its tools
over shelling out — same operations layer, same wording, one process, no PATH
dependency. Tools: `trees_list`, `observe`, `message`, `sessions`, `work`,
`groups`, `group_create`, `group_join`, `group_messages`, `ungroup`,
`subscribe`, `unsubscribe`, `subscriptions`, `roadmap`, `pending`, `retry`.
Every tool takes a tree *name* (never a path). See `references/mcp-setup.md`.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `unknown flag · --x` / exit 1 | Malformed call. Fix the flag; the accepted set is printed. |
| `unknown status · x` / exit 1 | Not one of `started`, `milestone`, `blocked`, `done`. |
| `message needs a body` / exit 1 | A record with no text carries nothing. |
| `nothing to do — try: ...` | No command given. |
| `no sessions observed` | Store exists, nothing declared. |
| `no work context observed` | Nothing for that ref. |
| `work expired` | Records existed, past the retention window. |
| `group unavailable` | No such active group (or the join was refused). |
| `delivery unavailable · ...` | Transport missing, exited nonzero, or stalled past its timeout. Advisory record was still stored. |
| `no verified local message transport for X` | That harness has no verified seam. Do not fake it. |

Details: `references/cli-contract.md` (exact verbs, flags, exit codes) and
`references/coordination-model.md` (what a record does and does not mean).

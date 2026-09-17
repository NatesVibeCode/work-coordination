# work-coordination

Local, work-first coordination for concurrent agent sessions.

**Operator-ratified fence (2026-08-27):** work binding in an observation record is a declaration
of PRESENCE toward an outcome — "hey im working on this outcome in this space. Not you cant
work here, just im also here." Coordinates (worktree, repo, paths) are shared space; same-worktree
overlap is a normal, expected condition the observer exists to make visible early, not a conflict
to prevent. Nothing may be refused entry based on an observation record. Capture ≠ promotion:
observation feeds candidates only; promotion stays human-gated, always.

```text
typed work
  → participating harness sessions
  → ephemeral communication groups
  → advisory messages
```

A harness is a port into work. It can launch, join, observe, or contribute a message. It is not the center of the model.

## Quickstart

```sh
npm link                          # puts `work-coordination` on your PATH
cd /path/to/your/repo
work-coordination init            # creates .work-coordination/ here, private
work-coordination observe --work "Ticket T-123" --session codex:one --harness codex
work-coordination message "Tokenizer now returns spans." \
  --work "Ticket T-123" --from "Codex / parser-repair" --status milestone
work-coordination work "Ticket T-123"   # participants + what they said
```

That is the whole loop: declare presence, say something advisory, read it back.
Nothing here assigns, blocks, or controls another session, and a read-only
command never creates state — so asking a question is always safe.

Driving this from an agent? `skills/work-coordination/` is the playbook for it
(when to use it, the four moves, the hard rules, and the syntax that is easy to
get wrong).

## What exists now

- Local private state (`0700` directories, `0600` files, atomic replacement, and lock-free optimistic concurrency — a contended update retries and then fails loudly; nothing ever locks, leases, or waits).
- Work views that collect observed session participation under a typed work reference.
- Read-only roadmap views that overlay those observations beside one live `roadmap_items` row; they cannot write roadmap state or control a session.
- Ephemeral groups with expiry.
- Local advisory message records and work-scoped/group-scoped message readback.
- Explicit native delivery adapters:
  - Codex through `codex queue`.
  - Pi through its opt-in session-control socket.
  - Hermes through `hermes peer dm`.
  - Claude returns unavailable until a verified local send seam exists.
- Failed deliveries are queued, not lost: `pending` lists them with the
  provider's own explanation, `retry` tries them again.
- Compact message rendering:

  ```text
  Work message · #m_4f2a91c7b3
  Ticket T-123 · from Codex / parser-repair
  advisory — use if relevant; otherwise continue.
  Tokenizer now returns spans. I’m updating callers; keep validation and flag breaks.
  ```

- A standalone Node CLI. It does not configure, hook, or alter any harness.

## What it does not do

- No ownership, claims-as-control, locks, leases, gates, assignment, or completion state.
- No stop, interrupt, resume, steer, or lifecycle actions.
- No prompt injection or transcript mutation.
- No network transport or harness configuration.
- No mandatory user-facing fields. Missing information is omitted or represented as unknown; it does not block work.

## Install

From this checkout:

```sh
npm link
```

That exposes `work-coordination` on your local PATH. No daemon starts and no repository changes happen from installation. (The `mcp/` server skips this step entirely — it calls the same operations in-process.)

## Run it

Initialize deliberately anywhere inside a Git worktree (it resolves the worktree root):

```sh
work-coordination init
```

This creates `.work-coordination/`, gives it private permissions, and adds that directory to the repository's local `.git/info/exclude` file. It does **not** change the tracked `.gitignore`. Outside Git, it uses the current directory and simply skips the local exclude entry.

Once initialized, commands run from that repository or its subdirectories use its local state automatically. `--state <path>` remains available when you want an explicit state location.

Without a store, nothing reaches outside the directory you are in: the nearest
`.work-coordination` walking up wins, and with none the store is
`.work-coordination` right here. There is deliberately no home-directory
fallback — one shared pool made two unrelated uninitialized directories see
each other's sessions and messages.

```sh
work-coordination \
  observe --work "Ticket T-123" --session codex:one --harness codex

work-coordination \
  message "Tokenizer now returns spans." \
  --work "Ticket T-123" \
  --from "Codex / parser-repair" \
  --status milestone

work-coordination \
  observe --work "Ticket T-123" --session codex:one --harness codex

work-coordination \
  work "Ticket T-123"

# Read one live roadmap item and overlay only observed local participation.
# Optional: this needs your own psql and a roadmap_items table. See below.
work-coordination \
  roadmap <your-roadmap-key>

work-coordination \
  sessions

work-coordination \
  group create parser-work

work-coordination \
  group join <group-ref> codex:one

work-coordination \
  message "Tokenizer now returns spans." --group <group-ref>

work-coordination \
  group messages <group-ref>

# Explicitly deliver through a verified native transport.
# Every transport carries a 60s idle timeout: output resets it, silence
# past it reports delivery unavailable. A hang never blocks the sender.
work-coordination \
  message "Tokenizer now returns spans." \
  --work "Ticket T-123" \
  --to codex:<thread-id> \
  --deliver

work-coordination \
  ungroup <group-ref>

# Anyone may subscribe a session's reports to a destination. A blocked or
# done report fans out to them through their transports; failures are
# reported, never fatal, and nothing ever waits.
work-coordination \
  subscribe --session codex:parser --work "Ticket T-123" --to hermes:ops

work-coordination \
  subscriptions

work-coordination \
  message "Auth wall, need creds." \
  --work "Ticket T-123" \
  --from "Codex / parser-repair" \
  --session codex:parser \
  --status blocked

work-coordination \
  unsubscribe <subscription-id>

# A delivery that did not land is queued, with what the provider said.
# Nothing retries on its own — you drain it when the provider is back.
work-coordination \
  pending

work-coordination \
  retry
```

New subscribers miss already-sent reports (fan-out is live, never replayed).
Catch up with `work "<ref>"` and `subscriptions`. With no retention window set
(the default) every message persists for audit; a store that opted into
[expiry](#expiry-optional) forgets records older than its window.

`observe` is the adapter seam. A future typed-workflow or native harness adapter calls it with what it observed. It does not ask an agent to self-report or name its own work.

## Verify

The root suite covers the CLI, the operations layer, and the store. The MCP
protocol suite additionally needs the MCP SDK, and `mcp/node_modules` is not
committed, so a fresh clone has to install it first:

```sh
npm test                       # CLI + operations + store
cd mcp && npm install && npm test && cd ..   # + the MCP protocol suite
```

Without that install the MCP protocol file reports itself as **skipped**, with
the reason and the command to fix it. A green root run therefore never implies
MCP coverage it did not get.

## Roadmap reads (optional)

`roadmap <key>` reads one row from a `roadmap_items` table and overlays local
observed participation beside it. That is optional local infrastructure, not a
dependency: it runs whatever psql command you point it at, and if there is no
database it says `roadmap unavailable` and coordination continues normally.

```sh
WORK_COORDINATION_ROADMAP_PSQL="psql mydb" work-coordination roadmap <key>
```

## Expiry (optional)

A store can forget. Set a retention window in milliseconds — `900000` is
15 minutes — and records older than the window become invisible everywhere:
messages, observed sessions, subscriptions, and groups (this caps the group
TTL). Stale message files are reclaimed when new messages arrive, per-file,
so pruning never disturbs a concurrent writer; backdated sends older than
the window are dropped on arrival.

```sh
work-coordination init --expiry-ms 900000   # opt this store in
work-coordination init --expiry-ms 0        # opt back out
```

Plain `init` never touches an existing setting, and a store without one
keeps everything for audit — that is the default. Two things to know:

- Expiry is a retention window on record **age**, not an activity timeout.
  A busy work still loses its old records; after 15 quiet minutes, all of
  them are gone. If you want per-work activity expiry instead, say so —
  that is a different feature.
- Addressing something expired says so explicitly — `work expired`,
  `group expired`, `subscription expired` — instead of `unavailable`.
  Expired is not bad data: the records aged past the window, nothing is
  corrupt. Collection listings (`sessions`, `groups`, `subscriptions`)
  still report the visible set plainly; only single-item lookups
  distinguish. Sending to an expired work is new activity: the work
  revives with just the fresh record.
- The MCP server honors the same store setting automatically; there is
  nothing to configure on its side.

## Also in this repo

- `mcp/` — an MCP server exposing these operations as tree-scoped tools
  with per-tree visibility config. It calls `src/operations.mjs` in-process —
  the same layer the CLI uses. See `mcp/README.md`. (The server has no
  runtime install of its own; only its test suite needs the SDK.)
- `work-seam.dag.json` — the shared vocabulary between this package and the
  `harness-handoff` contracts. `npm test` checks the two against each other
  when `harness-handoff` is checked out as a sibling; without that checkout
  the check reports itself as skipped rather than green, and
  `WORK_COORDINATION_HANDOFF_CONTRACT` points it at a copy elsewhere.
- `skills/work-coordination/` — the agent-facing playbook: `SKILL.md` plus
  `references/` for the CLI contract, the coordination model, and MCP setup.
  Install it as `<workspace>/.agents/skills/work-coordination/`, the same
  layout the fleet skills use. `npm test` checks every command and flag it
  shows against the CLI's own table, so it cannot drift into fiction.

## Known limits

- Delivery is best-effort through local harness CLIs (`codex`, `pi`,
  `hermes`). A send that stalls past its idle timeout is reported, never
  fatal, and never blocks the other recipients.
- A failed delivery is queued rather than lost: `pending` shows it (with the
  provider's own explanation) and `retry` re-sends it. There is no daemon and
  no timer, so it is drained when you ask, not on a schedule. The queue holds
  at most 200 entries, oldest first, and drops entries whose record has aged
  out of the store.
- Concurrency is lock-free: a contended write retries and, if it still
  cannot land, reports a conflict. Nothing waits on a lock, because there
  are none to wait on.
- Roadmap reads need your own psql and table (above); they are read-only.
- Group membership and observations are append-only logs; removal of a group
  prunes its log, and expiry reclaims stale message files.

## License

Source-available under the [Work Coordination Community License](LICENSE):
free for personal or business use; selling something built on top needs a
commercial license.

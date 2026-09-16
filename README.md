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

## What exists now

- Local private state (`0700` directories, `0600` files, atomic replacement, and serialized local mutations).
- Work views that collect observed session participation under a typed work reference.
- Read-only roadmap views that overlay those observations beside one live `roadmap_items` row; they cannot write roadmap state or control a session.
- Ephemeral groups with expiry.
- Local advisory message records and work-scoped/group-scoped message readback.
- Explicit native delivery adapters:
  - Codex through `codex queue`.
  - Pi through its opt-in session-control socket.
  - Hermes through `hermes peer dm`.
  - Claude returns unavailable until a verified local send seam exists.
- Compact message rendering:

  ```text
  Work message · #m_7k3p
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

That exposes `work-coordination` on your local PATH. No daemon starts and no repository changes happen from installation.

## Run it

Initialize deliberately anywhere inside a Git worktree (it resolves the worktree root):

```sh
work-coordination init
```

This creates `.work-coordination/`, gives it private permissions, and adds that directory to the repository's local `.git/info/exclude` file. It does **not** change the tracked `.gitignore`. Outside Git, it uses the current directory and simply skips the local exclude entry.

Once initialized, commands run from that repository or its subdirectories use its local state automatically. `--state <path>` remains available when you want an explicit state location.

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
work-coordination \
  roadmap roadmap.boat.foundation.architecture_contracts.v1

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

# Anyone can subscribe to a lane. A blocked or done report fans out
# to that lane's subscribers through their transports; failures are
# reported, never fatal, and nothing ever waits.
work-coordination \
  subscribe --session lane-1 --work "Ticket T-123" --to hermes:ops

work-coordination \
  subscriptions

work-coordination \
  message "Auth wall, need creds." \
  --work "Ticket T-123" \
  --from "Codex / lane-1" \
  --session lane-1 \
  --status blocked

work-coordination \
  unsubscribe <subscription-id>
```

New subscribers miss already-sent reports (fan-out is live, never replayed).
Catch up with `work "<ref>"` and `subscriptions` — every message persists.

`observe` is the adapter seam. A future typed-workflow or native harness adapter calls it with what it observed. It does not ask an agent to self-report or name its own work.

## Verify

```sh
npm test
```

## Also in this repo

- `mcp/` — an MCP server exposing this CLI as tree-scoped tools with
  per-tree visibility config. Lives here so the protocol and the tool ship
  together; see `mcp/README.md`.
- `work-seam.dag.json` — the shared vocabulary between this package and the
  `harness-handoff` contracts. The drift test (`npm test`) fails if the two
  drift apart.

## License

Source-available under the [Work Coordination Community License](LICENSE):
free for personal or business use; selling something built on top needs a
commercial license.

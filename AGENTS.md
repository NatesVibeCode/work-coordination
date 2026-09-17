# Agent instructions — work-coordination

Local, work-first coordination for concurrent agent sessions. Two frontends
(`bin/work-coordination.mjs` and `mcp/`) over one operations layer
(`src/operations.mjs`), backed by a lock-free store.

Read this before changing anything. These are the rules the code depends on and
the ones a fresh session gets wrong.

## The invariants

**1. No locking. Ever.** No lock file, no lease, no owner/PID claim, no reclaim
marker, no advisory lock, and no path where one writer waits on another. The
store is lock-free optimistic concurrency: read, compute, rename into place only
if nobody wrote in between, retry briefly, then throw and report it. If you find
yourself reaching for a mutex or a `.lock` file, the answer is a compare-and-swap
in `src/atomic-json.mjs`. `test/no-locking.test.mjs` walks a store after a full
cycle and fails on any non-state artifact.

**2. A store holds state records and nothing else.** No scratch files, no
temporaries left behind, no sidecars. Every replacement goes through
`replaceFile`/`replaceJsonFile`/`reviseJsonFile` in `src/atomic-json.mjs`, which
use a unique scratch name (pid + thread + counter + random) and clean up on a
failed rename. Never hand-roll `${path}.${pid}.tmp` — that collision was a real
bug twice.

**3. One implementation, two frontends.** All behaviour lives in
`src/operations.mjs` and `src/state.mjs`. The CLI parses argv and prints; the MCP
server registers tools and returns text. Neither may implement coordination
logic. If you add an operation, add it to the layer, then expose it in *both*
frontends — a CLI-only command is a bug (that is exactly how `pending`/`retry`
shipped broken once).

**4. Exit 1 means the call was malformed, not that nothing was found.** Unknown
flag, repeated flag, unknown status, bodyless message, non-numeric timeout → one
clean line + exit 1. A legitimate answer — `no sessions observed`,
`unavailable`, `expired`, `no pending deliveries` — exits 0. Callers are told to
branch on this, so do not blur it.

**5. Presence is not authority.** Nothing here assigns, gates, locks, steers or
completes anything. An observation is a declaration of presence; overlap is
normal and must never refuse entry. Do not add a mechanism that lets a record
control another session.

**6. Every fix gets a test.** Prefer a test that fails before the fix and passes
after. For docs and skills, assert the claim against the CLI's own tables rather
than trusting the prose — `test/skill-contract.test.mjs` reads the command table
out of `bin/` and fails if the skill shows an invented command, flag, or mode.

**7. Never rewrite published history.** The repo is public and `main` has been
pushed. Report a history problem; do not force-push it away.

## Layout

| Path | Holds |
| --- | --- |
| `bin/work-coordination.mjs` | argv parsing, flag tables, exit codes, printing |
| `src/operations.mjs` | the operations the CLI prints and the MCP server returns |
| `src/state.mjs` | store resolution, records, groups, subscriptions, fan-out |
| `src/atomic-json.mjs` | lock-free replacement primitives (start here) |
| `src/coordination.mjs` | record shapes, `oneLine` sanitizer, `destinationOf` |
| `src/delivery.mjs` | harness transports, idle timeout, bounded fan-out |
| `src/outbox.mjs` | deliveries that did not land |
| `mcp/src/` | config resolution, tool registration, tree-scoped runner |
| `skills/work-coordination/` | the agent-facing playbook (see below) |
| `test/` | Node test runner; `npm test` runs all of it |

## Commands

```sh
npm test                      # root suite: CLI, operations, store, skills
cd mcp && npm install && npm test   # MCP protocol suite (needs the SDK)
```

The MCP suite reports itself **skipped** when `mcp/node_modules` is absent, so a
green root run does not prove MCP coverage. CI installs the SDK and fails if
anything skips there; locally, read the skip count rather than the colour.

## Two things that bite

**Text is a protocol.** Output is one record per line, and every user-supplied
field goes through `oneLine()` before it is stored *and* before it is rendered.
A newline in a work ref, sender, session id, group name or body used to forge a
record line. Keep both halves: sanitize on write, sanitize on render (legacy
stores still hold unsanitized records).

**Destinations are case-folded.** `<harness>:<session>` is parsed by
`destinationOf()` in exactly one place and both halves are lowercased. Three
call sites splitting that string independently is how one recipient became two
subscriptions delivering twice.

## The skill is part of the product

`skills/work-coordination/` is not documentation *about* the tool; it is what an
agent reads to use it, and it is installable as
`<workspace>/.agents/skills/work-coordination/`. Two rules:

- **The vocabulary table is load-bearing.** "lane" is *not* one of our words — a
  lane is a process the host harness spawns (`harness-handoff`'s term), and this
  tool only ever sees the session it registers as. A session read a version of
  this skill that said "subscribe a lane" and could not work out what to do.
- **Claims are checked.** Anything the skill asserts about commands, flags, read
  vs write modes, or capabilities it deliberately lacks is pinned by
  `test/skill-contract.test.mjs`. Update the skill and the test together, or the
  suite will tell you.

## When you finish

State what you changed, the command you ran, and what it printed. If something
is untested — a real `codex`/`pi`/`hermes` transport, a client's rendering, a
person's experience — say so rather than implying it was verified. A green suite
proves the suite, not the feature.

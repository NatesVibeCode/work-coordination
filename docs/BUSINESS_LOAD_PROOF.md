# Advisory state concurrency proof

This document records the WorkCoord portion of the 5C-load effort. WorkCoord
stores observations and advisory messages. It does not schedule, authorize,
gate, claim, or complete a business Process. A recorded presence is metadata;
overlap between sessions is allowed.

## Persistence model

Mutable JSON projections are updated through an immutable JSON mutation journal
in `src/atomic-json.mjs`. A mutation records only the entity changes, its
parent revisions, and the digests needed to validate the change. Readers fold
the journal deterministically. Independent entity edits survive concurrent
writes. A same-entity divergent revision is retained and reported as a
conflict. A caller supplying an expected revision receives a typed conflict
when that revision is stale.

This is **not** a cross-process compare-and-swap. The implementation does not
claim that a read and later append form one atomic conditional write. A race is
preserved as journal history and reported as a conflict instead of silently
replacing an accepted writer's state. The journal is capped at 16,384 mutation
records. Reaching the cap returns a typed limit error; there is no implicit
history rewrite or lock-based reclamation.

Completed immutable records are published by exclusive hard link from a
unique scratch file. Completed file bytes and the published directory entry are flushed before acknowledgement. A post-publication durability error is reported as `STATE_DURABILITY_UNKNOWN`, preserving the published record. Scratch files are removed after publication or on a failed publish. Unpublished scratch bytes do not enter the state fold or gate another writer; the diagnostic reports them as an incomplete store observation. JSON state records are the only durable store contents. A
truncated, unknown, malformed, conflicting, or crash-left scratch record is
reported as a state gap; reads do not reinterpret unknown state as empty.

Messages and presence observations use stable full-identity hashes. Mailbox
acknowledgements are immutable receipts keyed by the exact recipient and
message ID, so equal timestamps and reordered delivery do not drop messages.
Destinations are case-folded in the shared `destinationOf()` helper. All
user-supplied text is normalized with `oneLine()` both when stored and when
rendered.

## Read-only diagnostic

The CLI and MCP frontends share `stateStatus()` in `src/operations.mjs`:

```sh
node bin/work-coordination.mjs --state /path/to/existing-store state-status
```

This command reads without creating the store or changing records. It prints
`state · consistent` for a clean store, or bounded `state · conflict`,
`state · gap`, and legacy-record lines. MCP exposes the same read-only
operation as `state_status`.

## Local concurrency checks

`test/concurrent-state.test.mjs` exercises real local child processes and
temporary state stores. It starts 24 CLI business-case writers concurrently,
then reads all 24 cases from the shared state. It also checks stale conditional
revision reporting, equal-time message acknowledgements across a restart,
punctuation-distinct recipient identities, malformed and truncated state
records, a read-only CLI `state-status` call against a missing store, and
immutable identity collision handling.

The existing suite additionally checks expiry, policy, outbox retry, mailbox,
business-case, CLI/MCP protocol, and the no-lock/no-leftover-artifact store
walk. Re-run the repository checks with:

```sh
npm test
cd mcp && npm test
```

The root `npm test` run includes CLI, operations, storage, and skill-contract
tests. It does not prove MCP protocol coverage when the MCP suite is skipped;
the separate MCP command must run with the SDK installed. These checks do not
exercise a real Codex, Pi, or Hermes transport or any client's rendering.

Final local run on 2026-10-04 (America/Los_Angeles):

- `npm test` — 165 tests, 164 passed, 0 failed, 1 skipped. The skip reports
  that the optional sibling `harness-handoff/skills-src/contracts.json` file
  was not checked out.
- `cd mcp && npm test` — 19 tests, 19 passed, 0 failed, 0 skipped. This is
  the actual MCP protocol suite.

The tests demonstrate the tested local Node.js implementation. They do not
make WorkCoord an execution manager and do not qualify any printed Process,
executor family, provider, or remote service.

Parent post-integration checks add regressions for unpublished-record diagnostics without an implicit writer gate and prototype-named JSON keys staying ordinary data. The parent also flushes file/directory bytes before acknowledging publication. Current complete CLI/MCP check logs and exact source pins are retained under campaign `5C-load/parent-*`; the original lane totals above retain their original source subject.

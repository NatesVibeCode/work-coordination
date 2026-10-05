# Business case advisory observations

`src/business-cases.mjs` accepts only the bounded SDK advisory view
`praxis.business_case_advisory_view.v1`. It does not execute a Process, inspect
paths, verify receipt contents, or determine policy. The Process owner's
trusted snapshot supplies case disposition; SDK execution values remain in a
separate `execution_results` section.

## Reusable operations

```js
import {
  recordBusinessCaseOp,
  readBusinessCaseOp,
  listBusinessCasesOp,
} from "./src/business-cases.mjs";

recordBusinessCaseOp(store, sdkView, { destination: "Codex:session-7" });
readBusinessCaseOp(store, "supplier:substitution", 3);
listBusinessCasesOp(store);
```

Lower-level exports are `recordBusinessCase`, `readBusinessCases`,
`findBusinessCase`, `renderBusinessCase`, and `canonicalDestination`. They let
the CLI and MCP frontends share the same storage and rendering logic.

Each record keeps the exact case ID/revision, SDK dispositions, pinned Process
and contract references, original invocation/input/receipt references,
execution-result references, missing outcomes, and explicit operator choices.
Opaque receipt refs are text only; no function dereferences them. Unknown,
refused, partial, and superseded remain visible. A zero exit or settled state
never changes the case disposition.

When a destination is supplied, both `<harness>:<session>` components go
through the shared `destinationOf()` parser and are lowercased. Every supplied
and rendered text value passes through `oneLine()`, with UTF-8 byte bounds.

## Storage and coordination posture

The module uses `<store.directory>/business-cases.json.journal/` as an
immutable JSON mutation journal. Each record stores a bounded entity patch and
the reader folds independent record IDs deterministically. Concurrent writes
to different observations merge; conflicting writes to the same observation
remain in state and are reported as conflicts. This is optimistic merge, not
an atomic compare-and-swap. Each mutation journal is capped at 16,384 records;
at the bound, a write reports a typed state limit instead of discarding older
history. `state-status` reports invalid, truncated, and conflicting records.
Repeated views from separate destinations remain separate records; no
observation assigns a participant, acquires a lock or lease, claims writer
ownership, grants authority, or controls completion. A missing or invalid SDK
view is refused before any state write.

The CLI exposes `business-case-record --view <json> [--to <destination>]`,
`business-case-read <case-id> [--revision <n>]`, and `business-cases`.
MCP exposes `business_case_record`, `business_case_read`, and `business_cases`
within the caller's visible configured tree. The real CLI and MCP protocol
checks cover these registrations and hidden-tree refusal. Their stored text
remains advisory; recording a claimed disposition does not authenticate it or
grant Process or case authority.

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

The module appends a JSON observation to
`<store.directory>/business-cases.json` using the existing lock-free
`reviseJsonFile()` revision helper. Its current read/check/rename sequence does
not establish atomic compare-and-swap across independent writers; concurrent
durability remains pending the campaign's 5C storage work. It stores state JSON only and leaves temp
cleanup to `atomic-json.mjs`. Repeated views from separate destinations remain
separate records; no observation assigns a participant, acquires a lock or
lease, claims writer ownership, grants authority, or controls completion.
Records are advisory and bounded. A missing or invalid SDK view is refused
before any state write.

The CLI exposes `business-case-record --view <json> [--to <destination>]`,
`business-case-read <case-id> [--revision <n>]`, and `business-cases`.
MCP exposes `business_case_record`, `business_case_read`, and `business_cases`
within the caller's visible configured tree. The real CLI and MCP protocol
checks cover these registrations and hidden-tree refusal. Their stored text
remains advisory; recording a claimed disposition does not authenticate it or
grant Process or case authority.

# Native work connections

Mdviewer owns the selected task and source pins. Native sessions own execution.
Work-coordination retains optional associations and advisory observations in the
explicit local JSON store. It never selects the newest session, starts a host,
resumes paused work, or turns native progress into completion evidence.

The existing `handoffBinding`/`handoff-association` v1 names are source metadata
contracts. Using them does not depend on harness-handoff.

## Prepare and connect

Obtain a task binding from `mdview section work INDEX SECTION --store STORE
--task TASK`. Keep its complete `handoffBinding`, including the task hash,
`expectedReadSet` and `expectedEdition`. Separately select the native surface,
exact session ID and an attempt ID. Never use a todo position as the task ID.

An observation request has this shape; `handoffBinding` is the complete value
returned by Mdviewer, not the illustrative empty object below.

```json
{
  "identity": {
    "handoffBinding": {},
    "destination": {"selection": "operator-explicit", "surface": "codex", "sessionId": "EXACT_THREAD_UUID"},
    "attempt": {"id": "attempt-1"}
  },
  "workspace": "/absolute/native/workspace",
  "native": {}
}
```

`--request` also accepts `@REQUEST.json` or `-` to read stdin, avoiding the
operating system's argument-size ceiling for large source pin sets.

`native-observe --request <JSON>` appends the selected snapshot. Codex uses its
local native metadata and paginated visible-history databases. `native.codexHome`
can explicitly select a native home; otherwise current `CODEX_HOME`/native home
applies. Unsupported schemas return unavailable/partial facts, not guessed
activity. Turn status, goal status and client presence remain separate.

OpenCode uses `export EXACT_ID --sanitize --pure` into private temporary
regular-file stdout, avoiding this native CLI's large piped-export truncation.
The scratch export is removed after projection. Sanitized directory fields are
verified against the exact read-only native metadata row; `native.opencodeDataHome`
can explicitly select the native XDG data root. Add `native.endpoint` only
for an explicitly selected, already running native HTTP(S) endpoint. Todo and
activity remain unknown without that endpoint; nothing starts one. Result
references preserve native identities and digests, not transcript copies.

AOA accepts `native.snapshot` from `Session.ObserveConnection` or
`agenthost.ReadConnectionObservation`. Its workspace is caller-explicit because
the ledger does not attest a workspace. Session and RunRef remain separate.

Identical snapshots reuse the first observation and timestamp. Changed native
values append distinct observations. Source drift refuses a new observation;
old attempts remain readable under their original source binding.

## Read and render

`association-snapshot --request <JSON>` takes `{handoffBinding, workspace}` and
returns `work-coordination.association-snapshot` v1. It includes historical
attempts, stale-source comparisons, observations and feedback receipts, without
creating a missing store. The native workspace must match the selected CLI/MCP
filetree. The explicitly pinned source package is independent of that execution
workspace; its complete read set remains confined to its own canonical package. Existing visibility policy applies to these native operations.

Pass that snapshot file to `mdview connection render`. Opening its HTML performs
no native read, network request, delivery or check execution. Refresh explicitly.

Source-byte freshness is only byte freshness. Mdviewer independently compares
the complete current binding and publication edition before reconciliation or
feedback. Native completed turns/todos never satisfy Mdviewer checks.

## Feedback and receipts

`association-feedback --request <JSON>` takes `{identity, workspace, requestId,
body, native?}`. The association must exist and source bytes must still match.
It preserves body bytes in its structured request, with one-line presentation
in the advisory mailbox. Session IDs bypass the older case-folded destination
protocol.

Codex uses its native queue. OpenCode verifies the selected endpoint's session
identity and workspace, then admits v2 input with `delivery: "queue"` and
`resume: false`. An acknowledgement is delivery, not execution or completion.

Unavailable direct delivery becomes exact-recipient mailbox feedback. Failed or
lost admission acknowledgement remains ambiguous. Replaying the request never
automatically redispatches; a changed body under the same ID is a visible
conflict. This receipt path does not enter the older retry outbox.

For AOA, the already configured caller-owned host can consume the mailbox
request and use `DeliverConnectionFeedback` with the returned `nativeRequestId`,
exact session ID and body. Choose `steer` for an active turn or explicitly
authorized `submit`; neither choice is inferred. Return that SDK receipt through
the same request with `native: {receipt: SDK_RECEIPT}`. Work-coordination checks
session, request and body digest, appends the caller-returned acknowledgement,
and retains the original mailbox/ambiguous delivery in `deliveryHistory`.
No shared AOA server or replacement host is created. The normal SDK profile and
OE/ABAC authority remain in the host.

Returned native receipts are labeled caller-returned evidence. They do not
establish task semantics, signatures or Mdviewer execution evidence.

## Verification

Run `npm test` with `MDVIEW_BIN` set to the explicitly selected checkout's built
binary to enable the real cross-repository binding/render/reconcile/feedback
check. The MCP protocol suite needs the installed SDK under `mcp/`.
Fixtures prove protocol and failure behavior; live reads/delivery must be
reported separately. No test starts a provider session.

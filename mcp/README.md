# work-coordination-mcp

An MCP server that exposes work-coordination as tools. It lives outside every
repo it operates on: per call it shells to the `work-coordination` CLI with
that filetree as the working directory, so state resolves exactly as if a
local user ran it there.

## Visibility across filetrees

Copy `config.example.json` to `config.json` (or point
`WORK_COORDINATION_MCP_CONFIG` at it) and declare trees:

```json
{
  "cliPath": "work-coordination",
  "timeoutMs": 120000,
  "trees": [
    { "name": "mdview", "root": "/Users/nate/Public Repos/mdview", "visible": true },
    { "name": "lab", "root": "/tmp/wc-lab-tree", "visible": false }
  ]
}
```

`cliPath` must resolve from the server's `PATH` — `npm link` this package
first, or put the absolute `bin/work-coordination.mjs` path there instead.

Every tool takes a `tree` name, never a path. Unlisted and `"visible": false`
trees resolve to nothing: calls return `tree unavailable` without spawning
anything, and `trees_list` never names them. `init` is deliberately not
exposed — the server never creates state or touches repo metadata.

## Tools

- `trees_list` — visible filetrees.
- `observe` — declare a session's presence under typed work (`work`, `session`, `harness`, `directory`).
- `message` — advisory message (`body`, `work`, `from`, `session`, `group`, `status`, `to`, `deliver`, `idle_timeout_ms`). `blocked` and `done` fan out to subscribers.
- `sessions`, `work`, `groups`, `group_create`, `group_join`, `group_messages`.
- `subscribe`, `unsubscribe`, `subscriptions` — anyone may subscribe to any lane.

Transport failures report `unavailable · <reason>` instead of throwing. The
CLI enforces a 60s idle timeout per send; the server bounds each call with
`timeoutMs`.

## Run

```sh
npm install
npm test
WORK_COORDINATION_MCP_CONFIG=./config.json node src/index.mjs
```

## Register with a client

Claude Code (answer `y` to trust it on first run):

```sh
claude mcp add work-coordination -- node /Users/nate/Public Repos/work-coordination/mcp/src/index.mjs
```

or in config JSON:

```json
{ "mcpServers": { "work-coordination": {
  "command": "node",
  "args": ["/Users/nate/Public Repos/work-coordination/mcp/src/index.mjs"],
  "env": { "WORK_COORDINATION_MCP_CONFIG": "/Users/nate/Public Repos/work-coordination/mcp/config.json" }
} } }
```

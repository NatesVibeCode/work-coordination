# work-coordination-mcp

An MCP server that exposes work-coordination as tools. It lives outside every
repo it operates on, and it needs nothing installed: each tool calls the same
`src/operations.mjs` layer the CLI uses, in-process, with the tree's store —
so state resolves exactly as if a local user ran the CLI in that filetree.
One implementation, two frontends; they cannot drift apart.

## Visibility across filetrees

Copy `config.example.json` to `config.json` (or point
`WORK_COORDINATION_MCP_CONFIG` at it) and declare trees:

```json
{
  "trees": [
    { "name": "mdview", "root": "/Users/nate/Public Repos/mdview", "visible": true },
    { "name": "lab", "root": "/tmp/wc-lab-tree", "visible": false }
  ]
}
```

Every tool takes a `tree` name, never a path. Unlisted and `"visible": false`
trees resolve to nothing: calls return `tree unavailable` without touching
anything, and `trees_list` never names them. `init` is deliberately not
exposed.

State resolves the way the CLI resolves it from the tree directory —
nearest `.work-coordination` walking up, so a tree inside a repo shares that
repo's store with the CLI. The one deliberate difference: with no store
found, the server falls back to `.work-coordination` inside the tree root
itself, never the home store. A tree's state never leaves its declared root.

## Tools

- `trees_list` — visible filetrees.
- `observe` — declare a session's presence under typed work (`work`, `session`, `harness`, `directory`).
- `message` — advisory message (`body`, `work`, `from`, `session`, `group`, `status`, `to`, `deliver`, `idle_timeout_ms`). `blocked` and `done` fan out to subscribers.
- `sessions`, `work`, `groups`, `group_create`, `group_join`, `group_messages`.
- `subscribe`, `unsubscribe`, `subscriptions` — anyone may subscribe to any lane.

Internal failures report `unavailable · <reason>` instead of throwing. Sends
keep the 60s idle delivery timeout from the shared layer (`idle_timeout_ms`
overrides it per call).

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

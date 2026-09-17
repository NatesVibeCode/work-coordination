# work-coordination-mcp

An MCP server that exposes work-coordination as tools. It lives outside every
repo it operates on, and it needs nothing installed to run: each tool calls the
same `src/operations.mjs` layer the CLI uses, in-process, with the tree's store
— so state resolves exactly as if a local user ran the CLI in that filetree.
One implementation, two frontends; they cannot drift apart. (Only this
directory's test suite needs its `npm install`, for the SDK.)

## Visibility across filetrees

Copy `config.example.json` to `config.json` (or point
`WORK_COORDINATION_MCP_CONFIG` at it) and declare trees:

```json
{
  "trees": [
    { "name": "portable", "root": ".", "visible": true },
    { "name": "sibling", "root": "../other-repo", "visible": true },
    { "name": "scratch", "root": "~/trees/scratch", "visible": false }
  ]
}
```

A root may be absolute, **relative to the config file**, or `~/...`. Relative
roots are the portable form: the same config file declares the same trees no
matter which directory the client launched the server from.

Every tool takes a `tree` name, never a path. Unlisted and `"visible": false`
trees resolve to nothing: calls return `tree unavailable` without touching
anything, and `trees_list` never names them. `init` is deliberately not
exposed.

A declared root that **does not exist** is not created. The server names it on
stderr at startup, marks it in `trees_list` as `unavailable · root missing`,
and answers calls against it with `unavailable · root missing · <path>` — a
typo stays a typo instead of becoming a real directory holding an empty store.

State resolves the way the CLI resolves it from the tree directory —
nearest `.work-coordination` walking up, so a tree inside a repo shares that
repo's store with the CLI. The one deliberate difference: with no store
found, the server falls back to `.work-coordination` inside the tree root
itself, never the home store. A tree's state never leaves its declared root.
A tree may also declare `"state"` explicitly (same path rules as `root`) to
put its store somewhere of its own choosing.

The store's expiry setting, if any, applies here exactly as it does on the
CLI — set it with `work-coordination init --expiry-ms` in the tree. There is
nothing to configure on the server side.

## Tools

- `trees_list` — visible filetrees (a declared tree whose root is gone is listed as unavailable).
- `observe` — declare a session's presence under typed work (`work`, `session`, `harness`, `directory`).
- `message` — advisory message (`body`, `work`, `from`, `session`, `group`, `status`, `to`, `deliver`, `idle_timeout_ms`). `blocked` and `done` fan out to subscribers.
- `sessions`, `work`, `groups`, `group_create`, `group_join`, `group_messages`, `ungroup`.
- `subscribe`, `unsubscribe`, `subscriptions` — anyone may subscribe to any lane.
- `roadmap` — read one roadmap item and overlay observed local participation. Read-only and optional: it needs your own psql and table (`WORK_COORDINATION_ROADMAP_PSQL` selects the command) and reports `roadmap unavailable` when there is none.

Internal failures report `unavailable · <reason>` instead of throwing. Sends
keep the 60s idle delivery timeout from the shared layer (`idle_timeout_ms`
overrides it per call), and a fan-out runs its deliveries together, so one
unreachable target does not add its timeout to the others'.

## Run

```sh
npm install                  # the SDK, for the server and its tests
WORK_COORDINATION_MCP_CONFIG=./config.json node src/index.mjs
npm test
```

A missing or unreadable config exits 1 with one line naming the path and the
reason — never a stack trace, and never anything on stdout, which is the
protocol.

## Register with a client

Use an absolute path to this checkout (shown as `<repo>` below), because the
client launches the server from an arbitrary working directory:

```sh
claude mcp add work-coordination -- node <repo>/mcp/src/index.mjs
```

or in config JSON:

```json
{ "mcpServers": { "work-coordination": {
  "command": "node",
  "args": ["<repo>/mcp/src/index.mjs"],
  "env": { "WORK_COORDINATION_MCP_CONFIG": "<repo>/mcp/config.json" }
} } }
```

Relative tree roots inside that config resolve against the config file, so a
config written with `"root": "."` or `"root": "../other-repo"` keeps working
wherever the client starts the server.

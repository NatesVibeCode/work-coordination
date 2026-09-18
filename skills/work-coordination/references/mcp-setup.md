# MCP setup

The MCP server exposes the same operations layer as the CLI, in-process, so it
needs no CLI on PATH and cannot drift from the command-line wording. Prefer it
over shelling out when the client supports MCP.

## Config

Copy `mcp/config.example.json` to `mcp/config.json` (or point
`WORK_COORDINATION_MCP_CONFIG` at any path) and declare trees:

```json
{
  "trees": [
    { "name": "this-repo", "root": ".", "visible": true },
    { "name": "sibling", "root": "../other-repo", "visible": true },
    { "name": "scratch", "root": "~/trees/scratch", "visible": false }
  ]
}
```

- A root may be absolute, **relative to the config file**, or `~/...`.
  Relative roots follow the config file, not the client's working directory —
  that is what makes one config portable across machines.
- `"visible": false` hides a tree: it never appears in `trees_list` and calls
  against it return `tree unavailable`.
- A declared tree may add `"state": "<path>"` (same rules) to place its store
  explicitly instead of using the tree-local `.work-coordination`.
- A root that does not exist is **not** created. It is named on stderr at
  startup, listed in `trees_list` as `unavailable · root missing`, and calls
  against it answer `unavailable · root missing · <path>`.

`mcp/config.json` is gitignored: it holds paths for one machine. Only the
example ships.

## Run

```sh
cd mcp && npm install
WORK_COORDINATION_MCP_CONFIG=./config.json node src/index.mjs
```

Startup failures are one line on stderr and exit 1 — never a stack trace, and
never anything on stdout, which is the protocol. A missing config reads:

```text
work-coordination-mcp · cannot read config · /path/to/mcp/config.json · no such file
set WORK_COORDINATION_MCP_CONFIG to a readable config.json (see mcp/README.md)
```

## Register with a client

Use an absolute path to the checkout (`<repo>`), because the client launches
the server from an arbitrary directory:

```json
{ "mcpServers": { "work-coordination": {
  "command": "node",
  "args": ["<repo>/mcp/src/index.mjs"],
  "env": { "WORK_COORDINATION_MCP_CONFIG": "<repo>/mcp/config.json" }
} } }
```

```sh
claude mcp add work-coordination -- node <repo>/mcp/src/index.mjs
```

## Tools

| Tool | Does |
| --- | --- |
| `trees_list` | Visible trees (and declared ones whose root is missing) |
| `observe` | Declare presence under typed work (`work`, `session`, `harness`, `directory`) |
| `message` | Advisory message (`body`, `work`, `from`, `session`, `group`, `status`, `to`, `deliver`, `idle_timeout_ms`) |
| `sessions`, `work` | Read participants and messages |
| `policy` | Visibility rules (`action`: `add`, `remove`, `list`, `defaults`; deny only, first match wins) |
| `groups`, `group_create`, `group_join`, `group_messages`, `ungroup` | Ephemeral group lifecycle |
| `subscribe`, `unsubscribe`, `subscriptions` | Lane subscriptions |
| `pending`, `retry` | Deliveries that did not land, and draining them |
| `roadmap` | Read one roadmap item, overlay local participation (read-only, optional) |

Every tool takes a tree **name**, never a path. Internal failures return
`unavailable · <reason>` instead of throwing, so a broken call never takes the
session down.

## Store resolution

The server resolves a tree's store the way the CLI resolves it from that
directory — nearest `.work-coordination` walking up, so a tree inside a repo
shares the repo's store with the CLI. With no store found, both fall back to
`.work-coordination` **inside the tree root**. Neither ever uses a
home-directory store: one shared pool made unrelated uninitialized trees see
each other's sessions and messages. A tree's state never leaves its root.

The tree's own expiry setting applies here automatically; there is nothing to
configure server-side.

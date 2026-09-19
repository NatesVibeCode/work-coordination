# Dependencies

Direct dependencies and their licenses. Transitive dependencies are limited to
MIT, ISC, and BSD-2/3-Clause (see `mcp/package-lock.json`).

## Root package (`work-coordination`)

None. Runtime and tests use Node.js builtins only (`node:test`, `node:fs`,
`node:path`, `node:child_process`, `node:worker_threads`, `node:os`,
`node:url`). Node.js itself is MIT-licensed.

## MCP package (`mcp/`)

| Dependency                  | License |
| --------------------------- | ------- |
| `@modelcontextprotocol/sdk` | MIT     |
| `zod`                       | MIT     |

No vendored third-party code is present in the repository.

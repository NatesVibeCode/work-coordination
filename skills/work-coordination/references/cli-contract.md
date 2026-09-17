# CLI contract

Exact surface, taken from the command table in `bin/work-coordination.mjs`. If
this file and the CLI disagree, the CLI is right and this file is a bug.

## Invocation

```text
work-coordination [--state <path>] <command> [args] [flags]
```

`--state <path>` (or `--state=<path>`) may appear before or after the
subcommand. Without it, the nearest `.work-coordination` walking up from the
current directory is used, and with none the store is `.work-coordination` in
the current directory. There is no home-directory store.

A `--status` value outside `started|milestone|blocked|done` is a usage error;
an unset status is simply absent.

A destination (`--to`, or a group member) is compared case-insensitively:
`Codex:A` and `codex:a` are one destination, not two.

## Commands

| Command | Mode | Flags | Positional |
| --- | --- | --- | --- |
| `init` | writes | `--expiry-ms`, `--decay-ms` | — |
| `message` | writes | `--work`, `--from`, `--group`, `--status`, `--session`, `--to`, `--idle-timeout-ms`, `--deliver` | body text |
| `observe` | writes | `--work`, `--session`, `--harness`, `--directory` | — |
| `group create` | writes | — | optional name |
| `group join` | writes | — | group ref, session |
| `group messages` | reads | — | group ref |
| `ungroup` | writes | — | group ref |
| `subscribe` | writes | `--session`, `--work`, `--to` | — |
| `unsubscribe` | writes | — | subscription id |
| `sessions` | reads | — | — |
| `groups` | reads | — | — |
| `subscriptions` | reads | — | — |
| `pending` | reads | — | — |
| `retry` | writes | `--idle-timeout-ms` | — |
| `work` | reads | — | work ref |
| `roadmap` | reads | — | roadmap key |

`--decay-ms` is the pre-rename spelling of `--expiry-ms` and still works.
`init` never needs a session or a work ref.

## Parsing rules

- `--flag value` and `--flag=value` are equivalent.
- A bare `--` ends flag parsing; everything after it is positional, so a
  message body may legitimately begin with `-`.
- An unknown flag is a usage error: exit 1, one line naming the flag and the
  command's accepted flags, and **nothing written**.
- A repeated flag is a usage error (not last-wins).
- `--idle-timeout-ms` must be a finite number ≥ 1. `abc`, `0`, `-5`, and
  `Infinity` are refused. `init --expiry-ms` accepts `0` (expiry off) but not
  negatives or non-numbers.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command ran and printed its answer — including "nothing observed", "unavailable", and "expired". These are answers, not failures. |
| 1 | Usage error (bad flag, bad number) or an unexpected internal error. |

A non-zero exit never means "no work was found".

## Reading output

One record per message, one line each. Fields are folded to a single line, so
embedded newlines cannot forge a record. A body prints after the
`advisory — use if relevant; otherwise continue.` marker.

```text
Work message · #m_4f2a91c7b3
Ticket T-123 · from Codex / parser-repair
status · milestone
advisory — use if relevant; otherwise continue.
Tokenizer now returns spans.
```

## Delivery

`--deliver` sends through a verified native transport. `--to <harness>:<id>`
addresses one; without it, an active group's members are addressed.

| Harness | Transport |
| --- | --- |
| `codex` | `codex queue --thread <id> --message <text>` |
| `pi` | `pi --control-session <id> --send-session-message <text> ...` |
| `hermes` | `hermes peer dm <id> <text>` |
| anything else | `no verified local message transport for <harness>` |

Each delivery has its own idle timeout (default 60s, `--idle-timeout-ms` to
change it) and the fan-out runs its deliveries together, so one unreachable
target does not add its timeout to the others'. Failures are reported per
target and are never fatal. The advisory record is stored either way.

Subscriber fan-out happens on a `blocked` or `done` message from a session
that has a matching subscription; subscriptions scoped to a work only hear
that work, and overlapping subscriptions to the same target notify once.

## Deliveries that did not land

A failed delivery is reported **and queued**, keyed by (message, destination):

```sh
work-coordination pending      # what is waiting: destination, age, attempts, the provider's words
work-coordination retry        # try them all again now
```

`retry` drains the queue the same bounded way the live fan-out runs, reports
each outcome, clears what landed, and bumps the attempt count on what did not.
Nothing retries on its own: there is no daemon, no timer, and nothing waits.
An entry whose record aged out of the retention window is dropped — there is
nothing left to explain what it was for — and the queue is capped at 200,
oldest first.

This is why a provider being out of credit, rate limited, or disconnected does
not lose the message: `work "<ref>"` still shows the record, and `pending`
still holds the delivery.

## Roadmap (optional)

```sh
WORK_COORDINATION_ROADMAP_PSQL="psql mydb" work-coordination roadmap <key>
```

Read-only. It expects a `roadmap_items` table with `roadmap_key`, `title`,
`priority`, `lifecycle`, `status`. With no database it prints
`roadmap unavailable — local read failed; coordination remains advisory-only.`
and coordination continues.

## Verify the install

```sh
work-coordination                    # prints the "nothing to do" hint
work-coordination sessions           # an answer, not an error
```

An `unknown flag` or `needs a number` line on a well-formed command means the
installed binary is not the one this file describes.

`npm test` in the repository covers the CLI, the operations layer, and the
store. The MCP protocol suite additionally needs `cd mcp && npm install`.

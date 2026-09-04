# t3code-inject

One-shot turn injector for a t3code thread, and the seat command that makes a
t3code thread a seat on the agent relay (`lhc-agent`). Plain RPC over the
server's websocket; no t3code change.

```
t3code-inject [--base-url URL] --thread ID [--priority] [--from SENDER]
              [--timeout MS] [--home DIR] [--json] "<prompt>" | -
```

The prompt is the last argument (the relay appends it). Reply on stdout, exit
0. Failure on stderr, exit 1; an empty reply is a failure, never an empty
stdout with exit 0.

## Envelope

- The relay's `[from: x]` first line passes through untouched and names the
  sender. Without one: `--from`, then `LHC_RELAY_SENDER`, then `lee`.
- Priority: `--priority`, or `LHC_RELAY_JOB_CLASS=prioritized` (what the relay
  sets for `lhc-agent --priority` and for Lee's phone path).
- A high-priority message landing in a running turn gets one extra line,
  `[arrived mid-turn at <iso>]`, and nothing else.
- Queued prompts are each demarcated `[arrived <iso>]` when a sender's bundle
  has more than one, or when a single one waited behind other turns.

## Queue (normal priority)

`$T3CODE_INJECT_HOME/queue.sqlite` (default `~/.t3code-inject`), shared by every
injector process on the host. Each process inserts its message, then either
becomes the thread's dispatcher or waits on its row. The dispatcher waits for
turn idle, takes every queued message of the sender whose earliest message
arrived first, sends them as one turn, writes the same reply into each row, and
steps down as soon as its own row is settled. Never bundles across senders. No
debounce: an idle thread with nothing queued gets the turn at once.

High priority never touches the queue: busy thread = steer (same turn, next
model call), idle = new turn.

## Reply

The assistant text of the turn that answered. For a steer, the assistant text
created after the steer landed, falling back to the whole turn (`--json` says
which: `mode` is `after-steer` or `whole-turn`).

## Auth

Cached bearer under the injector home. When missing or expired it mints a
pairing token with the server's own CLI (`T3CODE_INJECT_CHECKOUT`, default
`/srv/work/t3code`, against `T3CODE_HOME`) and exchanges it.

## Layout

- `src/cli.ts` flow; `src/envelope.ts` sender/priority/rendering (pure);
  `src/queue.ts` sqlite queue; `src/t3code/thread.ts` thread tracking, idle,
  dispatch, reply; `src/t3code/{auth,rpc}.ts` moved from the campaign smoke lib.
- `test/` unit tests (`node --test`). `scripts/` live proofs: `idle.ts`,
  `steer.ts`, `queue-proof.ts`, `cleanup.ts`.
- `link-deps.sh` symlinks `@t3tools/*` and `effect` from the t3code checkout;
  the bin runs it on first use.

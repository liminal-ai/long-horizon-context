# Epic 01: Thread Record and Intake — Test Plan

**Companion to:** `02-tech-design.md` · TCs from `01-epic.md`

## Testing Strategy

The system under test is the lhc package entered through its two real entry points: SDK operations and CLI commands. Internal modules — pipeline, projection, stores, registry — are exercised through those entries, never tested in isolation against mocked neighbors. Two deliberate exceptions get supplemental pure-function suites because they are genuinely pure logic with contractual behavior: the turn state machine (golden cases mirroring the epic's rule table) and token estimation (golden counts). Everything else earns its coverage through entry-point behavior.

**What gets mocked: nothing.** This epic has no network, no inference provider, no clock-sensitive contract beyond injected `clock`, and its filesystem behavior *is* the product (durability, atomicity, restart survival). Every test runs against real SQLite files in a per-test temp directory. The injected clock is fixed per test for deterministic `recordedAt`/`queuedAt`/`createdAt`; the tokenizer runs real because golden-counting real output is stronger than stubbing it.

**Test layers:**

| Layer | Runner | Enters through | In `verify` |
|-------|--------|----------------|-------------|
| SDK behavior | vitest | SDK operations on temp stores | yes |
| CLI in-process | vitest | command router with argv + stdin injection | yes |
| CLI process boundary | vitest, spawns `dist/cli.js` | real argv/stdin/exit codes | `verify-all` only (labeled skip otherwise) |
| Pure supplemental | vitest | state machine, tokenizer directly | yes |

CLI in-process tests cover command logic cheaply (parsing, SDK call, rendering); the process suite proves the executable boundary (shebang, stdin wiring, exit codes, JSON on stdout) for a representative subset, not every TC.

**Naming convention:** test titles carry their TC ids (`"TC-3.2: second prompt closes open turn"`), so traceability is greppable from the suite itself.

## Fixture Contracts

From `fixtures/` (test-only; exempt from boundary check):

| Builder | Produces | Default state |
|---------|----------|---------------|
| `tempStore()` | temp dir with registry path + thread path factory | empty, valid |
| `validEvent(kind, overrides?)` | one event input | valid per Flow 4 schemas; unique idempotency key; returns the discriminated `MessageEventInput` member for its kind, so kind-payload mismatches in test code are compile errors — building an invalid pairing requires an explicit cast at the call site |
| `eventBatch(kinds[])` | ordered event array | valid; keys unique within batch |
| `conversationTurn()` | `[user_prompt, assistant_text, tool_call, tool_result, turn_end]` | one complete turn |
| `threadWith(events)` | created thread + recorded batch via real SDK | post-Chunk-2: real pipeline output |
| `corruptTwoOpenTurns(path)` | below-SDK direct insert of second open turn row | the one sanctioned invalid-state fixture |
| `openRaw(path)` | direct `node:sqlite` handle for assertions | read-only use by convention |

Builder validity is itself tested (Chunk 0 smoke): defaults decode clean against the Flow 4 schemas. Invalid states are never builder defaults — tests construct invalidity explicitly via `overrides` (e.g. `validEvent("user_prompt", { payload: { wrong: true } })`), so a reader always sees the invalidity at the call site.

## TC → Test Mapping

File paths under `packages/lhc/test/`. Setup column shows the distinguishing arrangement; assertions are the TC's, restated only where the design sharpened them.

### Flow 1 — `threads.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-1.1 | create happy path | `tempStore()` | ok result; file exists; `openRaw` reads metadata row (threadId, createdAt, token_estimator); registry row matches |
| TC-1.2 | occupied path | pre-write a file at target | `path_exists`, `caller_error`; file bytes unchanged; registry row count unchanged |
| TC-1.3 | resolve known/unknown | one created thread | known: ok with path+metadata; unknown: `thread_not_found` |
| TC-1.4 | id/path equivalence | two identical threads, batch to one by id, one by path | identical BatchResults (modulo threadId); identical full read-back — *lives in `intake.test.ts`, owned by Chunk 2* |
| TC-1.5 | listing | three threads; also: list against absent registry | three rows, fields complete; absent registry → ok, empty array, no file created |
| TC-1.6 | compensation | `registryPath` whose parent is an existing regular file (deterministic cross-platform failure; read-only dirs are not — root and CI sandboxes ignore permission bits) | error result; thread file deleted; no registry |

### Flow 2 — `intake.test.ts` (recording), `projection.test.ts` (messages)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-2.1 | order continuity | two 3-event batches | read-back: 6 events, orders 1–6, array order preserved |
| TC-2.2 | per-kind projection | `eventBatch` with all seven kinds | 6 messages (no turn_end); block types per design's mapping table; content verbatim |
| TC-2.3 | estimate determinism | same content, two threads | identical estimates; estimate present on all messages |
| TC-2.4 | tool-result fidelity | 300KB content string | read-back content byte-identical via SDK; repeated through spawned CLI in process suite |
| TC-2.5 | actor/harness carry | distinct values per event | values on event and message rows unchanged |
| TC-2.6 | result completeness | mixed batch (new, duplicate, prompt, turn_end) | per-event outcomes in order; messageIds; transitions; queuedWork; threadPosition |
| TC-2.7 | message work queued | prompt + tool_result batch | two items: `w-m1-prompt_smoothing`, `w-m2-tool_result_summary`; owner messages; status queued |
| TC-2.8 | empty batch | `[]` | `empty_batch`, `caller_error`; read-back unchanged |
| TC-2.9 | non-qualifying kinds | text/thinking/note batch | zero work items |

### Flow 3 — `turns.test.ts` + `state-machine.test.ts` (pure)

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-3.1 | open + stamp | prompt, text, tool_call, tool_result | one open turn; all four messages stamped to it |
| TC-3.2 | implicit close | prompt A activity, then prompt B | turn 1 closed, members frozen; turn 2 open, only prompt B |
| TC-3.3 | explicit close + work | prompt, text, turn_end | turn closed; `w-t1-turn_derivation` queued (work assertion owned by Chunk 5) |
| TC-3.4 | orphan turn_end | turn_end as first event | event recorded order 1; zero turns; zero work; next prompt opens t1 |
| TC-3.5 | frozen + gap | turn_end, then text, then prompt | text message turnId null; closed turn members unchanged; new turn holds only prompt |
| TC-3.6 | implicit close work parity | TC-3.2 setup | same work-item contract as explicit path (Chunk 5) |
| TC-3.7 | corruption | `corruptTwoOpenTurns`, then any batch | `turn_state_corrupt`, `state_corruption`; read-back unchanged |
| TC-3.8 | multi-turn batch | one batch: prompt, text, prompt, text, turn_end | two closed turns; correct membership; two turn work items |
| — | golden transitions | pure function | every rule-table row: (state, kind) → expected effect |

### Flow 4 — `validation.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-4.1 | four invalidity categories | four batches: unknown kind; missing idempotencyKey; caller-supplied eventOrder; turn_end with payload | each rejected whole; `invalid_event`; reason names the specific violation (server-field denial named as such) |
| TC-4.2 | first-failure index | valid, valid, invalid at index 2 | `eventIndex: 2`; events 0–1 not recorded |
| TC-4.3 | no trace | baseline thread, then rejected batch | full read-back (events, messages, turns, work) logically equal to baseline |
| TC-4.4 | class separation | one validation failure, one corruption (corrupt fixture), one storage failure (file-as-parent registryPath) | three distinct errorClasses, stable codes; same shapes via CLI in-process |
| TC-4.5 | valid-prefix rejection | new events + duplicates + one invalid | rejected whole; duplicates' originals unchanged; new events absent |
| — | unknown-field strictness | extra field at envelope, event, and payload levels | each rejected; three levels each named in reason |
| — | empty actor/harness | `validEvent` with `actor: ""` | rejected as missing required field |

### Flow 5 — `idempotency.test.ts`

| TC | Test | Setup | Key assertions |
|----|------|-------|----------------|
| TC-5.1 | full resend | record 5, resend same 5 | zero recorded; five skips with `duplicate_idempotency_key`; read-back unchanged |
| TC-5.2 | partial resend | 3 recorded + 2 new | three skips, two recorded; orders continue dense (no gaps from skips) |
| TC-5.3 | cross-thread keys | same key, two threads | both record |
| TC-5.4 | skips inert | resend recorded prompt + turn_end mid-conversation | turn count/states unchanged; no transitions in result; work-item count unchanged; no duplicate message |
| TC-5.5 | key wins | key K with payload A recorded; resend K with valid payload B | skipped; read-back returns A; B nowhere in any table (`openRaw` scan) |

### CLI process suite — `cli-process.test.ts` (verify-all only)

Representative boundary proofs, not full TC repetition: `new-thread` → `resolve` round-trip; `message-events` via real stdin (including the 300KB tool result); TTY/empty stdin → `empty_stdin`, exit 1; one validation failure → JSON error shape, exit 1; `--help` and unknown command exit codes.

## Architecture-Risk Tests (non-TC)

Behaviors no TC names but the design promises; each exists because AC/TC mapping alone would miss it.

| Risk | Test | Why TCs miss it |
|------|------|-----------------|
| Atomicity under mid-walk failure | induced failure inside the transaction (test seam closes handle) → read-back equals baseline | TC-4.3 covers validation rejection; this covers in-transaction failure |
| Restart survival | record batch, close handle, reopen → identical read-back including work items | NFR, no TC; the durability claim itself |
| Rejected batch takes no lock | concurrent open succeeds while rejection-path runs | design promise (pure validation before transaction), invisible to single-connection TCs |
| system_error rollback parity | storage failure mid-batch → rollback whole, `system_error` class | AC-4.6 is class-independent; TCs only exercise caller-error rejection |
| Fixture validity | builder defaults decode against real schemas | test substrate correctness, not product behavior |
| Boundary-check self-test | sabotage import fails the script | guards the guard |
| Verification gates fail correctly | failing test fails `verify`; edited Red file fails `green-verify` | proves the gates once (Chunk 0), then trusted |
| Registry lazy-init non-creation | reads against absent registry create no file | easy to get accidentally wrong with open-or-create storage helpers |

## Coverage Summary

| Flow | TCs | Supplemental | Est. tests |
|------|-----|--------------|-----------|
| 1 | 6 | lazy-init | 9 |
| 2 | 9 | — | 12 |
| 3 | 8 | golden suite | 14 |
| 4 | 5 | strictness, empty-fields | 10 |
| 5 | 5 | — | 7 |
| CLI process | — | boundary proofs | 6 |
| Architecture-risk | — | 8 risks | 9 |
| Chunk 0 smoke | — | rail, fixtures, tokenizer, gates | 5 |
| **Total** | **33** | | **~72** |

Within the epic's 60–72 estimate, at the top because architecture-risk tests are enumerated rather than folded in. Every TC from the epic appears exactly once as an owned row; the two cross-chunk deferrals (TC-1.4 → Chunk 2; TC-3.3/3.6 work halves → Chunk 5) are marked at their rows and owed by their receiving chunks.

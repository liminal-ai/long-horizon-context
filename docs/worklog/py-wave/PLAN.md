# Python wave plan — lhc-py propagation + Hermes host wave

Status: Fable verdict **CONVERGED** — leg 1 (Gate-0 through R6) authorized. Leg 2 remains held pending wildcard review.

Date: 2026-08-09
Steward: hermes-lhc (`20260809_212256_a94053`)
Contract pin: TypeScript SDK commit `81cd48ce6c59c81a78e6b532ecc93a2174183534`
Second reference: `packages/lhc-rs` at the same pin
Process authority: `docs/worklog/py-wave/BRIEF.md`

## 1. Operating constraints

- The two legs are strict: certify `packages/lhc-py` first; do not change `/srv/work/hermes-agent` until leg 1 is certified and the leg-2 wildcard report has been reviewed by Fable.
- SDK work lands on `main`. The existing unrelated `packages/cc-lhc` and root working-tree changes belong to another steward and are out of scope. Implementers must not read those working-tree files as contract evidence or modify them. Contract reads use `git show 81cd48c:<path>`; Python work is limited to `packages/lhc-py`, this wave's worklog, and approved conformance fixtures.
- TypeScript is the contract. Rust is a trap map and parity reference, not an authority that may override TypeScript. A suspected TS defect or ambiguity goes to `docs/worklog/py-wave/for-fable.md`; unblocked work continues.
- Each slice gets a fresh disposable implementer and a fresh independent verifier. A verifier receives the brief, contract pin, slice acceptance, diff, and test receipts, but not the implementer's reasoning narrative.
- Maximum three implementer/verifier rounds per slice. Extend only for a reachable P1, with rationale recorded in `LOG.md`; record P2s without cycling.
- No commits, pushes, service restarts, or live Hermes profile changes occur without the authorization appropriate to that stage. Hermes smoke and dogfood use a clearly named scratch `HERMES_HOME` under `/tmp`, except the final explicitly authorized steward-thread exhibit.

## 2. Artifact identity and gates

### Leg 1 interpreter and install mode

The only authoritative leg-1 interpreter is:

`/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3`

The environment currently resolves `lhc-py 0.0.1` as a PEP 660 editable install from:

`file:///srv/work/long-horizon-context/packages/lhc-py`

Before every slice gate and final exhibit, log all of the following, and fail closed if any differs:

1. `sys.executable` equals the interpreter above.
2. `Path(lhc.__file__).resolve()` is under `/srv/work/long-horizon-context/packages/lhc-py/src/lhc`.
3. `importlib.metadata.distribution("lhc-py").read_text("direct_url.json")` identifies that exact directory with `"editable": true`.
4. SDK repository `git rev-parse HEAD` and `git diff -- packages/lhc-py docs/worklog/py-wave` are captured. The exhibit states the commit containing the slice after it lands; pre-commit validation states the exact working-tree diff under test.

Fable's post-review execution rulings: the pinned retrieval output bound is 22,000; Python public retrieval options use snake_case; SDK owns recalled-history envelope and receipt formatting; and Hermes leg 2 consumes a git-SHA-pinned dependency rather than an editable install. For signature replay, compare the host-configured `(provider, model, api)` tuple frozen at the accepted attempt, retain issuer/endpoint response evidence as provenance, suppress on known contradiction, and suppress MoA-aggregated signatures unconditionally.

Gate command, run from `/srv/work/long-horizon-context/packages/lhc-py` with the explicit interpreter:

`/srv/work/long-horizon-context/packages/lhc-py/.venv/bin/python3 scripts/check_gate.py`

The gate script itself invokes `uv run`; before building, repair it to execute its own `sys.executable` (or otherwise make the explicit interpreter invariant mechanically true) and remove stale Phase-1/count-snapshot assumptions. The gate must establish collection success, full pytest success, `wrong=0`, `notimpl=0`, and no unexpected skips without hard-coding an expected test count. This gate repair is prerequisite infrastructure, not R1 behavior.

Per slice, also run the newly added focused test module(s) with the same explicit interpreter before the full gate. Conformance fixtures/goldens must exercise public Python behavior and compare contract bytes/data; no tests may inspect Python source text. Where TS fixtures exist, generate or check the expected result at `81cd48c`, then consume the checked-in neutral fixture from Python rather than importing the dirty TS working tree.

### Leg 2 interpreter and install mode

The production-equivalent Hermes development interpreter is:

`/home/leemoore/.hermes/venvs/hermes-dev/bin/python`

It currently has `lhc-py` editable from `/srv/work/long-horizon-context/packages/lhc-py`. At leg-2 start, install the Fable-certified leg-1 tree/commit into this interpreter in the consumption mode Fable approves, then mechanically print and log `sys.executable`, `lhc.__file__`, package version, `direct_url.json`, SDK commit, and Hermes commit before every host exhibit.

Hermes Python tests use `scripts/run_tests.sh`, never bare pytest. The repaired plugin command in `FORK.md` must invoke the production-equivalent interpreter directly and assert that the imported `lhc` is the certified install; the host-contract suite runs through `scripts/run_tests.sh`. `FORK.md`'s written sync SOP otherwise remains verbatim. Root SDK `verify` is not a wave gate because unrelated `cc-lhc` work is in flight.

## 3. Leg 1 slice order and assignments

The order remains R1→R6. It matches the certified Rust wave, keeps each migration additive, and avoids testing retrieval against pre-label/pre-schema behavior. Two cross-cutting fixes are placed at the first slice whose production path needs them rather than left as an end-of-wave pile.

### Gate-0 — make the Python gate trustworthy

Implementer: fresh Composer 2.5 session.
Verifier: fresh GPT-5.6 Sol high session.

- Modernize `packages/lhc-py/scripts/check_gate.py`, `tests/conftest.py`, and stale README gate language only as needed to make the gate final-state, interpreter-stable, and invariant-based.
- Add an artifact-identity preamble/receipt; do not hard-code changing test totals.
- Preserve the existing 15 intentional TS-mirrored skips unless a later contract test replaces one.

Acceptance: explicit interpreter and editable source are proven; collection and full baseline suite pass; deliberate skip set is explained; no source-reading or change-detector test is introduced.

### R1 — empty thinking husks at all serving exits

Implementer: fresh Grok 4.5 high session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `packages/lhc/test/empty-thinking-husk.test.ts`; `thread-view/internal/{render,assemble,session-view}.ts`; `turns/internal/compose.ts`. Rust mirror: `tests/empty_thinking_husk.rs` and corresponding thread-view/compose modules.

Likely Python surface: `thread_view/internal/{render,assemble,session_view}.py`, `turns/internal/compose.py`, plus `tests/test_empty_thinking_husk.py`.

Invariants:

- Capture remains immutable and keeps every thinking row.
- Empty/whitespace unsigned thinking is omitted from LLM context, session export, and smooth-band rendering.
- Empty signed thinking remains in session export; signature-only thinking is omitted only from the text-only LLM path.
- Non-empty thinking remains visible through both exits.

Acceptance: focused parity tests and full gate green; conformance case proves record purity and both serving exits.

### R2 — opaque signature, frozen identity, and identity-boundary grouping

Implementer: fresh Grok 4.5 high session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `intake-stream/{index,internal/validate}.ts`, `messages/internal/project.ts`, `shared-tech/view.ts`, `thread-view/internal/session-view.ts`, `test/thinking-signature.test.ts`, plus post-wave identity-boundary/history-ordering fixes at the pin. Rust mirror: `tests/thinking_signature.rs`, `tests/session_view_identity_boundary.rs`, `tests/session_view_history_order.rs` and matching modules.

Likely Python surface: intake event types/validation, `messages/internal/project.py`, shared view dataclasses, `thread_view/internal/session_view.py`, and new parity tests.

Invariants:

- `assistant_thinking.signature` is optional, opaque, stored verbatim, and closed-schema validation remains strict.
- Optional `provider`/`model`/`api` on `assistant_thinking` and `assistant_text` are projected verbatim and exported on the grouped assistant message.
- Omitted optional fields stay omitted, not empty-valued.
- Session-view grouping flushes before identity changes and before model/thinking-level change entries; history order follows persisted order, including adjacent conflicting rows.
- SDK exports signatures and provenance without deciding whether a host may replay them. Exact-identity replay suppression is host work in leg 2.

Acceptance: intake, projection, export, boundary-flush, ordering, and closed-schema tests plus neutral conformance fixtures and full gate.

### R3 — stable turn/message labels without contaminating derivation input

Implementer: fresh Composer 2.5 session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `turns/internal/{compose,derive,derivations}.ts`, `shared-tech/derivation.ts`, `thread-view/internal/{render,select}.ts`, `test/turn-message-labels.test.ts`. Rust mirror: `tests/turn_message_labels.rs`.

Likely Python surface: the matching compose/derive/derivations and render/select modules plus `tests/test_turn_message_labels.py`.

Invariants:

- Stored smooth `turn_rendering` contains `<tN>` and `<mN>` labels and per-line tool labels in contract order.
- `pre_detailed_assembly` is label-free so derivation prompts do not learn retrieval markup.
- Served chunk bands prepend `<turns>…</turns>`, including unavailable/gap entries.
- Legacy unlabeled stored renderings are freshly recomposed when labels are required; already labeled renderings are not double-labeled.

Acceptance: byte/data parity for mixed text/tool turns, compacted bands, gaps, derivation input, and legacy fallback; full gate.

### R4 — schema v6 retrieval domain and impressions

Implementer: fresh Grok 4.5 high session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `retrieval/index.ts`, `sdk.ts`, `shared-tech/{storage,thread-migrate}.ts`, `threads/internal/create.ts`, `test/{retrieval,thread-migrate}.test.ts`. Rust mirror: `src/retrieval/mod.rs`, `tests/{retrieval,retrieval_id_cap}.rs` and migration tests.

Likely Python surface: a new public `lhc.retrieval` module, SDK exposure, storage/create/migration, and retrieval/migration tests.

Invariants:

- Fresh threads are schema v6; v5 opens migrate in place with existing events/messages/derivations/views preserved and CHECK constraints active.
- `retrieval_impression` records exactly one row per deduplicated requested id, including served, deleted, budget, and invalid outcomes; first occurrence wins.
- Validate id shape `^[tm]\d{1,12}$`, clamp invalid-id echo using TS UTF-16 `js_slice/js_len` semantics, and perform strict validation before content reads.
- Dedupe before enforcing the 32-id cap; exact 32 passes, 33 refuses the call with split guidance.
- Reads honor canonical history ordering and adjacent-row conflict behavior.
- `get_turns` recomposes legacy unlabeled renderings per R3.

Acceptance: fresh-create and real seeded v5→v6 migration exhibits, rollback/error behavior, impression accounting for every result class, 32-id boundary, 12/13-digit boundary, UTF-16 clamp parity, and full gate.

### R5 — full stored token totals and capture-total token counting

Implementer: fresh Composer 2.5 session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `turns/internal/compose.ts`, `messages/internal/project.ts`, relevant derivation/turn tests, and `shared-tech/token-counting/index.ts`. Rust mirror: token-total coverage and `tests/token_counting_special.rs`.

Likely Python surface: compose/project/token-counting plus focused tests.

Invariants:

- Truncation marker is `[truncated — N tok total]` where N is the full stored `token_estimate`, not omitted/dropped tokens.
- Legacy char markers are translated at composition; genuine inference summaries pass unchanged; untruncated text has no marker.
- Token estimation is total for literal special-token strings such as `<|endoftext|>`; Python `tiktoken` must be called with an explicit allowed-special policy matching TS.

Acceptance: marker parity including legacy rows, no-board/direct-return behavior, special-token capture test on the real intake path, and full gate.

### R6 — bounded pull ergonomics and byte-stable formatting

Implementer: fresh Grok 4.5 high session.
Verifier: fresh GPT-5.6 Sol high session.

Contract: `retrieval/index.ts`, `packages/pi-lhc/src/serving/retrieval-tools.ts`, retrieval tests and serving goldens at `81cd48c`. Rust mirror: `src/retrieval/{mod,format}.rs`, `tests/{retrieval,retrieval_id_cap}.rs`, and format/open-order tests.

Likely Python surface: retrieval walk/slicing/format module, DB open ordering if parity requires it, and golden tests.

Invariants:

- Token budget defaults/caps at 8,000; result walk is input order and emits whole, slice, budget, deleted/missing/invalid/refusal receipts exactly as the contract specifies.
- `fromToken` continues exact token slices. Multi-id requests apply continuation per item as the contract defines.
- `byteBudget` slices fit in bytes and end on a valid UTF-8 code-point boundary. Clean-tail handling must never split a multibyte character.
- Byte-bound slices receive the sliver exemption; refusal receipts teach the exact recovery call.
- Recalled bodies alone are inside `<recalled-history>`; continuation/JIT guidance follows `</recalled-history>`.
- Formatter enforces section/footer/unserved caps instead of truncating output at runtime. The 32-id cap, 8,000 body cap, and `MAX_RETRIEVAL_OUTPUT_TOKENS` bound are tested with maximal classes. Before implementation, reconcile the ledger's stale 12k/22k wording against the pinned TS constant; TS at `81cd48c` wins and any ambiguity goes to Fable.
- If Python's SQLite open path has the same reachable parallel-open race, set `busy_timeout` before WAL and cover it behaviorally; do not port this mechanically without reproduction.

Acceptance: byte-identical historical-envelope goldens against the pinned host wording, UTF-8 boundary cases, token and byte continuation, sliver/refusal recovery, special-token text, maximal-output bound, optional reachable parallel-open test, and full gate.

### Leg-1 certification

After R6, the verifier runs the full explicit-interpreter gate independently and records:

- exact Python executable/editable install/SDK commit;
- schema v6 fresh-create and v5 migration evidence;
- parity fixture/golden inventory by slice;
- test pass/skip counts as receipts, not frozen assertions;
- `NotImplementedError` and wrong-result counts at zero;
- deliberate TS deviations (expected: none).

Fable reviews and pins the certified lhc-py commit before leg 2 begins.

## 4. Leg-2 wildcard assessment — first deliverable, before host code

The assessment is a short evidence report to Fable, not an implementation patch. It will trace one primary call, one same-turn fallback, Chat Completions reasoning, Anthropic-native signed thinking, and Codex Responses encrypted reasoning from prepared request through successful response normalization and persistence into the LHC capture callback.

### Candidate freeze seam

The strongest seam is inside `agent/conversation_loop.py` after provider-specific redecorating, `_build_api_kwargs`, Responses preflight, and request middleware, but immediately before the transport call. At that point each retry/fallback has its final request body and the active runtime has already changed (`conversation_loop.py:2192-2257`). Freezing earlier is wrong because `_try_activate_fallback()` mutates provider/model/api mode and the loop rebuilds request shape on each retry. The existing `pre_api_request` lifecycle hook at `conversation_loop.py:2262-2316` is adjacent and already exposes provider/model/base URL/api mode plus the sanitized prepared body, but lifecycle hook delivery alone does not bind the eventual successful response to the persisted assistant row.

The report will determine the smallest generic host fact needed: likely an immutable per-attempt identity snapshot keyed by `api_request_id`, promoted to the assistant message only for the attempt that produced the accepted response. Provider and API identity must come from the resolved transport/endpoint and prepared request, while model should prefer the final request body's model over mutable `agent.model`. MoA aggregator resolution, OpenRouter routing, Copilot/ACP, Responses issuer kind, continuation retries, and fallback switches are explicit cases. No LHC-specific core hook is proposed until this trace proves the existing generic request lifecycle cannot carry the fact safely.

### Signature reachability matrix

The assessment will execute or fixture-test the actual normalizers and message builder, then inspect what reaches `on_messages_persisted`:

- Chat Completions/OpenRouter/Anthropic-compatible: `build_assistant_message` preserves `reasoning_details` verbatim, including opaque signature/encrypted fields (`agent/chat_completion_helpers.py:1560-1575`). Determine the exact block-to-LHC signature mapping and preserve ordering for `anthropic_content_blocks`.
- Anthropic native: the builder preserves ordered `anthropic_content_blocks` (`agent/chat_completion_helpers.py:1577-1587`). Verify the native adapter supplies signatures there and whether `reasoning_details` also exists; choose one canonical extraction without duplication.
- Codex Responses/OpenAI and xAI surfaces: `_normalize_codex_response` retains `encrypted_content` and stamps `_issuer_kind` (`agent/codex_responses_adapter.py:1383-1418`); the builder persists it under `codex_reasoning_items` (`agent/chat_completion_helpers.py:1589-1593`). Current LHC capture ignores this field, so the opaque token reaches persistence but not LHC.
- Plain reasoning-only providers: text reaches `reasoning`/`reasoning_content` but no opaque signature exists; capture identity still applies to assistant text.

Current gap: `plugins/context_engine/lhc/capture.py:205-215` captures only reasoning text and assistant text, with no signature or provider/model/api. The report will test malformed/empty/signed cases and exact-identity replay. SDK session export always returns stored signatures; Hermes rebuild must suppress opaque signature replay unless frozen provider/model/api exactly matches the next prepared request. Text remains available even when signature replay is suppressed.

### Wildcard acceptance

Before leg-2 coding, Fable receives:

1. a request-attempt state diagram including fallback/continuation paths;
2. a provider/API-mode signature reachability matrix backed by production normalizer tests;
3. the exact proposed immutable identity tuple and source for each component;
4. the binding from accepted attempt → assistant persisted row → LHC events → rebuilt replay;
5. proposed generic seam versus fork-hook delta, with production reachability and cache/alternation analysis;
6. unresolved provider semantics, especially OpenRouter's routed backend identity and MoA aggregation.

## 5. Leg 2 proposed slices (held until wildcard approval)

### H1 — certified dependency and capture/rebuild fidelity

Implementer: fresh Grok 4.5 high session.
Verifier: fresh GPT-5.6 Sol high session.

- Install/declare the Fable-certified lhc-py consumption method and add a fail-closed import identity check to the host gate.
- Implement the approved request-attempt identity snapshot and capture mapping for assistant text/thinking signatures.
- Preserve opaque structures exactly; rebuild signatures only on exact provider/model/api match and keep native tool call/result ordering.
- Exercise primary, fallback, identity-boundary, mismatch suppression, signed-empty thinking, Codex encrypted reasoning, and restart/resume behavior.

### H2 — retrieval tools and bounded historical envelope

Implementer: fresh Composer 2.5 session.
Verifier: fresh GPT-5.6 Sol high session.

- Register `get_turns` and `get_messages` through `ContextEngine.get_tool_schemas()`/`handle_tool_call()`.
- Reuse the existing `context_engine` toolset gate in `agent/agent_init.py:2581-2621`; dispatch stays through the managed context-engine tool path in `agent/tool_executor.py:1916-1943`.
- Enforce the 8,000-token cap and SDK validation/caps. Return historical-envelope wording and out-of-envelope receipts byte-identically to the certified SDK/host goldens.
- Test no-tool leakage when the gate is closed, schema shape, middleware dispatch, concurrent capture/retrieval serialization, impression rows, and continuation calls.

### H3 — repair the fork gate and documentation drift

Implementer: fresh Composer 2.5 session.
Verifier: fresh GPT-5.6 Sol high session.

- Repair the `FORK.md` plugin-suite command so it uses `/home/leemoore/.hermes/venvs/hermes-dev/bin/python` (or the approved production-equivalent interpreter) and cannot silently skip/mis-import lhc-py.
- Replace source-text tripwires with behavioral seam tests where feasible; retain explicit inventory/markers as documentation, not as fake execution coverage.
- Correct only wave-touched stale LHC descriptions (inference lane, implementation status, dependency phase, manual SDK mode plus Hermes FIFO drain). Preserve the sync SOP's ordered semantics and operator rulings; do not opportunistically reduce fork hooks.

### H4 — host certification and dogfood

Independent verifier: fresh GPT-5.6 Sol high, with Fable final certification.

- Run focused plugin and host-contract tests, then relevant Hermes suites through `scripts/run_tests.sh`, all with artifact identity receipts.
- In a named `/tmp/hermes-lhc-py-wave-*` home, execute capture→drain→compact→resume, retrieve a pre-compaction turn and message through the real model tool path, and inspect envelope bytes, continuation receipts, impression rows, schema v6, and immutable event/message records.
- Only after scratch certification and explicit authorization, compact this steward's real LHC thread and retrieve a pre-compaction turn/message by stable id through the real model path. Verify the running process imported the certified lhc-py and Hermes commits. Do not push or restart a gateway as an implicit consequence.

## 6. Risks seen now

1. **Wrong artifact can still pass.** Both Python environments are editable today; `uv run --with pytest` can resolve a different environment and caused the confirmed skipped gate. All gates fail closed on executable/module/direct-url/commit identity.
2. **Mutable identity is not request identity.** Same-turn fallbacks mutate `agent.provider`, `agent.model`, base URL, and API mode. Capturing at session start, turn finalization, or persistence would mislabel accepted responses. Identity must bind to the successful prepared attempt.
3. **"Provider" is ambiguous behind routers.** OpenRouter and MoA may know only configured router/aggregator identity, not the backend that signs an opaque payload. Replay safety may require endpoint/issuer identity rather than marketing provider. This is a Fable decision if the prepared response lacks authoritative routing metadata.
4. **Opaque formats differ.** `reasoning_details`, ordered Anthropic blocks, and `codex_reasoning_items` are not interchangeable. Flattening them to text or selecting an arbitrary first signature would destroy replay fidelity.
5. **Grouping can cross identity boundaries.** Session-view coalescing of adjacent assistant rows can attach one identity/signature to content from another request unless every identity/control boundary flushes first and history ordering is deterministic.
6. **UTF-8 and UTF-16 are both contract surfaces.** Byte-budget slicing must use encoded-byte boundaries, while invalid-id clamps follow JS UTF-16 semantics. Python-native slicing is wrong for at least one of these.
7. **Receipts can violate the bound.** Body token caps alone do not bound 32 receipts/footers. Formatter cardinality checks and the pinned worst-case output constant are required; the ledger contains stale 12k/22k wording that must be reconciled against the pinned TS source.
8. **Capture must be total.** Python tiktoken rejects special-token text by default. A literal `<|endoftext|>` on the live capture path can break durable recording unless R5 lands the explicit policy.
9. **Migration is irreversible in normal use.** v5→v6 must be transactional, preserve all rows, and be tested from a real seeded v5 file before any live thread opens under the new port.
10. **Retrieval races the existing FIFO writer.** Reads and impression writes may contend with capture/compaction. The implementation must use the engine's ordered worker or a proven safe DB path; blindly copying Rust's SQLite open workaround is not enough.
11. **Unrelated SDK work is dirty.** Root verification is not trustworthy for this wave, and accidental staging could absorb another steward's `cc-lhc` work. Every diff/commit command must be path-scoped and reviewed.
12. **Source-reading tripwires provide false confidence.** The existing Hermes gate can report hooks present while the production seam is unreachable. Host acceptance must execute persistence, usage, identity, and tool-dispatch behavior.

## 7. Review questions for Fable

1. Confirm the pinned TS value for `MAX_RETRIEVAL_OUTPUT_TOKENS`; the propagation ledger's closing entries say both 12,000 and 22,000.
2. For router-backed calls, is exact replay identity the configured `(provider, model, api)` tuple, or must `provider` identify the endpoint/issuer that minted the opaque payload when known?
3. Confirm whether SDK Python API names should preserve TS camelCase option fields (`fromToken`, `tokenBudget`, `byteBudget`) at the public boundary or follow the existing Python port's snake_case convention with a typed translation layer.
4. Confirm the approved Hermes dependency consumption form after leg-1 certification (editable commit-pinned checkout for this source install versus a declared Git SHA dependency/lock update).

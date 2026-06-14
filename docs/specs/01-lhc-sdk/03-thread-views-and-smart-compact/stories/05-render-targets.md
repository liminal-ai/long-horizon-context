# Story 5: Render Targets

### Summary
<!-- Jira: Summary field -->
PI session-file materialization with format fixture and array/file parity, plus the full CLI surface (`lhc view *`) proven through the spawned-process suite.

### Description
<!-- Jira: Description field -->

**User Profile (from epic):** the agentic harness (PI extension first), calling through the SDK on every model call; and the agent/operator running compacts and checking thread health through the CLI.

**Objective:** one view, two shapes — the message array for harnesses with hooks, the PI session file for everything else — and the CLI grammar shipped and proven at the process boundary.

**Scope in:**
- `materialize(ref, { path, format? })` per tech design §Flow 5: runs pull internally, maps to PI session JSONL (header from view metadata, parentId chain, generated fields from view metadata never write-time clocks), writes file, returns path
- Format fixture: structure-trimmed real PI session file in `test/fixtures/`; conformance checks (header line, entry shape, parentId chain)
- `cli/view.ts`: the full grammar from tech design §External Contracts — pull, status, compact, sweep, materialize with all flags
- Process-suite parity legs for all five commands (closes the claimed-vs-proven CLI gap), the profile-violation exit-nonzero leg, and the CLI-intake-advances-boundary architecture-risk leg (Story 4's named debt)

**Scope out:** non-PI formats (`--format` accepts `pi-session` only; unknown → caller error); any view or state mutation from materialize or any CLI read path.

**Dependencies:** Stories 0–2 (a compacted view to render); Story 4 (boundary-affected tail proves parity in both targets); Story 3 (sweep must exist for the sweep CLI parity leg and TC-3.3's CLI receipt leg — if Story 3 slipped past Story 4 under the coverage gate-slip contingency, this story waits for it).

### Acceptance Criteria
<!-- Jira: Acceptance Criteria field -->

- **AC-5.1**: The pull returns the view as an ordered message array: band content as labeled context messages in band order (brief → detailed → smoothed), then tail messages in record order, each with role and content. The mapping is deterministic.
  - **TC-5.1** (AC-5.1): Pull a compacted thread → array opens with band context messages in gradient order, tail follows in record order; roles and labels per the pinned mapping; deterministic across repeated pulls.
- **AC-5.2**: Materialize writes the active view as a PI-format session file at a caller-supplied path; the write changes no thread state; any generated fields in the file derive from active-view metadata, never from write-time clocks, so repeating it after no thread changes produces a byte-identical file.
- **AC-5.3**: The materialized file and the message-array pull of the same view carry the same content: every band entry and tail message in the array appears in the file, same order, same rendered text, in the target format's encoding.
  - **TC-5.2** (AC-5.2, AC-5.3): Materialize, pull, compare → content parity item-for-item; materialize again with no changes → byte-identical file; thread state hash unchanged by materialization.
  - **TC-5.5** (AC-5.3): Format conformance: materialized file validates against a fixture derived from a real PI session file (structure-level: line shape, required fields, message encoding).
- **AC-5.4**: Materializing a never-compacted thread works: the file carries the tail-only view.
  - **TC-5.3** (AC-5.4): Materialize a never-compacted thread → valid file, tail-only content, loadable against the format fixture.
- **AC-5.5**: Pull and materialize are exposed through SDK and CLI; the CLI materialize prints the written path and the CLI pull emits the message array as JSON.
  - **TC-5.4** (AC-5.5): Spawned CLI: pull → JSON message array on stdout; materialize → path printed, file exists, parses; both exit 0; failure case (no such thread file) exits nonzero with a structured error. *(Same file carries the parity legs for status, compact, sweep — architecture-risk rows — and TC-3.3's CLI leg.)*

### Technical Design
<!-- Jira: Technical Notes or sub-section of Description -->

#### Architecture Context

The capstone: the view crosses two boundaries — file format and process — and must arrive unchanged at both. `materialize.ts` never reads the record: it renders `pull`'s output, which makes AC-5.3's parity structural rather than tested-into-existence. `cli/view.ts` is the last surface piece, and the process suite here is where three other stories' deferred legs land (Story 3's TC-3.3 CLI leg, Story 4's CLI-advance leg, the all-five parity rows).

#### Build Strategy

Format fixture first — capture a real PI session file, trim to structure, commit with provenance note — because TC-5.5 is unwritable without it and it may surface format surprises that reshape `materialize.ts`. Then materialize over pull output (pure mapping + file write), then `cli/view.ts` command-by-command, then the process suite. Red: `materialize` stub; CLI commands exit nonzero with structured not-implemented.

#### Implementation Targets

| Target | Work |
|--------|------|
| `src/domains/thread-view/internal/materialize.ts` | pull → JSONL mapping: header from view metadata (`id` from thread id + view createdAt, never `Date.now()`), parentId chain, band + tail messages in pull order; file write; `{ writtenPath }` |
| `src/cli/view.ts` | five commands per the pinned grammar (file-path/thread-id refs, profile + band-override flags, `--no-sweep`, `--json`, `--out`, `--format`); structured errors; exit codes |
| `test/fixtures/pi-session-structure.jsonl` | structure-trimmed real PI session + provenance note (PI version) |
| `test/cli-process-view.test.ts` | TC-5.4 + all deferred process legs |

#### Design References

| Topic | Where |
|-------|-------|
| PI session format pin (header, entry, parentId, metadata-derived fields) | tech-design.md L61 |
| CLI grammar, flag semantics | tech-design.md L67–79 |
| Materialize flow + parity-by-construction | tech-design.md L291–293, L133 (must-not-own) |
| Band-message order in the array (brief → detailed → smooth → tail) | tech-design.md L235, L309 |
| Process-suite legs | test-plan.md L64–65 (CLI parity + CLI-advance rows), L47 |

#### Test Mapping

| TC | Test file | Asserts |
|----|-----------|---------|
| TC-5.1 | `test/view-render-targets.test.ts` | band context messages in gradient order, tail in record order, roles/labels per mapping; deterministic across pulls |
| TC-5.2 | `view-render-targets.test.ts` | item-for-item parity materialize↔pull; repeat → byte-identical file; thread state hash unchanged |
| TC-5.3 | `view-render-targets.test.ts` | never-compacted → valid tail-only file, loads against fixture |
| TC-5.5 | `view-render-targets.test.ts` | header line shape, entry fields, parentId chain vs structure fixture |
| TC-5.4 | `test/cli-process-view.test.ts` | spawned: pull JSON on stdout; materialize prints path, file parses; missing thread → nonzero + structured error |

#### Cross-Story Debt

Process-suite legs this story closes for other owners — all in `cli-process-view.test.ts`, all named in coverage.md's debts table:

| Leg | Owner | Asserts |
|-----|-------|---------|
| TC-3.3 CLI leg | Story 3 | spawned sweep receipt = SDK schema (closes Story 3 deferral) |
| CLI-advance leg | Story 4 | spawned CLI intake over max → pull shows flips, status zone ≤ target (closes Story 4 debt) |
| parity legs (all five ops) | epic-level NFR | compact/status/sweep receipts JSON = SDK shapes; profile violation → nonzero naming constraint |

#### Architecture-Risk Tests

The two process-suite rows above are this story's architecture-risk load: claimed-vs-proven CLI surface, and the seam-install class (a createSdk-only advance install passes every in-process test and fails the spawned leg). Zero-provider now asserted on CLI paths too — view commands run with **no provider configured at all** (the design's prerequisite line), which is itself the proof that no view operation needs one.

#### Technical Notes

Deterministic `id`s: the header id derives from thread id + view createdAt; message entry ids from message ids; a never-compacted thread's header uses the thread's created-at (viewId null — `ViewMeta` carries both nullables). Byte-identical repeats are the test for any sneaky `Date.now()`/random — hash the whole file. CLI band-override flags merge field-wise over the profile *before* validation, so `--full 40` on a 30/30/20/20 profile fails the sum check with the named violation — that's correct behavior, not a bug to smooth over. The `--format` flag accepts only `pi-session`; unknown → `caller_error` naming accepted values.

#### Anti-Shim Requirements

The format fixture must come from a *real* PI session file with its provenance recorded — not hand-authored from the design's description (the design pinned the format from PI source, but the fixture's job is to catch the design being wrong about PI, which a design-derived fixture cannot). Materialize must not grow a record-reading path for any reason — if pull's output is insufficient for the file, fix pull's output.

#### Production Path Proof

The entire process suite spawns `dist/cli.js` — built artifact, real argv, real exit codes, no provider env. In-process render-target tests go through `createSdk().threadView.materialize` against fixture threads.

#### Verification

`pnpm verify` for the default suite; `LHC_PROCESS_SUITE=1 pnpm verify-all` for story completion — this story is where the epic's process suite goes from absent to `ran`, closing the suite-accounting row.

#### Spec Deviations

None.

### Definition of Done
<!-- Jira: Definition of Done or Acceptance Criteria footer -->

- [ ] TC-5.1–5.5 green; all five CLI commands proven at the process boundary; profile-violation and missing-thread failure legs green
- [ ] CLI-intake-advances-boundary leg green (closes Story 4's debt comment)
- [ ] TC-3.3's CLI receipt-shape leg green (closes Story 3's deferred leg)
- [ ] Format fixture committed with provenance note (which PI version produced the source session)
- [ ] Zero-provider assertion spans all five operations including CLI paths
- [ ] `verify-all` green including process suite (`LHC_PROCESS_SUITE=1`)

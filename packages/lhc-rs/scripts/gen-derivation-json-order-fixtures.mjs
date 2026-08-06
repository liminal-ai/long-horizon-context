/**
 * Generates fixtures/derivation-json-order-cases.jsonl (Amendment G).
 *
 * Uses the exact Node/TS construction order for each producer branch of
 * DerivationMetadata and for Derivation / DerivationReportEntry public wire
 * shapes. Each line: { name, kind, derivationType?, input, expected }.
 *
 * Regenerate only deliberately (the committed file is the contract):
 *   node scripts/gen-derivation-json-order-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const provenance = { provider: "p", model: "m", prompt: "pr" };
const gaps = [
  {
    subjectKind: "message",
    subjectId: "m1",
    derivationType: "smoothed_prompt",
  },
];

/** @type {Array<{name: string, kind: string, derivationType?: string, input: object, expected: string}>} */
const cases = [];
const seen = new Set();

function add(name, kind, input, expectedObj, derivationType) {
  if (seen.has(name)) throw new Error(`duplicate fixture name: ${name}`);
  seen.add(name);
  /** @type {any} */
  const row = {
    name,
    kind,
    input,
    // metadata_absent uses JSON null; all other kinds store exact JSON bytes.
    expected: expectedObj === null ? null : JSON.stringify(expectedObj),
  };
  if (derivationType !== undefined) row.derivationType = derivationType;
  cases.push(row);
}

// ── metadata producers ────────────────────────────────────────────

{
  const metadata = {};
  metadata.provenance = provenance;
  metadata.inferenceAttempted = true;
  metadata.inferenceSucceeded = true;
  metadata.sizeDisposition = "in_range";
  add(
    "meta_detailed_success_with_provenance",
    "metadata",
    {
      provenance,
      inferenceAttempted: true,
      inferenceSucceeded: true,
      sizeDisposition: "in_range",
    },
    metadata,
    "detailed_turn_compression",
  );
}

{
  const metadata = {};
  metadata.inferenceAttempted = true;
  metadata.inferenceSucceeded = true;
  metadata.sizeDisposition = "under_min";
  add(
    "meta_detailed_success_no_provenance",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      sizeDisposition: "under_min",
    },
    metadata,
    "detailed_turn_compression",
  );
}

{
  const metadata = {};
  metadata.inferenceAttempted = true;
  metadata.inferenceSucceeded = false;
  metadata.fallbackUsed = true;
  metadata.lastError = "provider boom";
  metadata.fallbackFloor = "pre_detailed_assembly";
  add(
    "meta_detailed_fallback_with_last_error",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: false,
      fallbackUsed: true,
      lastError: "provider boom",
      fallbackFloor: "pre_detailed_assembly",
    },
    metadata,
    "detailed_turn_compression",
  );
}

{
  const metadata = {};
  metadata.inferenceAttempted = true;
  metadata.inferenceSucceeded = false;
  metadata.fallbackUsed = true;
  metadata.fallbackFloor = "pre_detailed_assembly";
  add(
    "meta_detailed_fallback_without_last_error",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: false,
      fallbackUsed: true,
      fallbackFloor: "pre_detailed_assembly",
    },
    metadata,
    "detailed_turn_compression",
  );
}

{
  const metadata = {
    inferenceAttempted: true,
    inferenceSucceeded: true,
  };
  metadata.provenance = provenance;
  add(
    "meta_smoothed_success_with_provenance",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      provenance,
    },
    metadata,
    "smoothed_prompt",
  );
}

{
  const metadata = {
    inferenceAttempted: true,
    inferenceSucceeded: true,
  };
  add(
    "meta_smoothed_success_no_provenance",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: true,
    },
    metadata,
    "smoothed_prompt",
  );
}

{
  const metadata = { discardReason: "suspicious_output_ratio" };
  add(
    "meta_smoothed_suspicious",
    "metadata",
    { discardReason: "suspicious_output_ratio" },
    metadata,
    "smoothed_prompt",
  );
}

{
  const metadata = {
    outcome: "succeeded",
    inferenceAttempted: true,
    inferenceSucceeded: true,
  };
  metadata.provenance = provenance;
  add(
    "meta_tool_result_success_with_provenance",
    "metadata",
    {
      outcome: "succeeded",
      inferenceAttempted: true,
      inferenceSucceeded: true,
      provenance,
    },
    metadata,
    "tool_result_summary",
  );
}

{
  const metadata = {
    outcome: "failed",
    inferenceAttempted: true,
    inferenceSucceeded: true,
  };
  add(
    "meta_tool_result_success_no_provenance",
    "metadata",
    {
      outcome: "failed",
      inferenceAttempted: true,
      inferenceSucceeded: true,
    },
    metadata,
    "tool_result_summary",
  );
}

{
  const metadata = { outcome: "unknown" };
  add("meta_tool_result_forced_or_small_tier", "metadata", { outcome: "unknown" }, metadata, "tool_result_summary");
}

{
  const metadata = {
    inferenceAttempted: true,
    inferenceSucceeded: true,
    sizeDisposition: "over_max",
  };
  metadata.provenance = provenance;
  add(
    "meta_chunk_brief_success_with_provenance",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      sizeDisposition: "over_max",
      provenance,
    },
    metadata,
    "chunk_summary_brief",
  );
}

{
  const metadata = {
    inferenceAttempted: true,
    inferenceSucceeded: true,
    sizeDisposition: "in_range",
  };
  add(
    "meta_chunk_brief_success_no_provenance",
    "metadata",
    {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      sizeDisposition: "in_range",
    },
    metadata,
    "chunk_summary_brief",
  );
}

// metadata-absent branches: expected empty object is not written; fixture
// records the absent sentinel so the Rust helper path is not invoked.
add("meta_absent_tiny_turn_or_deterministic", "metadata_absent", {}, null, "detailed_turn_compression");

// ── Derivation / report public wire order ─────────────────────────

function buildDerivation(stateExtras) {
  const record = {
    subjectKind: "turn",
    subjectId: "t1",
    derivationType: "detailed_turn_compression",
    state: stateExtras.state,
    sourceVersion: 1,
  };
  if (stateExtras.content !== undefined) record.content = stateExtras.content;
  if (stateExtras.reason !== undefined) record.reason = stateExtras.reason;
  if (stateExtras.metadata !== undefined) record.metadata = stateExtras.metadata;
  if (stateExtras.gaps !== undefined) record.gaps = stateExtras.gaps;
  if (stateExtras.derivedAt !== undefined) record.derivedAt = stateExtras.derivedAt;
  return record;
}

add("deriv_pending", "derivation", { state: "pending" }, buildDerivation({ state: "pending" }));

add(
  "deriv_failed",
  "derivation",
  { state: "failed", reason: "boom" },
  buildDerivation({ state: "failed", reason: "boom" }),
);

add(
  "deriv_blocked",
  "derivation",
  { state: "blocked", reason: "gap" },
  buildDerivation({ state: "blocked", reason: "gap" }),
);

{
  const metadata = {};
  metadata.provenance = provenance;
  metadata.inferenceAttempted = true;
  metadata.inferenceSucceeded = true;
  metadata.sizeDisposition = "in_range";
  add(
    "deriv_ready_content_metadata_before_gaps_derived_at",
    "derivation",
    {
      state: "ready",
      content: "body",
      metadata: {
        provenance,
        inferenceAttempted: true,
        inferenceSucceeded: true,
        sizeDisposition: "in_range",
      },
      gaps,
      derivedAt: "2026-01-01T00:00:00.000Z",
    },
    buildDerivation({
      state: "ready",
      content: "body",
      metadata,
      gaps,
      derivedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

function buildReport(stateExtras) {
  const entry = {
    subjectKind: "turn",
    subjectId: "t1",
    derivationType: "detailed_turn_compression",
    state: stateExtras.state,
    sourceVersion: 2,
  };
  if (stateExtras.content !== undefined) entry.content = stateExtras.content;
  if (stateExtras.reason !== undefined) entry.reason = stateExtras.reason;
  if (stateExtras.metadata !== undefined) entry.metadata = stateExtras.metadata;
  if (stateExtras.gaps !== undefined) entry.gaps = stateExtras.gaps;
  if (stateExtras.derivedAt !== undefined) entry.derivedAt = stateExtras.derivedAt;
  if (stateExtras.queue !== undefined) entry.queue = stateExtras.queue;
  return entry;
}

add(
  "report_ready_no_queue",
  "report_entry",
  {
    state: "ready",
    content: "c",
    derivedAt: "2026-01-02T00:00:00.000Z",
  },
  buildReport({
    state: "ready",
    content: "c",
    derivedAt: "2026-01-02T00:00:00.000Z",
  }),
);

{
  const metadata = {
    inferenceAttempted: true,
    inferenceSucceeded: true,
    sizeDisposition: "in_range",
  };
  add(
    "report_ready_with_queue_metadata_before_gaps",
    "report_entry",
    {
      state: "ready",
      content: "c",
      metadata,
      gaps,
      derivedAt: "2026-01-02T00:00:00.000Z",
      queue: { status: "claimed" },
    },
    buildReport({
      state: "ready",
      content: "c",
      metadata,
      gaps,
      derivedAt: "2026-01-02T00:00:00.000Z",
      queue: { status: "claimed" },
    }),
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "fixtures", "derivation-json-order-cases.jsonl");
const body = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
writeFileSync(outPath, body);
console.log(`wrote ${cases.length} cases → ${outPath}`);

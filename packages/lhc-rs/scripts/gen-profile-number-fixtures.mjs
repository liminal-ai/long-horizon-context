/**
 * Generates fixtures/profile-number-cases.jsonl (Amendment I).
 *
 * Oracle rows are produced through actual TypeScript producers under Node:
 * resolveViewConfig / profileViolation / selectArrangement, and — for
 * persisted/receipt/describe/inspect config — a real initLhc → compact →
 * SQLite / describe / inspect.view chain against a disposable thread DB.
 *
 * Requires a fresh package build first:
 *   (cd ../lhc && npm run build)
 *   node scripts/gen-profile-number-fixtures.mjs
 *
 * Double-regenerate and confirm byte-identical before committing.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
} from "../../lhc/dist/index.js";
import { view as inspectView } from "../../lhc/dist/inspect/index.js";
import {
  profileViolation,
  resolveViewConfig,
} from "../../lhc/dist/thread-view/internal/profiles.js";
import { selectArrangement } from "../../lhc/dist/thread-view/internal/select.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "fixtures", "profile-number-cases.jsonl");

/** @type {Array<{name: string, kind: string, input: object, expected: unknown}>} */
const cases = [];
const seen = new Set();

function add(name, kind, input, expected) {
  if (seen.has(name)) throw new Error(`duplicate fixture name: ${name}`);
  seen.add(name);
  cases.push({ name, kind, input, expected });
}

/** Load-bearing Amendment I selection inputs: every production budget share
 *  (full / smooth / detailed / brief) changes the asserted arrangement. */
const SELECTION_SMOOTH =
  "smooth alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha";
const SELECTION_DETAILED =
  "detailed beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta";
const SELECTION_BRIEF = "brief gamma gamma gamma gamma gamma";

const LOAD_BEARING_SELECTION = {
  lowerBound: 200,
  percentages: { full: 30, smooth: 25, detailed: 25, brief: 20 },
};

function selectionFixtureInputs() {
  const turns = [];
  const messages = [];
  /** @type {Record<string, {state: string, content: string}>} */
  const derivationObj = {};
  for (let i = 1; i <= 14; i += 1) {
    const order = i * 10;
    turns.push({
      turnId: `t${i}`,
      turnOrder: i,
      status: "closed",
      openedAt: order,
      closedAt: order,
    });
    messages.push({
      messageId: `m${i}`,
      turnId: `t${i}`,
      order,
      kind: "user_prompt",
      text: "x",
      tokenEstimate: i <= 11 ? 10 : 50,
    });
    derivationObj[`t${i}/turn_rendering`] = {
      state: "ready",
      content: SELECTION_SMOOTH,
    };
  }
  const chunks = [
    { chunkId: "c1", chunkOrder: 1, status: "closed", memberTurnIds: ["t1", "t2"] },
    { chunkId: "c2", chunkOrder: 2, status: "closed", memberTurnIds: ["t3", "t4"] },
    { chunkId: "c3", chunkOrder: 3, status: "closed", memberTurnIds: ["t5", "t6"] },
    { chunkId: "c4", chunkOrder: 4, status: "closed", memberTurnIds: ["t7", "t8"] },
  ];
  for (const chunk of chunks) {
    derivationObj[`${chunk.chunkId}/chunk_summary_detailed`] = {
      state: "ready",
      content: SELECTION_DETAILED,
    };
    derivationObj[`${chunk.chunkId}/chunk_summary_brief`] = {
      state: "ready",
      content: SELECTION_BRIEF,
    };
  }
  return {
    messages,
    turns,
    chunks,
    derivations: new Map(Object.entries(derivationObj)),
    maxEventOrder: 200,
    derivationCounts: {},
  };
}

/** JSON-friendly mirror of SelectionInputs (derivations as a plain object). */
function selectionInputsForFixture(inputs) {
  return {
    messages: inputs.messages,
    turns: inputs.turns,
    chunks: inputs.chunks,
    derivations: Object.fromEntries(inputs.derivations),
    maxEventOrder: inputs.maxEventOrder,
    derivationCounts: inputs.derivationCounts,
  };
}

function projectSelection(result) {
  return {
    compactPoint: result.compactPoint,
    coveredFrom: result.coveredFrom,
    entries: result.entries.map((e) => ({
      band: e.band,
      subjectKind: e.subjectKind,
      subjectId: e.subjectId,
      derivationUsed: e.derivationUsed,
      degraded: e.degraded,
      gap: e.gap,
      startOrder: e.startOrder,
    })),
  };
}

const FRAC = {
  name: "fractional",
  lowerBound: 12.5,
  percentages: { full: 12.5, smooth: 47.5, detailed: 20, brief: 20 },
};

const INTEGRAL_OVERRIDE = {
  name: "continuation",
  lowerBound: 120000,
  percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 },
};

// ── resolve / merge / diagnostics ────────────────────────────────

{
  const resolved = resolveViewConfig({ profiles: [FRAC] });
  add(
    "resolve_new_fractional_profile",
    "resolve_profile",
    { profiles: [FRAC] },
    JSON.stringify(resolved.profiles.fractional),
  );
}

{
  const partial = {
    name: "continuation",
    lowerBound: 12.5,
    percentages: { full: 12.5, smooth: 47.5 },
  };
  const resolved = resolveViewConfig({ profiles: [partial] });
  add(
    "resolve_partial_fractional_override_of_builtin",
    "resolve_profile",
    { profiles: [partial] },
    JSON.stringify(resolved.profiles.continuation),
  );
}

{
  const resolved = resolveViewConfig({ profiles: [INTEGRAL_OVERRIDE] });
  add(
    "resolve_integral_builtin_override_verbatim",
    "resolve_profile",
    { profiles: [INTEGRAL_OVERRIDE] },
    JSON.stringify(resolved.profiles.continuation),
  );
}

add("violation_ok_fractional", "profile_violation", FRAC, null);
add("violation_ok_integral", "profile_violation", INTEGRAL_OVERRIDE, null);

add(
  "violation_sum_not_100_fractional",
  "profile_violation",
  {
    name: "bad_sum",
    lowerBound: 12.5,
    percentages: { full: 12.5, smooth: 47.5, detailed: 20, brief: 19.5 },
  },
  profileViolation({
    name: "bad_sum",
    lowerBound: 12.5,
    percentages: { full: 12.5, smooth: 47.5, detailed: 20, brief: 19.5 },
  }),
);

// Floating sum artifact: IEEE residue so sum !== 100 but looks near 100.
{
  const shares = { full: 33.3, smooth: 33.3, detailed: 33.3, brief: 0.1 };
  const sum = shares.full + shares.smooth + shares.detailed + shares.brief;
  if (sum === 100) throw new Error("sum-artifact case collapsed to exact 100");
  add(
    "violation_sum_float_artifact",
    "profile_violation",
    { name: "sum_art", lowerBound: 100, percentages: shares },
    profileViolation({ name: "sum_art", lowerBound: 100, percentages: shares }),
  );
}

add(
  "violation_lower_bound_zero",
  "profile_violation",
  {
    name: "z",
    lowerBound: 0,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "z",
    lowerBound: 0,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_lower_bound_negative_zero",
  "profile_violation",
  {
    name: "neg0",
    lowerBound: "-0",
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "neg0",
    lowerBound: -0,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_lower_bound_nan",
  "profile_violation",
  {
    name: "nan_lb",
    lowerBound: "NaN",
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "nan_lb",
    lowerBound: Number.NaN,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_lower_bound_infinity",
  "profile_violation",
  {
    name: "inf_lb",
    lowerBound: "Infinity",
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "inf_lb",
    lowerBound: Number.POSITIVE_INFINITY,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_lower_bound_neg_infinity",
  "profile_violation",
  {
    name: "ninf_lb",
    lowerBound: "-Infinity",
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "ninf_lb",
    lowerBound: Number.NEGATIVE_INFINITY,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

// Amendment I — reachable |x| ≥ 1e21 Node exponent spelling (`1e+21`).
add(
  "violation_lower_bound_neg_1e21",
  "profile_violation",
  {
    name: "neg_1e21",
    lowerBound: -1e21,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "neg_1e21",
    lowerBound: -1e21,
    percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_sum_1e21",
  "profile_violation",
  {
    name: "sum_1e21",
    lowerBound: 100,
    percentages: { full: 1e21, smooth: 0, detailed: 0, brief: 0 },
  },
  profileViolation({
    name: "sum_1e21",
    lowerBound: 100,
    percentages: { full: 1e21, smooth: 0, detailed: 0, brief: 0 },
  }),
);

add(
  "violation_percentage_negative",
  "profile_violation",
  {
    name: "neg_pct",
    lowerBound: 100,
    percentages: { full: -1, smooth: 51, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "neg_pct",
    lowerBound: 100,
    percentages: { full: -1, smooth: 51, detailed: 25, brief: 25 },
  }),
);

add(
  "violation_percentage_nan",
  "profile_violation",
  {
    name: "nan_pct",
    lowerBound: 100,
    percentages: { full: "NaN", smooth: 50, detailed: 25, brief: 25 },
  },
  profileViolation({
    name: "nan_pct",
    lowerBound: 100,
    percentages: { full: Number.NaN, smooth: 50, detailed: 25, brief: 25 },
  }),
);

// ── selection — all four production budget shares load-bearing ───

{
  const inputs = selectionFixtureInputs();
  const { lowerBound, percentages } = LOAD_BEARING_SELECTION;
  const result = selectArrangement(inputs, { lowerBound, percentages });
  const bands = new Set(result.entries.map((e) => e.band));
  if (result.entries.length < 6) {
    throw new Error(
      `selection load-bearing oracle too thin: entries.length=${result.entries.length}`,
    );
  }
  for (const need of ["brief", "detailed", "smooth"]) {
    if (!bands.has(need)) {
      throw new Error(
        `selection load-bearing oracle missing ${need} band subjects`,
      );
    }
  }
  add(
    "selection_all_band_budgets_load_bearing",
    "selection",
    {
      lowerBound,
      percentages,
      selectionInputs: selectionInputsForFixture(inputs),
    },
    projectSelection(result),
  );
}

// ── selection — fractional vs truncated operands (Amendment I arithmetic) ──

{
  const turns = [
    { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 1, closedAt: 5 },
    { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 6, closedAt: 10 },
  ];
  const messages = [];
  for (let i = 1; i <= 5; i += 1) {
    messages.push({
      messageId: `a${i}`,
      turnId: "t1",
      order: i,
      kind: "user_prompt",
      text: "x",
      tokenEstimate: 1,
    });
  }
  for (let i = 6; i <= 10; i += 1) {
    messages.push({
      messageId: `b${i}`,
      turnId: "t2",
      order: i,
      kind: "user_prompt",
      text: "x",
      tokenEstimate: 1,
    });
  }
  const inputs = {
    messages,
    turns,
    chunks: [],
    derivations: new Map(),
    maxEventOrder: 10,
    derivationCounts: {},
  };
  const lowerBound = 60;
  const percentages = { full: 12.5, smooth: 47.5, detailed: 20, brief: 20 };
  const truncatedPercentages = { full: 12, smooth: 48, detailed: 20, brief: 20 };
  const fractional = selectArrangement(inputs, { lowerBound, percentages });
  const truncated = selectArrangement(inputs, {
    lowerBound,
    percentages: truncatedPercentages,
  });
  const fractionalProj = projectSelection(fractional);
  const truncatedProj = projectSelection(truncated);
  if (fractionalProj.compactPoint === truncatedProj.compactPoint) {
    throw new Error(
      `selection fractional vs truncated oracle collapsed: both compactPoint=${fractionalProj.compactPoint}`,
    );
  }
  add(
    "selection_fractional_vs_truncated_operands",
    "selection",
    {
      lowerBound,
      percentages,
      truncatedPercentages,
      selectionInputs: selectionInputsForFixture(inputs),
    },
    {
      fractional: fractionalProj,
      truncated: truncatedProj,
    },
  );
}

// ── real compact → SQLite / receipt / describe / inspect ─────────

const scratch = mkdtempSync(join(tmpdir(), "lhc-profile-number-"));
try {
  const registryPath = join(scratch, "registry.sqlite");
  const filePath = join(scratch, "thread.sqlite");
  const sdk = initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    view: { profiles: [FRAC] },
  });
  const created = await sdk.threads.newThread({ filePath, registryPath });
  if (!created.ok) throw new Error(created.error.reason);

  // One closed turn + messages so compact has a live record.
  const events = [
    {
      eventKind: "user_prompt",
      idempotencyKey: "k1",
      actor: "oracle",
      harness: "profile-number",
      payload: { text: "hello fractional" },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: "k2",
      actor: "oracle",
      harness: "profile-number",
      payload: { text: "world" },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: "k3",
      actor: "oracle",
      harness: "profile-number",
      payload: {},
    },
  ];
  const ingested = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!ingested.ok) throw new Error(ingested.error.reason);

  // Nested derivationCounts: seed real rows before compact so readSelectionInputs
  // + compact produce source_state_json (not a hand-built replaceViewSnapshot).
  // Clear intake-queued derivation stubs and work items so migrate/open
  // does not re-seed pre_detailed_assembly. The five seeded rows alone
  // determine GROUP BY counts (smoothed_prompt ready×2 pending×1,
  // detailed_turn_compression ready×1 failed×1).
  const seedDb = new DatabaseSync(filePath);
  seedDb.exec("DELETE FROM derivation");
  seedDb.exec("DELETE FROM work_item");
  const nestedDerivationRows = [
    ["message", "m1", "smoothed_prompt", "ready"],
    ["message", "m2", "smoothed_prompt", "ready"],
    ["message", "m3", "smoothed_prompt", "pending"],
    ["turn", "t1", "detailed_turn_compression", "ready"],
    ["turn", "t2", "detailed_turn_compression", "failed"],
  ];
  const insertDerivation = seedDb.prepare(
    `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
     VALUES (?, ?, ?, ?, 1)`,
  );
  for (const [subjectKind, subjectId, derivationType, state] of nestedDerivationRows) {
    insertDerivation.run(subjectKind, subjectId, derivationType, state);
  }
  seedDb.close();

  const compactResult = await sdk.threadView.compact(
    { filePath },
    { profile: "fractional" },
  );
  if (!compactResult.ok) throw new Error(compactResult.error.reason);
  const receipt = compactResult.value;

  const db = new DatabaseSync(filePath);
  const row = db.prepare("SELECT config_json, source_state_json FROM thread_view LIMIT 1").get();
  if (!row) throw new Error("compact wrote no thread_view row");
  const rawConfigJson = row.config_json;
  const rawSourceStateJson = row.source_state_json;
  db.close();

  const described = await sdk.threadView.describe({ filePath });
  if (!described.ok) throw new Error(described.error.reason);
  if (described.value === null) throw new Error("describe returned null after compact");

  const inspected = await inspectView({ filePath });
  if (!inspected.ok) throw new Error(inspected.error.reason);
  if (inspected.value.meta === null) {
    throw new Error("inspect.view meta null after compact");
  }

  add(
    "stored_config_fractional_from_compact",
    "stored_config_json",
    { lowerBound: FRAC.lowerBound, percentages: FRAC.percentages },
    rawConfigJson,
  );
  add(
    "receipt_config_fractional_from_compact",
    "receipt_config_json",
    { lowerBound: FRAC.lowerBound, percentages: FRAC.percentages },
    JSON.stringify(receipt.config),
  );
  add(
    "describe_config_fractional_from_describe",
    "describe_config_json",
    { lowerBound: FRAC.lowerBound, percentages: FRAC.percentages },
    JSON.stringify(described.value.config),
  );
  add(
    "inspect_meta_config_fractional_from_inspect_view",
    "inspect_meta_config_json",
    { lowerBound: FRAC.lowerBound, percentages: FRAC.percentages },
    JSON.stringify(inspected.value.meta.config),
  );

  const parsedSourceState = JSON.parse(rawSourceStateJson);
  if (
    !parsedSourceState.derivationCounts ||
    Object.keys(parsedSourceState.derivationCounts).length < 2
  ) {
    throw new Error(
      `nested source_state missing multi-type counts: ${rawSourceStateJson}`,
    );
  }
  add(
    "source_state_nested_derivation_counts",
    "source_state_json",
    { note: "from compact derivationCounts" },
    rawSourceStateJson,
  );

  /** @param {number} lowerBound */
  async function storedConfigFromCompact(lowerBound) {
    const percentages = { full: 25, smooth: 25, detailed: 25, brief: 25 };
    const result = await sdk.threadView.compact(
      { filePath },
      { params: { lowerBound, percentages } },
    );
    if (!result.ok) throw new Error(result.error.reason);
    const readDb = new DatabaseSync(filePath);
    const configRow = readDb
      .prepare("SELECT config_json FROM thread_view LIMIT 1")
      .get();
    readDb.close();
    if (!configRow) throw new Error("compact wrote no thread_view row");
    return { percentages, configJson: configRow.config_json };
  }

  {
    const { percentages, configJson } = await storedConfigFromCompact(1e-6);
    add(
      "stored_config_small_exponent_leaves",
      "stored_config_json",
      { lowerBound: 1e-6, percentages },
      configJson,
    );
  }
  {
    const { percentages, configJson } = await storedConfigFromCompact(1e-7);
    add(
      "stored_config_below_1e_minus_6",
      "stored_config_json",
      { lowerBound: 1e-7, percentages },
      configJson,
    );
  }
  // Amendment I — valid positive lowerBound at Node's large-exponent boundary.
  // profileViolation(1e21) is null; compact → SQLite spells `1e+21`.
  {
    const { percentages, configJson } = await storedConfigFromCompact(1e21);
    add(
      "stored_config_large_exponent_1e21",
      "stored_config_json",
      { lowerBound: 1e21, percentages },
      configJson,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const body = `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`;
writeFileSync(outPath, body);
console.log(`wrote ${cases.length} cases → ${outPath}`);

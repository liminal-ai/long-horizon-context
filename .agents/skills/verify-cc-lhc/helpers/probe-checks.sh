#!/usr/bin/env bash
# Broken-case probes: each evidence check must fail on a broken input and pass on the good one.
set -u
. "$(dirname "$0")/lib.sh"
PROBE_DIR="$EVIDENCE_DIR/probe"
mkdir -p "$PROBE_DIR"
H="$SKILL_DIR/helpers"

expect() {
  local want="$1" label="$2" reason="$3"; shift 3
  "$@" >"$PROBE_DIR/$label.txt" 2>&1
  local rc=$?
  if [ "$want" = pass ] && [ "$rc" -eq 0 ]; then
    pass "probe $label: passes on the good input"
  elif [ "$want" = fail ] && [ "$rc" -ne 0 ] && grep -q "$reason" "$PROBE_DIR/$label.txt"; then
    pass "probe $label: fails on the broken input ($(grep -m1 "$reason" "$PROBE_DIR/$label.txt" | cut -c1-160))"
  else
    fail "probe $label: wanted $want, got rc=$rc (see probe/$label.txt)"
  fi
}

drive() {
  local label="$1"; shift
  env VERIFY_CC_LHC_EVIDENCE="$PROBE_DIR/$label-evidence" "$@"
}

parse_summary() {
  if capture_ingested "$1" "$2"; then echo "ingested: $1"; else echo "capture ingested nothing: $1"; return 1; fi
}
expect pass capture-summary-reordered "" parse_summary "cc-lhc-capture thread=th_abc lines=2 skipped_meta=0 events=3" th_abc
expect fail capture-summary-zero "capture ingested nothing" parse_summary "cc-lhc-capture lines=0 events=0 thread=none" th_abc
expect fail capture-summary-other-thread "capture ingested nothing" \
  parse_summary "cc-lhc-capture lines=2 events=3 thread=th_abcd" th_abc

expect fail capture-zero-ingest "capture ingested nothing" \
  drive capture-zero-ingest env VERIFY_CC_LHC_CAPTURE_BIN="$STANDIN" "$H/drive-capture.sh"
expect pass capture-good "" drive capture-good "$H/drive-capture.sh"
expect pass compact-good "" drive compact-good "$H/drive-smart-compact.sh"

GOOD="$PROBE_DIR/compact-good-evidence"
if [ -f "$GOOD/compact-source.jsonl" ] && [ -f "$GOOD/compact-rebuilt.jsonl" ]; then
  for case in "reminder-duplicate:entry not in source" "exact-duplicate:entry duplicated" \
    "notice-as-assistant:entry not in source" "reordered:differs from source tail" \
    "compacted-and-verbatim:also inside a compacted block" "note-only:history lost" \
    "removed-context:history lost"; do
    kind="${case%%:*}"
    node -e '
      const fs = require("fs");
      const [src, out, kind] = process.argv.slice(1);
      const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const text = (l) => typeof l.message?.content === "string" ? l.message.content : "";
      const note = lines.findLastIndex((l) => l.type === "user" && text(l).startsWith("[runtime note] "));
      const at = lines.findIndex((l) => l.type === "user" && text(l) !== "" && !text(l).startsWith("[context · "));
      const first = lines[at];
      if (kind === "reminder-duplicate") {
        lines.splice(at + 1, 0, { ...first, message: { ...first.message,
          content: `<system-reminder>\nInjected by the CLI.\n</system-reminder>\n${text(first)}` } });
      } else if (kind === "exact-duplicate") {
        lines.splice(at + 1, 0, first);
      } else if (kind === "compacted-and-verbatim") {
        const c = lines.find((l) => l.type === "user" && text(l).startsWith("[context · "));
        c.message = { ...c.message, content: `${text(c)}\n${text(first)}` };
      } else if (kind === "reordered") {
        const [moved] = lines.splice(at, 1);
        lines.splice(note - 1, 0, moved);
      } else if (kind === "note-only") {
        lines.splice(0, note);
      } else if (kind === "removed-context") {
        lines.splice(0, lines.length, ...lines.filter((l) => !text(l).startsWith("[context · ")));
      } else {
        const ref = lines.find((l) => l.type === "assistant");
        lines.splice(note, 0, { ...ref, message: { ...ref.message, content: [{ type: "text", text: "Auto mode is on." }] } });
      }
      fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    ' "$GOOD/compact-rebuilt.jsonl" "$PROBE_DIR/rebuilt-$kind.jsonl" "$kind"
    expect fail "content-$kind" "${case#*:}" \
      node "$H/check-rebuilt-content.mjs" --source "$GOOD/compact-source.jsonl" \
      --rebuilt "$PROBE_DIR/rebuilt-$kind.jsonl"
  done
  expect pass content-good "" node "$H/check-rebuilt-content.mjs" --source "$GOOD/compact-source.jsonl" \
    --rebuilt "$GOOD/compact-rebuilt.jsonl"
else
  fail "probe content-*: compact-good wrote no source/rebuilt pair (see probe/compact-good.txt)"
fi

fixture() {
  node -e '
    const [out, ...pairs] = process.argv.slice(1);
    const line = (role, text) => JSON.stringify(role === "user"
      ? { type: "user", message: { role: "user", content: text } }
      : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    const lines = [];
    for (let i = 0; i < pairs.length; i += 2) lines.push(line(pairs[i], pairs[i + 1]));
    require("fs").writeFileSync(out, lines.join("\n") + "\n");
  ' "$@"
}
F="$PROBE_DIR/fixtures"
mkdir -p "$F"
fixture "$F/collision-source.jsonl" user "What should the enabled setting be?" assistant "The setting should be yes." \
  user yes assistant Done.
fixture "$F/collision-rebuilt.jsonl" user $'[context · detailed]\nUser: What should the enabled setting be?\nAssistant: The setting should be yes.' \
  user yes assistant Done. user "[runtime note] rebuilt"
expect pass content-substring-collision "" node "$H/check-rebuilt-content.mjs" \
  --source "$F/collision-source.jsonl" --rebuilt "$F/collision-rebuilt.jsonl"
NOTES=(user prompt1 assistant answer1 user "[runtime note] [lhc compact:auto] earlier receipt" user prompt2 assistant answer2)
fixture "$F/prior-note-source.jsonl" "${NOTES[@]}"
fixture "$F/prior-note-rebuilt.jsonl" "${NOTES[@]}" user "[runtime note] [lhc compact:auto] new receipt"
expect pass content-prior-runtime-note "" node "$H/check-rebuilt-content.mjs" \
  --source "$F/prior-note-source.jsonl" --rebuilt "$F/prior-note-rebuilt.jsonl"
if node "$H/roundtrip-multiblock.mjs" "$REPO_ROOT" "$SCRATCH_DIR" "$F" >"$PROBE_DIR/multiblock-roundtrip.txt" 2>&1; then
  expect pass content-multiblock-roundtrip "" node "$H/check-rebuilt-content.mjs" \
    --source "$F/multiblock-source.jsonl" --rebuilt "$F/multiblock-rebuilt.jsonl"
else
  fail "probe content-multiblock-roundtrip: production roundtrip failed (see probe/multiblock-roundtrip.txt)"
fi

for d in "$PROBE_DIR"/*-evidence; do
  VERIFY_CC_LHC_EVIDENCE="$d" "$H/cleanup.sh" >/dev/null
done
finish probe-checks

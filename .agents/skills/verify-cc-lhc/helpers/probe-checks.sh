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

mutate() {
  node -e '
    const fs = require("fs");
    const [src, out, kind] = process.argv.slice(1);
    const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const text = (l) => typeof l.message?.content === "string" ? l.message.content : "";
    const isBand = (l) => l.type === "user" && text(l).startsWith("[context · ");
    const note = lines.findLastIndex((l) => l.type === "user" && text(l).startsWith("[runtime note] "));
    const at = lines.findIndex((l) => l.type === "user" && text(l) !== "" && !isBand(l));
    const first = lines[at];
    const band = lines.find(isBand);
    if (kind === "reminder-duplicate") {
      lines.splice(at + 1, 0, { ...first, message: { ...first.message,
        content: `<system-reminder>\nInjected by the CLI.\n</system-reminder>\n${text(first)}` } });
    } else if (kind === "exact-duplicate") {
      lines.splice(at + 1, 0, first);
    } else if (kind === "compacted-and-verbatim") {
      band.message = { ...band.message, content: `${text(band)}\n${text(first)}` };
    } else if (kind === "reordered") {
      const [moved] = lines.splice(at, 1);
      lines.splice(note - 1, 0, moved);
    } else if (kind === "note-only") {
      lines.splice(0, note);
    } else if (kind === "removed-context") {
      lines.splice(0, lines.length, ...lines.filter((l) => !isBand(l)));
    } else if (kind === "one-context-removed") {
      lines.splice(lines.indexOf(band), 1);
    } else if (kind === "context-altered") {
      band.message = { ...band.message, content: text(band).replace("ALDER-7", "ALDER-8") };
    } else {
      const ref = lines.find((l) => l.type === "assistant");
      lines.splice(note, 0, { ...ref, message: { ...ref.message, content: [{ type: "text", text: "Auto mode is on." }] } });
    }
    fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  ' "$@"
}

GOOD="$PROBE_DIR/compact-good-evidence"
if [ -f "$GOOD/compact-source.jsonl" ] && [ -f "$GOOD/compact-rebuilt.jsonl" ] && [ -f "$GOOD/compact-view.json" ]; then
  for case in "reminder-duplicate:entry not in source" "exact-duplicate:entry duplicated" \
    "notice-as-assistant:entry not in source" "reordered:differs from source tail" \
    "compacted-and-verbatim:context block 1 differs" "note-only:context blocks: rebuilt has 0" \
    "removed-context:context blocks: rebuilt has 0" "one-context-removed:context blocks: rebuilt has 1" \
    "context-altered:context block 1 differs"; do
    kind="${case%%:*}"
    mutate "$GOOD/compact-rebuilt.jsonl" "$PROBE_DIR/rebuilt-$kind.jsonl" "$kind"
    expect fail "content-$kind" "${case#*:}" node "$H/check-rebuilt-content.mjs" \
      --source "$GOOD/compact-source.jsonl" --rebuilt "$PROBE_DIR/rebuilt-$kind.jsonl" --view "$GOOD/compact-view.json"
  done
  expect pass content-good "" node "$H/check-rebuilt-content.mjs" --source "$GOOD/compact-source.jsonl" \
    --rebuilt "$GOOD/compact-rebuilt.jsonl" --view "$GOOD/compact-view.json"
else
  fail "probe content-*: compact-good wrote no source/rebuilt/view triple (see probe/compact-good.txt)"
fi

F="$PROBE_DIR/roundtrip"
mkdir -p "$F"
if node "$H/roundtrip.mjs" "$SCRATCH_DIR" "$F" >"$PROBE_DIR/roundtrip.txt" 2>&1; then
  for case in substring-collision:collision prior-runtime-note:prior-note multiblock-roundtrip:multiblock \
    user-multiblock:user-multiblock chrome:chrome continuation-marker:continuation; do
    name="${case#*:}"
    expect pass "content-${case%%:*}" "" node "$H/check-rebuilt-content.mjs" \
      --source "$F/$name-source.jsonl" --rebuilt "$F/$name-rebuilt.jsonl" --view "$F/$name-view.json"
  done
  mutate "$F/collision-rebuilt.jsonl" "$F/collision-duplicate-rebuilt.jsonl" compacted-and-verbatim
  expect fail content-collision-duplicate "context block 1 differs" node "$H/check-rebuilt-content.mjs" \
    --source "$F/collision-source.jsonl" --rebuilt "$F/collision-duplicate-rebuilt.jsonl" --view "$F/collision-view.json"
else
  fail "probe content-roundtrip: production roundtrip failed (see probe/roundtrip.txt)"
fi

for d in "$PROBE_DIR"/*-evidence; do
  VERIFY_CC_LHC_EVIDENCE="$d" "$H/cleanup.sh" >/dev/null
done
finish probe-checks

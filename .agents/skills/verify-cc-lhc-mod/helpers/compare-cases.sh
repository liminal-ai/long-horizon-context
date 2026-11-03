#!/usr/bin/env bash
set -u
dir="$(dirname "$0")/compare-cases"
fail=0
while IFS=$'\t' read -r name want; do
  node "$(dirname "$0")/compare.mjs" "$dir/$name.json" "$dir/$name.jsonl" >/dev/null
  got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name exit $got"; else echo "FAIL $name exit $got, want $want"; fail=1; fi
done <"$dir/cases.tsv"
[ "$fail" = 0 ] && echo "compare-cases: PASS" || { echo "compare-cases: FAIL"; exit 1; }

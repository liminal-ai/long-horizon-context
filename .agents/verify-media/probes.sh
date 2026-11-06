#!/usr/bin/env bash
# Broken-case probes for capture.mjs and publish.mjs, run against a real PR.
# usage: probes.sh --pr <n> --base-checkout <dir> --head-checkout <dir> <good run dir> <scratch dir>
# <good run dir> is a capture.mjs run of PR <n> that publishes; it is published twice (the rerun case).
# The head checkout must be clean at the PR's head, the base checkout clean at its merge base.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pr="" base_co="" head_co=""
while [ $# -gt 2 ]; do
  case "$1" in
    --pr) pr="$2"; shift 2 ;;
    --base-checkout) base_co="$(cd "$2" && pwd)"; shift 2 ;;
    --head-checkout) head_co="$(cd "$2" && pwd)"; shift 2 ;;
    *) break ;;
  esac
done
if [ -z "$pr" ] || [ -z "$base_co" ] || [ -z "$head_co" ] || [ $# -ne 2 ]; then
  sed -n '3,5p' "$0" >&2
  exit 2
fi
good="$(cd "$1" && pwd)"
scratch="$(mkdir -p "$2" && cd "$2" && pwd)"
probe_dir="$(mktemp -d "$scratch/media-probes-XXXXXX")"
session="lhc-media-probe-$$"
failures=0
trap 'tmux kill-session -t "=$session" 2>/dev/null || true' EXIT

row() { printf '| %s | %s | %s |\n' "$1" "$2" "$3" | tee -a "$probe_dir/table.md"; }
expect() {
  local name="$1" want_rc="$2" want_text="$3" rc="$4" out="$5"
  if [ "$rc" = "$want_rc" ] && grep -qF -- "$want_text" "$out"; then
    row "$name" "exit $want_rc, \`$want_text\`" "PASS: exit $rc, $(grep -m1 -F -- "$want_text" "$out" | cut -c1-140)"
  else
    row "$name" "exit $want_rc, \`$want_text\`" "FAIL: exit $rc, $(tail -n1 "$out" | cut -c1-140)"
    failures=$((failures + 1))
  fi
}
screen() { tmux kill-session -t "=$session" 2>/dev/null; tmux new-session -d -s "$session" -x 80 -y 8 "printf '%s\n' '$1'; exec sleep 120"; }
capture() { node "$here/capture.mjs" --session "$session" --step probe --wait-for "$2" --checkout "$1" --side "$3" "$4"; }
publish() { node "$here/publish.mjs" --pr "$pr" --title "probe" "$@"; }

echo "| Case | Expected | Actual |" | tee "$probe_dir/table.md"
echo "| --- | --- | --- |" | tee -a "$probe_dir/table.md"

run="$probe_dir/token"
screen "export ANTHROPIC_AUTH_TOKEN=sk-ant-probe0000000000"
capture "$head_co" "sk-ant" head "$run" >"$probe_dir/token.out" 2>&1
rc=$?
[ -e "$run/head/probe.png" ] && echo "token capture wrote a PNG" >>"$probe_dir/token.out" && rc=99
expect "token-shaped text on screen" 1 "capture REFUSED: the pane shows a token-shaped string" "$rc" "$probe_dir/token.out"

run="$probe_dir/dirty"
screen "probe screen"
capture "$base_co" "probe screen" base "$run" >/dev/null
marker="$head_co/.media-probe-untracked-$$"
: >"$marker"
capture "$head_co" "probe screen" head "$run" >/dev/null
rm -f "$marker"
publish "$run" >"$probe_dir/dirty.out" 2>&1
expect "head captured from a dirty checkout" 1 "with uncommitted changes" $? "$probe_dir/dirty.out"

run="$probe_dir/wrong-commit"
capture "$base_co" "probe screen" base "$run" >/dev/null
capture "$base_co" "probe screen" head "$run" >/dev/null
publish "$run" >"$probe_dir/wrong-commit.out" 2>&1
expect "head captured at another commit" 1 "not PR $pr's head" $? "$probe_dir/wrong-commit.out"

copy_good() { mkdir -p "$1" && cp -r "$good/base" "$good/head" "$1/"; }

run="$probe_dir/upload-fails"
copy_good "$run"
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 publish "$run" >"$probe_dir/upload-fails.out" 2>&1
rc=$?
[ -e "$run/published.json" ] && rc=98
expect "upload refused by Cloudflare" 1 "publish FAILED: upload of" "$rc" "$probe_dir/upload-fails.out"

run="$probe_dir/no-read-back"
copy_good "$run"
shim="$probe_dir/shim"
mkdir -p "$shim"
cat >"$shim/cf" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = "--id" ] && id="$2"; shift; done
printf '{"id":"%s","variants":["https://imagedelivery.net/no-such-account-hash/%s/public"]}\n' "$id" "$id"
EOF
chmod +x "$shim/cf"
PATH="$shim:$PATH" publish "$run" >"$probe_dir/no-read-back.out" 2>&1
rc=$?
[ -e "$run/published.json" ] && rc=98
expect "public URL does not read back" 1 "reads back 40" "$rc" "$probe_dir/no-read-back.out"

publish "$good" >"$probe_dir/publish-1.out" 2>&1
first=$?
publish "$good" >"$probe_dir/publish-2.out" 2>&1
second=$?
url1="$(grep -o 'https://github.com/[^ ]*#issuecomment-[0-9]*' "$probe_dir/publish-1.out")"
url2="$(grep -o 'https://github.com/[^ ]*#issuecomment-[0-9]*' "$probe_dir/publish-2.out")"
if [ "$first" = 0 ] && [ "$second" = 0 ] && [ -n "$url1" ] && [ "$url1" = "$url2" ] &&
  grep -q "^uploaded 0 images" "$probe_dir/publish-2.out" && grep -q "^updated comment" "$probe_dir/publish-2.out"; then
  row "rerun of a published run" "exit 0, uploads nothing, updates the same comment" "PASS: uploaded 0 images, updated $url2"
else
  row "rerun of a published run" "exit 0, uploads nothing, updates the same comment" "FAIL: exits $first/$second, comments $url1 / $url2"
  failures=$((failures + 1))
fi

echo "outputs: $probe_dir"
[ "$failures" -eq 0 ] && echo "verify-media probes: PASS" || echo "verify-media probes: FAIL ($failures)"
[ "$failures" -eq 0 ]

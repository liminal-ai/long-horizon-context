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
server_pid=""
trap 'tmux kill-session -t "=$session" 2>/dev/null || true; [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null' EXIT

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
screen() {
  printf '%s\n' "$1" >"$probe_dir/screen.txt"
  tmux kill-session -t "=$session" 2>/dev/null
  tmux new-session -d -s "$session" -x "${2:-80}" -y 8 "cat '$probe_dir/screen.txt'; exec sleep 120"
}
capture() { node "$here/capture.mjs" --session "$session" --step probe --wait-for "$2" --checkout "$1" --side "$3" "$4" "${@:5}"; }
publish() { node "$here/publish.mjs" --pr "$pr" "$@"; }

echo "| Case | Expected | Actual |" | tee "$probe_dir/table.md"
echo "| --- | --- | --- |" | tee -a "$probe_dir/table.md"

run="$probe_dir/token"
screen "export ANTHROPIC_AUTH_TOKEN=sk-ant-probe0000000000"
capture "$head_co" "sk-ant" head "$run" >"$probe_dir/token.out" 2>&1
rc=$?
[ -e "$run/head/probe.png" ] && echo "token capture wrote a PNG" >>"$probe_dir/token.out" && rc=99
expect "token-shaped text on screen" 1 "capture REFUSED: the pane shows a token-shaped string" "$rc" "$probe_dir/token.out"

# Synthetic credentials only, in the shapes the #81 verifier showed slipping through.
token_case() {
  local name="$1" text="$2" width="$3" wait="$4" label="$5"
  run="$probe_dir/$name"
  screen "$text" "$width"
  capture "$head_co" "$wait" head "$run" >"$probe_dir/$name.out" 2>&1
  rc=$?
  [ -e "$run/head/probe.png" ] && echo "token capture wrote a PNG" >>"$probe_dir/$name.out" && rc=99
  expect "$label" 1 "capture REFUSED: the pane shows a token-shaped string" "$rc" "$probe_dir/$name.out"
}
token_case env-key "KEY=0123456789abcdef0123456789abcdef01234567" 100 "KEY=" "env-style secret assignment"
token_case env-key-punct "KEY=synthetic!Key@12345#6789" 100 "KEY=" "secret assignment with punctuation"
token_case password-quoted 'PASSWORD="synthetic!Password@1234#"' 100 "PASSW" "quoted password with punctuation"
token_case jwt "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMtcHJvYmUifQ.c3ludGhldGljc2lnbmF0dXJl" 120 "eyJ" "JWT"
token_case bearer-newline $'Bearer\nsyntheticOauthToken0123456789' 100 "Bearer" "Bearer token on the next line"
token_case bearer-wrap "$(printf '%77s' '')Bearer syntheticOauthToken0123456789" 80 "Bea" "Bearer split by the pane's line wrap"

run="$probe_dir/token-video"
printf 'clean frame\n' >"$probe_dir/screen.txt"
tmux kill-session -t "=$session" 2>/dev/null
tmux new-session -d -s "$session" -x 80 -y 8 \
  "cat '$probe_dir/screen.txt'; sleep 1; echo 'export ANTHROPIC_AUTH_TOKEN=sk-ant-probe0000000000'; exec sleep 120"
capture "$head_co" "clean frame" head "$run" --record 3 >"$probe_dir/token-video.out" 2>&1
rc=$?
[ -e "$run/head/probe.mp4" ] && echo "token recording wrote an MP4" >>"$probe_dir/token-video.out" && rc=99
expect "token-shaped text in a later video frame" 1 "capture REFUSED: the pane shows a token-shaped string" "$rc" "$probe_dir/token-video.out"

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
first_step() { basename "$(ls "$good/head/"*.png | head -n1)" .png; }

run="$probe_dir/mixed-png-text"
copy_good "$run"
cp "$probe_dir/dirty/head/probe.png" "$run/head/$(first_step).png"
publish "$run" >"$probe_dir/mixed-png-text.out" 2>&1
expect "PNG swapped in from another capture" 1 "is not the pair capture.mjs wrote" $? "$probe_dir/mixed-png-text.out"

run="$probe_dir/mixed-runs"
copy_good "$run"
cp "$probe_dir/dirty/base/probe."* "$run/base/"
cp "$probe_dir/dirty/head/probe."* "$run/head/"
publish "$run" >"$probe_dir/mixed-runs.out" 2>&1
expect "one side's captures from two runs" 1 "captures come from more than one run" $? "$probe_dir/mixed-runs.out"

# A stub gh answers as user probe-me, lists the comments a case sets, records writes, and passes PR reads to gh on the original PATH.
stub="$probe_dir/stub"
mkdir -p "$stub"
cat >"$stub/gh" <<'STUB'
#!/usr/bin/env bash
if [ "$1 $2" = "api user" ]; then echo probe-me; exit 0; fi
if [ "$2" = "--paginate" ]; then cat "$STUB_COMMENTS"; exit 0; fi
if [ "$2" = "-X" ]; then
  echo "$3 $4" >>"$STUB_LOG"
  echo '{"html_url":"https://github.com/stub#issuecomment-1"}'
  exit 0
fi
PATH="$REAL_PATH" exec gh "$@"
STUB
cat >"$stub/cf" <<'STUB'
#!/usr/bin/env bash
echo "cf $*" >>"$STUB_LOG"
exit 1
STUB
chmod +x "$stub/gh" "$stub/cf"
stub_publish() {
  : >"$probe_dir/$1.log"
  STUB_COMMENTS="$probe_dir/$1.comments" STUB_LOG="$probe_dir/$1.log" REAL_PATH="$PATH" \
    PATH="$stub:$PATH" publish "$probe_dir/$1" >"$probe_dir/$1.out" 2>&1
}
head_sha="$(git -C "$head_co" rev-parse HEAD)"

# The foreign-author probe reuses the good run's published.json, so the good run publishes first.
publish "$good" >"$probe_dir/publish-1.out" 2>&1
first=$?

run="$probe_dir/foreign-author"
copy_good "$run"
cp "$good/published.json" "$run/" 2>/dev/null
printf '{"id":987654321,"login":"another-person","body":"<!-- lhc-captures -->\\n<!-- lhc-captures-state {\\"head\\":\\"%s\\",\\"runs\\":[]} -->"}\n' \
  "$head_sha" >"$probe_dir/foreign-author.comments"
stub_publish foreign-author
rc=$?
if [ "$rc" = 0 ] && grep -q "^added comment" "$probe_dir/foreign-author.out" &&
  grep -q "^POST " "$probe_dir/foreign-author.log" && ! grep -q 987654321 "$probe_dir/foreign-author.log"; then
  row "another author's marked comment" "exit 0, posts its own comment, never edits theirs" "PASS: $(tr '\n' ' ' <"$probe_dir/foreign-author.log")"
else
  row "another author's marked comment" "exit 0, posts its own comment, never edits theirs" \
    "FAIL: exit $rc, $(tr '\n' ' ' <"$probe_dir/foreign-author.log" | cut -c1-140)"
  failures=$((failures + 1))
fi

run="$probe_dir/malformed-state"
copy_good "$run"
printf '{"id":123,"login":"probe-me","body":"<!-- lhc-captures -->\\n<!-- lhc-captures-state {not json} -->"}\n' \
  >"$probe_dir/malformed-state.comments"
stub_publish malformed-state
rc=$?
[ -s "$probe_dir/malformed-state.log" ] && echo "stub saw: $(cat "$probe_dir/malformed-state.log")" >>"$probe_dir/malformed-state.out" && rc=97
expect "own marked comment with broken state" 1 "its state is not JSON" "$rc" "$probe_dir/malformed-state.out"

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

# Video cases. Each records its own short base and head video, so they run whatever the good run holds.
video="$probe_dir/video"
screen "probe video"
capture "$base_co" "probe video" base "$video" --step clip --record 2 >/dev/null
capture "$head_co" "probe video" head "$video" --step clip --record 2 >/dev/null
copy_video() { mkdir -p "$1" && cp -r "$video/base" "$video/head" "$1/"; }

run="$probe_dir/video-changed"
copy_video "$run"
printf 'x' >>"$run/head/clip.mp4"
publish "$run" >"$probe_dir/video-changed.out" 2>&1
expect "video changed after capture" 1 "is not the pair capture.mjs wrote" $? "$probe_dir/video-changed.out"

run="$probe_dir/video-outside"
copy_video "$run"
mv "$run/head/clip.mp4" "$probe_dir/outside-clip.mp4"
ln -s "$probe_dir/outside-clip.mp4" "$run/head/clip.mp4"
publish "$run" >"$probe_dir/video-outside.out" 2>&1
expect "video outside the run dir" 1 "outside the run dir" $? "$probe_dir/video-outside.out"

run="$probe_dir/video-upload-fails"
copy_video "$run"
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 publish "$run" >"$probe_dir/video-upload-fails.out" 2>&1
rc=$?
[ -e "$run/published.json" ] && rc=98
expect "video upload refused by Cloudflare" 1 "publish FAILED: upload of" "$rc" "$probe_dir/video-upload-fails.out"

# A stub Stream: cf answers direct-upload and get for videos, uploads and reads go to a local server, and gh is the stub
# above, so nothing reaches Cloudflare Stream or the PR.
node -e 'require("http").createServer((q, s) => { q.resume(); q.on("end", () => s.end("ok")); })
  .listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })' \
  "$probe_dir/stream.port" &
server_pid=$!
for _ in $(seq 50); do [ -s "$probe_dir/stream.port" ] && break; sleep 0.1; done
stream="$probe_dir/stream-stub"
mkdir -p "$stream"
cp "$stub/gh" "$stream/gh"
cat >"$stream/cf" <<'STUB'
#!/usr/bin/env bash
origin="http://127.0.0.1:$(cat "$STREAM_PORT")"
case "$1 $2 $3" in
  "stream videos direct-upload")
    echo "direct-upload create" >>"$STUB_LOG"
    printf '{"uid":"%s","uploadURL":"%s/upload"}\n' "$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" "$origin" ;;
  "stream videos get")
    if [ "$STREAM_READY" = 1 ]; then
      printf '{"uid":"%s","readyToStream":true,"duration":2,"requireSignedURLs":false,"status":{"state":"ready"},"thumbnail":"%s/%s/thumbnails/thumbnail.jpg","preview":"%s/%s/watch","playback":{"hls":"%s/%s/manifest/video.m3u8"}}\n' \
        "$4" "$origin" "$4" "$origin" "$4" "$origin" "$4"
    else
      printf '{"uid":"%s","readyToStream":false,"status":{"state":"inprogress"}}\n' "$4"
    fi ;;
  *) echo "cf $*" >>"$STUB_LOG"; exit 1 ;;
esac
STUB
chmod +x "$stream/cf"
stream_publish() {
  local name="$1" ready="$2" log="$3"
  printf '' >"$probe_dir/$name.comments"
  STUB_COMMENTS="$probe_dir/$name.comments" STUB_LOG="$log" REAL_PATH="$PATH" STREAM_PORT="$probe_dir/stream.port" \
    STREAM_READY="$ready" PATH="$stream:$PATH" publish "$probe_dir/stream-run" --ready-timeout 4 >"$probe_dir/$name.out" 2>&1
}
copy_video "$probe_dir/stream-run"
: >"$probe_dir/stream.log"

stream_publish never-ready 0 "$probe_dir/stream.log"
rc=$?
grep -q '^POST \|^PATCH ' "$probe_dir/stream.log" && rc=97
expect "video never ready to stream" 1 "is not ready to stream after 4 s" "$rc" "$probe_dir/never-ready.out"

stream_publish stream-ready 1 "$probe_dir/stream.log"
first_stream=$?
stream_publish stream-rerun 1 "$probe_dir/stream.log"
second_stream=$?
creates="$(grep -c '^direct-upload create' "$probe_dir/stream.log")"
if [ "$first_stream" = 0 ] && [ "$second_stream" = 0 ] && [ "$creates" = 2 ] &&
  grep -q "^uploaded 0 images and 0 videos" "$probe_dir/stream-ready.out" &&
  grep -q "^uploaded 0 images and 0 videos: " "$probe_dir/stream-rerun.out"; then
  row "video rerun after a never-ready failure, then again" "2 uploads in all, none on either rerun" \
    "PASS: $creates direct uploads, both reruns uploaded 0 images and 0 videos"
else
  row "video rerun after a never-ready failure, then again" "2 uploads in all, none on either rerun" \
    "FAIL: exits $first_stream/$second_stream, $creates direct uploads"
  failures=$((failures + 1))
fi
kill "$server_pid" 2>/dev/null
server_pid=""

publish "$good" >"$probe_dir/publish-2.out" 2>&1
second=$?
url1="$(grep -o 'https://github.com/[^ ]*#issuecomment-[0-9]*' "$probe_dir/publish-1.out")"
url2="$(grep -o 'https://github.com/[^ ]*#issuecomment-[0-9]*' "$probe_dir/publish-2.out")"
if [ "$first" = 0 ] && [ "$second" = 0 ] && [ -n "$url1" ] && [ "$url1" = "$url2" ] &&
  grep -q "^uploaded 0 images and 0 videos" "$probe_dir/publish-2.out" && grep -q "^updated comment" "$probe_dir/publish-2.out"; then
  row "rerun of a published run" "exit 0, uploads nothing, updates the same comment" "PASS: uploaded 0 images and 0 videos, updated $url2"
else
  row "rerun of a published run" "exit 0, uploads nothing, updates the same comment" "FAIL: exits $first/$second, comments $url1 / $url2"
  failures=$((failures + 1))
fi

echo "outputs: $probe_dir"
[ "$failures" -eq 0 ] && echo "verify-media probes: PASS" || echo "verify-media probes: FAIL ($failures)"
[ "$failures" -eq 0 ]

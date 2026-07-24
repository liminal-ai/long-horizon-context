You are the IMPLEMENTOR for Wave 6 repair round 3, a tiny final residual
touch-up. Resume Cursor session `69ec5846-0977-405e-9d43-066a29883440` in
explicit fast mode. Repo `/srv/work/long-horizon-context`, branch
`lhc-rs-port`. Do not commit or push. Do not touch the four root
`cc-lhc-*.txt` files. Work only in the exact files named below plus the Wave 6
ledger note.

Sol passed repair-r2. Fable failed on exactly three literal/diagnostic
residuals. Fix all three without changing any prior ruling or behavior surface:

1. `src/thread_view/internal/render.rs`: hoist four missing private real
   delimiter constants, exact TS bytes:
   - `"] "` from the tool-call template;
   - `"["` from the gap-line prefix;
   - `"\n"` from `lines.join("\n")`;
   - `"\n\n"` from `entryTexts.join("\n\n")`.
   Do not add keepalive references.
2. `tests/fixtures/pi_session_format.rs`: for a malformed array content block,
   mirror `Object.keys(array)` exactly. A non-empty JS array produces index
   keys (`"0,1,..."`), not an empty key string. Build the comma-joined decimal
   indices in order before the existing diagnostic.
3. In the same fixture, remove the invented
   `"pi-session-structure fixture read failed: "` wrapper. Propagate/panic with
   the underlying Rust filesystem error text directly, matching the already
   repaired bare JSON-parse error policy.
4. `PORT_STATUS.md`: record Sol PASS / Fable narrow FAIL for repair-r2 and
   these repair-r3 fixes; keep Wave 6 not certified and todo delta unchanged
   unless the gate proves otherwise.

Run `cargo fmt --check`, `cargo check --tests`, and
`python3 scripts/check_gate.py`. Byte-compare all seven assets. Use an isolated
probe proving a two-element array reports `"0,1"` in the key diagnostic.
You own cleanup only for exact temporary paths you create; list and remove
them. No general cleanup, commit, or push.

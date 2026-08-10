# cc-lhc-native

Exact OS process identity for cc-lhc ownership and liveness invariants, as an
ABI-stable Node-API addon (NAPI 8, plain C) with prebuilt-artifact loading.
Built for bead `long-horizon-context-0su.2.1` (Slice XP1); runtime integration
into `descriptor.ts` / `session-owner.ts` is Slice XP2.

## Identity contract

Every platform yields the same normalized shape; equality is exact string/number
comparison, never arithmetic, so unit differences between platforms are safe:

| platform | `bootId` | `starttime` (digits-only string) |
| --- | --- | --- |
| linux | `/proc/sys/kernel/random/boot_id` (per-boot UUID) | field 22 of `/proc/<pid>/stat`, clock ticks since boot |
| darwin | `sysctl kern.bootsessionuuid` (per-boot UUID) | `kinfo_proc` `p_starttime` as microseconds since epoch (exact kernel timeval — not seconds-resolution `ps`) |
| win32 | constant `win32-filetime-1601` | `GetProcessTimes` creation `FILETIME`, 100ns units since 1601 |

Windows needs no separate boot identity: the creation FILETIME is absolute and
kernel-held, so `pid + starttime` is already exact across boots. A pid whose
process has exited but whose kernel object is retained by open handles reports
`not_found` (dead for ownership purposes). All failures are results
(`invalid_pid | not_found | access_denied | native_error | unsupported_platform
| addon_unavailable`), never PID-alive fallbacks; callers fail closed.

`toPortableProcessIdentity` projects to the `{ pid, bootId, starttime }` schema
cc-lhc descriptors and owner leases already store, so XP2 can adopt exact
identity without a schema break.

## Loading

Resolution order (`src/loader.ts`):

1. `CC_LHC_IDENTITY_ADDON` env override — development/test seam only.
2. `prebuilds/<platform>-<arch>/cc_lhc_identity.node` — the released path,
   populated from CI-built artifacts; consumers never need a compiler.
3. `build/Release/cc_lhc_identity.node` — source-build/development path.

`targets.json` is the single source of truth for supported platform/arch pairs;
a target outside it fails with `UnsupportedPlatformTargetError` listing the
supported set before any filesystem probing. Loaded addons are verified against
a compiled-platform tag and `identityContractVersion` so a wrong or stale
artifact can never silently serve identities.

## Distribution and artifact policy

This is a **private workspace package**: cc-lhc consumes it inside this repo,
and end users receive it through the GitHub release/setup flow (Slices
XP3/XP4). It is not published to npm and makes no npm-tarball claims.

- `dist/`, `build/`, and `prebuilds/` are **generated and git-ignored** —
  never tracked, produced on demand.
- **Install never compiles.** binding.gyp would otherwise imply a
  `node-gyp rebuild` install step; the explicit no-op `install` script
  (`scripts/noop-install.mjs`) neutralizes it. Source builds happen only via
  the explicit `build:native` script.
- **Release bundle contract** (`src/release-bundle.ts`, enforced by
  `check:release-bundle`): a bundle directory must contain `package.json`,
  `README.md`, `targets.json`, the `dist/` runtime + type files, and
  `prebuilds/<platform>-<arch>/cc_lhc_identity.node` for every target in
  `targets.json`. Matrix jobs validate their own target with
  `--target <platform>-<arch>`; the aggregation step validates all targets.

The CI pipeline (`.github/workflows/native-platforms.yml`) defines a
required job per target — it has not yet had a successful run on GitHub, and
until it does these legs are a defined requirement, not executed evidence.
Per target it runs:
`build` → `build:native` → `stage:prebuild` → `test:native` →
`check:release-bundle --target <own>`, then the cc-lhc build/typecheck/test
with `CC_LHC_NATIVE_REQUIRE_ADDON=1`, and uploads the staged prebuild as the
`prebuild-<target>` artifact. One aggregation job downloads all six, runs
`scripts/assemble-release-bundle.mjs` (rejects missing/duplicate/unknown
artifacts), validates the full contract with `check:release-bundle`, and
uploads the bundle plus flat release-candidate assets
(`cc_lhc_identity-<target>.node` ×6 + `SHA256SUMS`; naming contract in
`scripts/asset-names.mjs`). End users acquire their verified prebuild with
`.setup/scripts/fetch-prebuild.mjs`, which checks the SHA-256 before
installing and load-probes the addon in a subprocess before replacing any
installed copy — no compiler. Release publishing itself is Slice XP4;
`test/workflow-consistency.test.ts` keeps workflow, manifest, and asset
naming in lockstep.

## Developing

All scripts run under native Windows cmd as well as macOS/Linux shells: no
`rm -rf`, no inline `VAR=x` env assignment, no nested pnpm-run (helpers are
plain Node scripts in `scripts/`).

```sh
# --config.verify-deps-before-run=false avoids the open pnpm 11.8.0 pre-run
# crash (long-horizon-context-52k).
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native    # node-gyp rebuild (needs a C toolchain + python3)
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild  # copy build output into prebuilds/<platform>-<arch>/
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run verify:native   # typecheck + source build + full tests
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run check:release-bundle  # validate a bundle (see --dir/--target)
```

On a source checkout, `test:native`/`verify:native` is the explicit local test
path: it builds the addon from source and runs the whole suite with
`CC_LHC_NATIVE_REQUIRE_ADDON=1`, so the compiled-addon tests cannot silently
skip. Plain `test`/`verify` stay toolchain-free and skip the compiled-addon
suites when no artifact exists.

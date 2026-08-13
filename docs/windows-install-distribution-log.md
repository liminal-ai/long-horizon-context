# Windows installation and distribution log

## 2026-08-13: First CI dogfood dispatch

- Added a branch-scoped `push` trigger for `codex/windows-npm-dogfood` because GitHub does not expose a new `workflow_dispatch` workflow until the workflow exists on the default branch.
- The trigger is intentionally limited to this dogfood branch and can be removed when the workflow reaches the default branch.

Status: active dogfood log

Started: 2026-08-13
Pilot platform: native Windows ARM64

## Purpose

Track the first user-facing native Windows installation and testing of `cc-lhc`, while maintaining the work needed for a smooth no-compiler distribution on Windows ARM64 and x64, including restricted and compliance-oriented workstations.

## Pilot installation journal

### 2026-08-13 — initial review

- The original review clone was on the shared `C:\Mac\Home\...` filesystem. It triggered Git safe-directory handling and will not be used for installation or runtime testing.
- Created a clean recursive clone at `C:\Users\leemoore\source\long-horizon-context` on native Windows storage.
- Confirmed host target: `win32-arm64`.
- Confirmed Claude Code is a native executable suitable for ConPTY: `C:\Users\leemoore\.local\bin\claude.exe`.
- Installed Claude Code version is `2.1.132`; retained cc-lhc certification is against `2.1.226`. Treat the pilot as compatibility testing unless Claude is updated.
- Existing Node is `24.15.0`, below the repository floor of `24.17.0`; use a user-scoped Node `24.18.x` runtime for the pilot.
- pnpm 11 is not currently installed.
- Python and Visual Studio Build Tools are not installed. They will not be added to this workstation solely for cc-lhc.
- GitHub Actions run `31596495930` at commit `b81828e2a9606f790651e136f0e56c5fb01107a1` completed successfully on all six targets, including jobs `win32-arm64` and `win32-x64`.
- That successful workflow staged native addons but uploaded zero artifacts. The compiled binaries are therefore not retrievable after the job.
- Updated Claude Code in place using `claude update`: `2.1.132` to `2.1.231`. The executable remains the native user-profile installation at `C:\Users\leemoore\.local\bin\claude.exe`.
- Installed checksum-verified Node `24.18.0` ARM64 under `C:\Users\leemoore\AppData\Local\Programs\node-v24.18.0-win-arm64` and placed it first in the persistent user PATH.
- Activated pnpm `11.8.0` through the portable runtime's Corepack installation.
- The complete prerequisite checker, including real non-persistent Claude authentication, passed.
- `pnpm install --frozen-lockfile` passed. It produced non-fatal Windows warnings while trying to create `pi`/`pi-ai` executable shims for unbuilt vendored PI packages; this is unnecessary noise in the cc-lhc-only install path.
- TypeScript builds for `lhc`, `cc-lhc-native`, and `cc-lhc` passed on the pilot workstation.
- Locally added an `actions/upload-artifact` step to retain every matrix job's staged native addon. A pushed workflow run is required before the workstation can fetch the no-compiler ARM64 binary.
- Updated the workflow-consistency contract to pin `actions/upload-artifact@v6`, require the exact per-target staged-addon path, and continue prohibiting release publication side effects.
- Toolchain-free test suites passed on native Windows ARM64: `cc-lhc-native` 136 passed / 11 skipped; `cc-lhc` 640 passed / 18 skipped (658 total).
- Installed the Windows launcher pair at `C:\Users\leemoore\.local\bin\cc-lhc.cmd` and `cc-lhc.launcher.js`.
- Launcher execution currently refuses with `addon_unavailable`, as designed. Notably, even `cc-lhc --version` loads the identity addon and exits 2 when it is absent; the setup guide currently presents `--version` as the first post-addon verification but there is no addon-independent launcher smoke surface.
- Added a dedicated Windows npm dogfood workflow. Windows x64 uses Liminal AI's `blacksmith-2vcpu-windows-2025`; Windows ARM64 uses GitHub's native `windows-11-arm` because Blacksmith currently offers Windows x64 only.
- Added a runtime-only npm package assembler. The dogfood tarball bundles `lhc`, `cc-lhc-native`, and both tested Windows prebuilds; it has no install script and resolves only public JavaScript dependencies from npm.
- The workflow installs the packed tarball globally with npm on clean x64 and ARM64 runners, then proves npm's launcher, native addon loading, and native PTY startup before exposing the tarball for workstation installation.

## Distribution worklist

### Required for a no-compiler source-checkout install

- [x] Add workflow logic to upload each matrix job's staged `prebuild-<platform>-<arch>` artifact (local change; publish/run pending).
- [ ] Add an aggregation job that downloads all target artifacts and runs `assemble-release-bundle.mjs`.
- [ ] Validate the complete release bundle with `check-release-bundle`.
- [ ] Publish flat native assets plus `SHA256SUMS` to a versioned release or approved internal artifact host.
- [ ] Set `.setup/prebuild-release.json` to the published release tag.
- [ ] Change standalone setup Step 4 from local `node-gyp` compilation to `.setup/scripts/fetch-prebuild.mjs`.
- [ ] Extend `check-prereqs.mjs` to distinguish release/prebuilt installs from source-native development builds.
- [ ] Correct README claims so the documented compiler requirement matches the actually published path.

### Maximal workstation usability

- [ ] Produce a portable Windows distribution under `%LOCALAPPDATA%\Programs\cc-lhc` that does not require Git, pnpm, TypeScript, or the PI submodule.
- [ ] Include the matching `@lydell/node-pty` and `cc-lhc-native` prebuilt binaries for x64 and ARM64.
- [ ] Provide PowerShell and `cmd.exe` install, update, repair, and uninstall entry points.
- [ ] Provide an addon-independent diagnostic/version command, or document that every launcher invocation requires the native addon.
- [ ] Avoid requiring administrator elevation; use per-user install and PATH locations by default.
- [ ] Support offline installation from a pre-validated bundle.
- [ ] Support an internal artifact base URL for workstations that cannot access GitHub Releases.
- [ ] Detect architecture, Node version, Claude executable shape, PATH readiness, and Claude authentication before mutation.
- [ ] Preserve and clearly report rollback behavior during updates, including Windows file-lock failures.
- [ ] Test paths containing spaces, parentheses, ampersands, percent signs, dollar signs, and non-ASCII characters.
- [ ] Test PowerShell, cmd, Windows Terminal, VS Code terminal, and Claude Code's Bash tool environment.

### Compliance-oriented distribution

- [ ] Generate SBOM and dependency/license inventory for each release.
- [ ] Pin every dependency and build from a reviewed lockfile.
- [ ] Attach build provenance and hashes to release artifacts.
- [ ] Authenticode-sign native binaries, launchers/installers, and final bundles where policy requires it.
- [ ] Document network endpoints used by install, Claude Code, and background inference.
- [ ] Provide checksum/signature verification that works offline.
- [ ] Document state locations, data retention, logs, SQLite contents, runtime descriptors, and uninstall/data-destruction behavior.
- [ ] Provide a mode that disables background inference and document its functional impact.
- [ ] Confirm operation under application allowlisting, endpoint protection, controlled-folder access, proxy/TLS inspection, and no-admin policies.
- [ ] Define supported Node and Claude Code version windows and produce explicit drift diagnostics.
- [ ] Add release acceptance on clean Windows x64 and ARM64 machines, not only CI runners.

## Test matrix for this pilot

- [x] Prerequisite and auth probe
- [x] Frozen dependency install
- [x] TypeScript builds (`lhc`, `cc-lhc-native`, `cc-lhc`)
- [ ] Verified native addon fetch and live subprocess probe
- [ ] Native addon mandatory test suite
- [x] Full cc-lhc deterministic suite (toolchain-free path; addon-mandatory rerun pending)
- [x] Launcher shim installed; execution path reaches the expected fail-closed missing-addon error
- [ ] Real ConPTY launch
- [ ] Fresh capture and SQLite state creation
- [ ] Ctrl-] panel (`status`, `stats`)
- [ ] Unpiped `get-turns` retrieval through Claude's Bash tool
- [ ] Clean exit and derivation drain
- [ ] Wrapper `--continue` with same LHC thread identity
- [ ] Rollout parser counters and capture-degradation checks
- [ ] Compact/prune and controlled handoff when enough test context exists

# cc-lhc npm candidate

This is the pre-publication packaging path for cc-lhc. It produces one global
package and one `cc-lhc` executable. The executable runs the interactive
wrapper by default and runs retrieval through `get-turns` and `get-messages`
subcommands.

The candidate is deliberately locked:

- package name: provisional `cc-lhc`;
- version: `0.0.0-dev.0`;
- `private: true`;
- license: `UNLICENSED`;
- no publish step or registry credentials.

Lee must approve the public name, npm scope, license, and first version before
those locks are removed.

## First-publication handoff

The local and CI candidates need no npm credentials. When the package is ready
for its first public release, Lee must supply only the registry decisions and
proof of presence:

1. Choose the final package name and whether it is unscoped or belongs to an
   npm user/organization scope. An organization scope must already exist and
   Lee's npm account must have publish access.
2. Choose the public license and first version.
3. Sign in with an npm account that has two-factor authentication enabled, and
   verify the active identity with `npm whoami`.
4. Inspect the exact all-target tarball and its `npm pack --dry-run --json`
   manifest before removing the candidate's `private` and `publishLocked`
   guards.
5. Prefer `npm stage publish` for the first release. Lee can inspect and
   approve the staged package with 2FA before it becomes public. A scoped
   public package also needs public access selected when it is published.

After the package exists, configure npm trusted publishing for a dedicated
GitHub Actions release workflow. Use a GitHub-hosted runner, OIDC
`id-token: write`, and stage-only permission so later builds still require
Lee's approval. Do not create or store a long-lived npm publish token.

References:

- https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
- https://docs.npmjs.com/trusted-publishers/

## Package shape

The tarball contains the cc-lhc JavaScript runtime plus two private bundled
runtimes: `lhc` and `cc-lhc-native`. It contains the Node-API identity addon for
all supported targets:

- Linux x64 and arm64;
- macOS x64 and arm64;
- Windows x64 and arm64.

`@lydell/node-pty` remains a normal npm dependency. That package already uses
target-specific optional packages for the same six targets. A supported client
therefore downloads prebuilt PTY and identity binaries. It does not run
`node-gyp` or require a C++ toolchain.

The package requires Node 24.3 or later. Claude Code remains an external host
prerequisite and is not bundled.

## Local current-platform candidate

Build the three runtimes, stage the local native prebuild, and then run:

```bash
node packages/cc-lhc/scripts/assemble-npm-package.mjs --targets current
node packages/cc-lhc/scripts/check-npm-package.mjs build/cc-lhc-npm
node packages/cc-lhc/scripts/smoke-npm-package.mjs build/cc-lhc-npm
```

The smoke test packs the candidate and installs it globally into disposable
prefixes. It tests both a normal install and an install with scripts disabled.
It then checks wrapper help, retrieval command discovery, and native process
identity loading.

## Six-platform CI candidate

`.github/workflows/native-platforms.yml` builds and tests each native target.
Each target also installs a current-target npm candidate without a compiler.
The aggregation job accepts artifacts only after all six jobs pass. It builds
one all-target tarball, repeats the install smoke, and stores the unpublished
tarball as the `cc-lhc-npm-candidate` workflow artifact.

The workflow can preserve build artifacts. It cannot publish, tag, create a
GitHub release, or write to npm.

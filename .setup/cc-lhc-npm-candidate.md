# cc-lhc npm package

This is the pre-publication packaging path for cc-lhc. It produces one global
package and one `cc-lhc` executable. The executable runs the interactive
wrapper by default and runs retrieval through `get-turns` and `get-messages`
subcommands.

The approved first release identity is:

- package name: `cc-lhc`;
- version: `0.1.0`;
- license: MIT, copyright 2026 Lee Moore;
- public access;
- no publish step or registry credentials in the build workflow.

Lee approved this identity on 2026-08-14.

## First-publication handoff

The local and CI candidates need no npm credentials. When the package is ready
for its first public release, Lee must supply only the registry decisions and
proof of presence:

1. Sign in with an npm account that has two-factor authentication enabled, and
   verify the active identity with `npm whoami`.
2. Inspect the exact all-target tarball and its `npm pack --dry-run --json`
   manifest.
3. Publish the exact inspected tarball with 2FA. npm staged publishing cannot
   create a package, so the first `cc-lhc` publication must be a normal publish.

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

## Local current-platform package

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

## Six-platform CI package

`.github/workflows/native-platforms.yml` builds and tests each native target.
Each target also installs a current-target npm package without a compiler.
The aggregation job accepts artifacts only after all six jobs pass. It builds
one all-target tarball, repeats the install smoke, and stores the tarball as
the `cc-lhc-npm-package` workflow artifact.

The workflow can preserve build artifacts. It cannot publish, tag, create a
GitHub release, or write to npm.

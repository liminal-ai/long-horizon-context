#!/usr/bin/env bash
# Link the t3code checkout's packages into node_modules so src/t3code/*.ts can
# import @t3tools/client-runtime, @t3tools/contracts and effect without a build.
# Node resolves symlinks to their real path, so imports inside those packages
# resolve against the checkout's own node_modules. Same trick as the smoke client.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T3="${T3CODE_INJECT_CHECKOUT:-/srv/work/t3code}"
mkdir -p "$HERE/node_modules/@t3tools"
ln -sfn "$T3/packages/client-runtime" "$HERE/node_modules/@t3tools/client-runtime"
ln -sfn "$T3/packages/contracts" "$HERE/node_modules/@t3tools/contracts"
ln -sfn "$T3/packages/shared" "$HERE/node_modules/@t3tools/shared"
ln -sfn "$(readlink -f "$T3/packages/client-runtime/node_modules/effect")" "$HERE/node_modules/effect"

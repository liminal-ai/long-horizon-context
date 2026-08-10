// Explicit no-op install script.
//
// Without this, npm/pnpm treat the presence of binding.gyp as an implicit
// `node-gyp rebuild` install step, which would make every install of this
// package demand a C toolchain. Released/prebuilt consumption must never
// compile; source builds happen only through the explicit `build:native`
// script.
process.exit(0);

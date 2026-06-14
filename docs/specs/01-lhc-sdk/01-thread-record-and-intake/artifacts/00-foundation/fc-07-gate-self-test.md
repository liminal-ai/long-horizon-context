# FC-0.7 Gate Self-Test — Recorded Proof

- **Recorded:** 2026-06-10T12:50:43.631Z
- **Story:** 00-foundation (Chunk 0)
- **Requirement:** FC-0.7 — a sacrificial failing test fails `verify`; an edited Red-phase test file fails `green-verify`.
- **Method:** real sacrificial test files run through the real package gate scripts; files removed and `red-manifest.json` restored afterward.
- **Verdict:** PASS — the gates fail correctly.

| Leg | Command | Expected | Exit | Result |
|-----|---------|----------|------|--------|
| Baseline: clean `pnpm run verify` | `pnpm run verify` | exit 0 | 0 | OK |
| Proof 1: sacrificial failing test fails `pnpm run verify` | `pnpm run verify  (with test/_fc07-failing.test.ts present)` | non-zero exit | 1 | OK |
| Proof 2a: unchanged Red file passes `pnpm run green-verify` | `pnpm run green-verify  (Red file matches manifest)` | exit 0 (gate is discriminating) | 0 | OK |
| Proof 2b: edited Red file fails `pnpm run green-verify` | `pnpm run green-verify  (Red file edited after manifest)` | non-zero exit at check-test-immutability | 1 | OK |
| End state: clean `pnpm run verify-all` | `pnpm run verify-all` | exit 0 | 0 | OK |

## Captured output (tails)

### Baseline: clean `pnpm run verify`

Exit code: `0` — expected: exit 0

```
> lhc@0.0.0 red-verify /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run boundaries


> lhc@0.0.0 build /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json


> lhc@0.0.0 typecheck /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json


> lhc@0.0.0 lint /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/lint.mjs

lint: OK (19 files)

> lhc@0.0.0 boundaries /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/check-boundaries.mjs

boundaries: OK (17 files checked, fixtures exempt)
SKIP: cli-process suite — run verify-all

 RUN  v4.1.8 /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc


 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  08:50:27
   Duration  464ms (transform 60ms, setup 0ms, import 89ms, tests 282ms, environment 0ms)
```

### Proof 1: sacrificial failing test fails `pnpm run verify`

Exit code: `1` — expected: non-zero exit

```

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 14 passed (15)
   Start at  08:50:31
   Duration  490ms (transform 77ms, setup 0ms, import 114ms, tests 307ms, environment 0ms)

 ELIFECYCLE  Command failed with exit code 1.
(node:7938) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/_fc07-failing.test.ts > FC-0.7 sacrificial failing test > fails on purpose so verify must go red
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1

 ❯ test/_fc07-failing.test.ts:7:15
      5| describe("FC-0.7 sacrificial failing test", () => {
      6|   it("fails on purpose so verify must go red", () => {
      7|     expect(1).toBe(2);
       |               ^
      8|   });
      9| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

### Proof 2a: unchanged Red file passes `pnpm run green-verify`

Exit code: `0` — expected: exit 0 (gate is discriminating)

```


> lhc@0.0.0 build /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json


> lhc@0.0.0 typecheck /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json


> lhc@0.0.0 lint /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/lint.mjs

lint: OK (20 files)

> lhc@0.0.0 boundaries /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/check-boundaries.mjs

boundaries: OK (18 files checked, fixtures exempt)
SKIP: cli-process suite — run verify-all

 RUN  v4.1.8 /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc


 Test Files  3 passed (3)
      Tests  15 passed (15)
   Start at  08:50:35
   Duration  494ms (transform 76ms, setup 0ms, import 113ms, tests 309ms, environment 0ms)

test-immutability: OK (1 Red-phase files unchanged)
```

### Proof 2b: edited Red file fails `pnpm run green-verify`

Exit code: `1` — expected: non-zero exit at check-test-immutability

verify passed; failure isolated to the immutability gate

```


> lhc@0.0.0 typecheck /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json


> lhc@0.0.0 lint /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/lint.mjs

lint: OK (20 files)

> lhc@0.0.0 boundaries /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/check-boundaries.mjs

boundaries: OK (18 files checked, fixtures exempt)
SKIP: cli-process suite — run verify-all

 RUN  v4.1.8 /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc


 Test Files  3 passed (3)
      Tests  15 passed (15)
   Start at  08:50:39
   Duration  499ms (transform 80ms, setup 0ms, import 116ms, tests 314ms, environment 0ms)

 ELIFECYCLE  Command failed with exit code 1.
(node:8448) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
test-immutability FAILED:
  - test/_fc07-red.test.ts: modified since Red phase (hash mismatch)
```

### End state: clean `pnpm run verify-all`

Exit code: `0` — expected: exit 0

```

> lhc@0.0.0 red-verify /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run boundaries


> lhc@0.0.0 build /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json


> lhc@0.0.0 typecheck /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json


> lhc@0.0.0 lint /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/lint.mjs

lint: OK (19 files)

> lhc@0.0.0 boundaries /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc
> node scripts/check-boundaries.mjs

boundaries: OK (17 files checked, fixtures exempt)

 RUN  v4.1.8 /Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc


 Test Files  3 passed (3)
      Tests  18 passed (18)
   Start at  08:50:43
   Duration  540ms (transform 114ms, setup 0ms, import 163ms, tests 533ms, environment 0ms)
```


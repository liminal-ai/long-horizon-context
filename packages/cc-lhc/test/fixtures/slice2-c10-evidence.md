# Slice 2 correction 10 — acceptance evidence

Date: 2026-08-09 · Claude `2.1.226` · **No commit**

## Coherent acceptance artifact

**`/tmp/cc-lhc-slice2-c10-1786318444/c10-final-acceptance-audit.json`** · **status=`SUCCESS`** · **success=`true`**

C9 at `/tmp/cc-lhc-slice2-c9-1786316746` is **external historical evidence only** (invalidated by C10: sync-safe `writeAll`, complete frozen module graph, lockfile restore).

## Frozen executable (complete graph)

Root: `/tmp/cc-lhc-slice2-c10-1786318444`
`BASH_MAX_OUTPUT_LENGTH=22412` for primary chain.
Manifest after exhibits: **OK** (never rebuilt/mutated packages after final manifest).
Launcher: self-contained `bin/cc-lhc` → `$ROOT/packages/cc-lhc/dist/bin.js`; **in manifest**.
Escape scan: **ok=true** · worktreeHits=0 · symlinkCount=1 (only relative `lhc` → `../../lhc`).
Native node-pty from frozen copy: **ok=true**.

| File | sha256 |
|------|--------|
| bin/cc-lhc | `6996a2805ed93d60512f87fb40174a9db39f6e2d76139f67b81abb1cd5efd54b` |
| bin.js | `cee4bde69d920b72a8f7b3521b2e3a9b34de6ebcbbeda72314fb4deccafe4d93` |
| intake/map.js | `cb517eef1ef78678f519d3930d95d07f4996eb26608abb921fc9a8b94e7abebd` |
| retrieval/service.js | `ec16f40b828c2cda90ee93402d516c3d87bd09e50a3cd765955d8f38d804325c` |
| retrieval/budget.js | `7bd3a45e49c824c83b1c659d4158b2ceff87bf4256b29e3749e7550f1cb13fe8` |
| @lydell/node-pty/index.js | `4d9d98052d80c995aff7e064fe2c54ca88b3c1911abca89ba159a60b087fcedb` |
| node-pty-linux-x64 pty.node | `ab01eb7d31a5b6202e2a51339ad2cbe3f2a73e3a679e88195011e28f3160d5a7` |

Clean homes: `home10/`, `work10/`, `claude-home10b/`
Thread: `th_3922a3d56c2ceacf`
DB: `/tmp/cc-lhc-slice2-c10-1786318444/home10/threads/4661798d-5dd3-4565-837f-b9886d414e1e.sqlite`

## C10 code gates

| Gate | Result |
|------|--------|
| `writeAll` pre-register listeners; sync error×false no leak; 12× zero listeners | unit green |
| All four sync combinations + drain-first/late-error + near-ceiling flush | green |
| Multiproc READY/go + unique keys + exact 147 events / 48 imps | green |
| Fail-closed fallback healthy vs drift | green |
| `pnpm-lock.yaml` restored to HEAD (no openai 6.40 drift) | green |
| Complete frozen graph (no worktree-escaping deps) | green |
| LHC typecheck · cc-lhc typecheck | green |
| LHC 63/539/31skip · cc-lhc 53/476 · focused 92 · sqlite 9 · doctrine×3 · diff-check | green |

## Production truth fields

| Field | Value |
|-------|-------|
| manifestOk | true |
| launcherSelfContained | true |
| escapeOk | true |
| nativePtyOk | true |
| labelsOk | true |
| naturalOk | true |
| controlledOk | true |
| impressionShapeOk | true |
| toolCountsOk | true |
| agingOk | true |
| rebuiltLabelsOk | true |
| liveAck | true |
| reconstructedReingestionOk | true |
| flushOk | true |
| fallbackOk | true |
| dualOk | true |
| success | true |

## Impressions (product only)

Total **36** · surface `cc-lhc:get-turns` only · tool_call=5 tool_result=5

| call_id | n | served |
|---------|---|--------|
| `cd980343-e14b-4ae2-add6-28d7e2397071` | 1 | 1 |
| `fd220929-2692-405f-87e3-139e1b20add4` | 1 | 1 |
| `dca129e0-d126-486e-9bc3-418dcd72aa5e` | 32 | 2 |
| `1535ce17-081a-408a-977c-976839c49291` | 1 | 1 |
| `631c2507-422f-4446-860a-77ff336b21b4` | 1 | 1 |

## Aging

| turn_id | band label |
|---------|------------|
| **t16** | brief: `<turns>t13 t14 t15 t16</turns>` |
| **t17** | detailed: `<turns>t17 t18 t19 t20 t21 t22 t23 t24 t25 t26 t27 t28 t29 t30 t31 t32 t33 t34 t35 t36 t37 t38 t39 t40 t41</turns>` |

## Exhibits

- Natural unpiped + exact tail: `c10-natural-gate.json`
- Controlled 32+1+1: `c10-controlled32-gate.json`
- Age2 labels: `c10-final-audit2.json`
- Fallback: `c10-fallback-exhibit.json`
- Flush + drain-first LATE_EPIPE: `c10-flush-exhibit.json` (bytes=22327)
- Dual isolation: `dual-ret/dual-audit.json`
- Escape scan: `escape-scan.json`

## Incomplete

None — all truth fields true.

## Notes

- Production PATH used frozen `bin` first; worktree absent from package resolution for evidence scripts.
- Runtime deps copied into frozen root: @lydell/node-pty + linux-x64 native, effect (+@standard-schema/spec, fast-check, pure-rand), js-tiktoken (+base64-js).
- Do not commit.

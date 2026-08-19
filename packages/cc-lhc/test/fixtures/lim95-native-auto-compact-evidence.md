# Native auto-compact mechanism evidence — LIM-95 (R8 addendum, R12)

Date: 2026-08-19.
Host: linux (workstation).
Probe: static inspection of installed Claude Code artifacts plus `claude --help`.
No provider call was made and no production session, settings file, or rollout
was modified to produce this record.

## Installed artifacts inspected

`/home/leemoore/.local/share/claude/versions/<version>`

| Version | SHA-256 |
|---|---|
| 2.1.232 | `61d23f8749136907d586d5b11831ea8a5234d4c1dea40a5e55c33b52e204c6d1` |
| 2.1.233 | `55d281096f57d411ebbdd94dbf5e9ff3accb7c05713e37348c2c11d4b83bf9d9` |
| 2.1.234 | `3473601ea695d5bf769c5b202844d4cb4fbf723ae995450fcb6973204775c84a` |
| 2.1.235 | `bfcf0ae2dbf94b2b6a106074aabf3938b9a10889c3b678e4cb5a00c03274d5d5` |

`claude --version` reported **2.1.235** at the end of the probe
(`~/.local/bin/claude` is a symlink into the versions directory and rolled
2.1.234 → 2.1.235 mid-session; both were inspected).

## The gate

The auto-compact enablement predicate reads the environment before the
`autoCompactEnabled` setting, so the environment variable overrides the
setting. Extracted verbatim:

2.1.232 (identical shape in 2.1.233 and 2.1.234, minifier names differ):

```js
function dI(){if(Y.DISABLE_COMPACT)return!1;if(Y.DISABLE_AUTO_COMPACT)return!1;return Bd("autoCompactEnabled",!0).value}
```

2.1.235 (refactored into a shared predicate; same semantics):

```js
function PBp(){return Boolean(K.DISABLE_COMPACT||K.DISABLE_AUTO_COMPACT)}
function CR(){if(PBp())return!1;return Vd("autoCompactEnabled",!0).value}
```

Truthiness of `"1"` is covered by the shared env parser in 2.1.232–2.1.234:

```js
function $n(e){if(!e)return!1;if(typeof e==="boolean")return e;let t=String(e).toLowerCase().trim();return["1","true","yes","on"].includes(t)}
```

and by `Boolean(...)` on the raw value in 2.1.235. `"1"` is truthy in both.

## Why `DISABLE_COMPACT` is never used

The binaries carry a self-describing worker field that states the split
directly:

```text
Whether auto-compact is enabled on the worker (autoCompactEnabled setting +
DISABLE_AUTO_COMPACT / DISABLE_COMPACT env; DISABLE_COMPACT also disables
manual /compact).
```

R8 requires manual `/compact` to remain possible, so cc-lhc injects only
`DISABLE_AUTO_COMPACT=1` and never `DISABLE_COMPACT`.

## Why an explicit `--autocompact` omits the disable (R12)

`claude --help` on the installed binary:

```text
  --autocompact <auto|tokens>           Auto-compact window size (auto, or ...
```

The flag sets the auto-compact **window**, not enablement. With
`DISABLE_AUTO_COMPACT=1` also injected the user's flag would be inert, so
cc-lhc omits the variable for that launch and records an anomaly notice
instead of rejecting, stripping, or overriding the flag.

## Not covered here

No live behavioral probe of a running managed session was performed: doing so
would require a provider call, which LIM-95 forbids for evidence manufacture.
Live confirmation belongs to S7 certification canaries.

# Capture gaps — pi-lhc

Known structural gaps where host-observed facts are present on PI's wire but
are not recorded into LHC. These are deliberate acceptance points for a slice,
not silent bugs: each names the eventual schema or vehicle change that closes
it.

## R1 — Provider usage dropped on non-text assistant messages (schema v5)

**What is missing.** Per model call, PI's `AssistantMessage.usage` is attached
verbatim as `assistant_text.payload.providerUsage` (schema v5 D1 / D3). That
vehicle only exists when the assistant message has a **text** content part.

**When it fails.** An assistant message that is pure tool calls (extremely
common mid-loop) or thinking-only emits `tool_call` / `assistant_thinking`
events and **no** `assistant_text`. Its `usage` is not captured anywhere —
there is no alternate vehicle and this package does not invent empty-text
events.

**Evidence.** `src/capture/map-message.ts` (`mapAssistant`): `providerUsage` is
set only inside the text-part arm. Pinned by a unit test that maps a pure
tool-call assistant message and asserts tool_call events only, with no usage
on any payload.

**Schema-v6 candidate.** Widen the vehicle set so one model call's usage can
ride an event that always exists for that call — for example, attach usage to
the first event of the message fan-out, or introduce a dedicated per-call
carrier. Do **not** paper over this in pi-lhc by emitting synthetic
`assistant_text` with empty text.

**Related.** Module doc on `src/capture/map-message.ts`.

import { describe, expectTypeOf, it } from "vitest";
import type {
  CompactionResult,
  PiHookHandler,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "../../src/pi/types.js";

describe("session_before_compact hook types", () => {
  it("SessionBeforeCompactEvent carries reason and willRetry", () => {
    expectTypeOf<SessionBeforeCompactEvent["reason"]>().toEqualTypeOf<"manual" | "threshold" | "overflow">();
    expectTypeOf<SessionBeforeCompactEvent["willRetry"]>().toEqualTypeOf<boolean>();
  });

  it("PiHookHandler for session_before_compact may return cancel or compaction", () => {
    const cancelHandler: PiHookHandler<"session_before_compact"> = async () => ({ cancel: true });
    const compactHandler: PiHookHandler<"session_before_compact"> = async () => ({
      compaction: {
        summary: "bands",
        firstKeptEntryId: "entry-1",
        tokensBefore: 42,
        details: {} as CompactionResult["details"],
      },
    });
    const voidHandler: PiHookHandler<"session_before_compact"> = async () => undefined;

    expectTypeOf(cancelHandler).returns.toEqualTypeOf<
      SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>
    >();
    expectTypeOf(compactHandler).returns.toEqualTypeOf<
      SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>
    >();
    expectTypeOf(voidHandler).returns.toEqualTypeOf<
      SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>
    >();
  });

  it("ordinary hooks still return void", () => {
    const handler: PiHookHandler<"message_end"> = async () => {};
    expectTypeOf(handler).returns.toEqualTypeOf<void | Promise<void>>();
  });
});

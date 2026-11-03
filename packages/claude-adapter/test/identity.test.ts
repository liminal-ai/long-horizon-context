import { expect, test } from "vitest";
import { idempotencyKey, messageKeyPrefix } from "../src/index.js";

test("keys are content-stable and namespaced by the caller's harness", () => {
  expect(messageKeyPrefix("claude-lhc", "u1")).toBe("claude-lhc:u1:");
  expect(idempotencyKey("claude-lhc", "u1", 0, "user_prompt")).toBe("claude-lhc:u1:0:user_prompt");
  expect(idempotencyKey("claude-code", "a1", 2, "tool_call")).toBe("claude-code:a1:2:tool_call");
  expect(idempotencyKey("claude-code", "a1", 2, "tool_call").startsWith(messageKeyPrefix("claude-code", "a1"))).toBe(
    true,
  );
});

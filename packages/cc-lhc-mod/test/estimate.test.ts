import { expect, it } from "vitest";
import { estimateContent } from "../src/estimate.ts";

it("counts text at a quarter token per character, rounded per block", () => {
  expect(estimateContent("abcdefgh")).toBe(2);
  expect(estimateContent([{ type: "text", text: "abcdef" }])).toBe(2);
  expect(
    estimateContent([
      { type: "text", text: "ab" },
      { type: "text", text: "ab" },
    ]),
  ).toBe(2);
});

it("counts an image or a non-text document as 2000 tokens, inside a tool result too", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(40_000) } };
  expect(estimateContent([image])).toBe(2000);
  expect(estimateContent([{ type: "tool_result", tool_use_id: "toolu_a", content: [image] }])).toBe(2000);
  expect(estimateContent([{ type: "document", source: { type: "base64", data: "x" } }])).toBe(2000);
});

it("counts a tool call's name with its input, and a JSON document at half a token per character", () => {
  expect(estimateContent([{ type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.ts" } }])).toBe(
    Math.round(`Read${JSON.stringify({ file_path: "a.ts" })}`.length / 4),
  );
  expect(estimateContent([{ type: "document", title: "data.json", source: { type: "text", data: "abcdefgh" } }])).toBe(
    4,
  );
});

import { describe, expect, test } from "bun:test";
import { ToolBatch } from "../src/capture/batch.ts";

const streamEvent = (event: Record<string, unknown>, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: "s" }) as never;
const assistant = (id: string, content: Record<string, unknown>[], parent: string | null = null) => ({ type: "assistant", message: { id, role: "assistant", content }, parent_tool_use_id: parent, uuid: "u", session_id: "s" }) as never;
const results = (...ids: string[]) => ({ type: "user", message: { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) }, parent_tool_use_id: null, uuid: "u", session_id: "s" }) as never;
const use = (id: string, name = "Read") => ({ type: "tool_use", id, name, input: {} });

describe("ToolBatch", () => {
  test("stream events announce the whole batch before any tool runs; the stop waits for the last", () => {
    const batch = new ToolBatch();
    batch.observe(streamEvent({ type: "message_start", message: { id: "msg_1" } }));
    expect(batch.observe(streamEvent({ type: "content_block_start", index: 0, content_block: use("a") }))).toEqual(["Read"]);
    batch.observe(streamEvent({ type: "content_block_start", index: 1, content_block: use("b", "Bash") }));
    batch.observe(streamEvent({ type: "content_block_start", index: 2, content_block: use("c") }));
    expect(batch.size).toBe(3);
    batch.settle("a");
    expect(batch.unsettled()).toEqual(["b", "c"]);
    batch.settle("c");
    expect(batch.unsettled()).toEqual(["b"]);
    batch.settle("b");
    expect(batch.unsettled()).toEqual([]);
  });

  test("one assistant wire message per block of the same API message joins one batch", () => {
    const batch = new ToolBatch();
    expect(batch.observe(assistant("msg_1", [use("a")]))).toEqual(["Read"]);
    batch.settle("a");
    expect(batch.observe(assistant("msg_1", [use("b")]))).toEqual(["Read"]);
    expect(batch.size).toBe(2);
    expect(batch.unsettled()).toEqual(["b"]);
  });

  test("a new API message starts a new batch: settled calls of the last one leave, unsettled ones stay", () => {
    const batch = new ToolBatch();
    batch.observe(assistant("msg_1", [use("a"), use("b")]));
    batch.settle("a");
    batch.observe(assistant("msg_2", [use("c")]));
    expect(batch.has("a")).toBe(false);
    expect(batch.unsettled()).toEqual(["b", "c"]);
  });

  test("a tool_result on the wire settles its call; the stream and the assistant message do not double count", () => {
    const batch = new ToolBatch();
    batch.observe(streamEvent({ type: "message_start", message: { id: "msg_1" } }));
    batch.observe(streamEvent({ type: "content_block_start", index: 0, content_block: use("a") }));
    expect(batch.observe(assistant("msg_1", [use("a")]))).toEqual([]);
    expect(batch.size).toBe(1);
    batch.observe(results("a"));
    expect(batch.unsettled()).toEqual([]);
  });

  test("subagent traffic is ignored; clear forgets everything", () => {
    const batch = new ToolBatch();
    expect(batch.observe(assistant("msg_x", [use("sub")], "toolu_parent"))).toEqual([]);
    expect(batch.observe(streamEvent({ type: "content_block_start", index: 0, content_block: use("sub2") }, "toolu_parent"))).toEqual([]);
    expect(batch.size).toBe(0);
    batch.observe(assistant("msg_1", [use("a")]));
    batch.clear();
    expect(batch.size).toBe(0);
    expect(batch.has("a")).toBe(false);
  });
});

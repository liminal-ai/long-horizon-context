import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIncoming, renderTurn, resolvePriority } from "../src/envelope.ts";

describe("parseIncoming", () => {
  it("passes the relay's from line through and strips it from the body", () => {
    assert.deepEqual(parseIncoming("[from: heron]\nhello\nthere"), { sender: "heron", body: "hello\nthere" });
  });
  it("falls back to --from, then the relay sender env, then lee", () => {
    assert.equal(parseIncoming("hi", { fromFlag: "a", envSender: "b" }).sender, "a");
    assert.equal(parseIncoming("hi", { envSender: "b" }).sender, "b");
    assert.equal(parseIncoming("hi").sender, "lee");
    assert.equal(parseIncoming("hi", { fromFlag: " ", envSender: "" }).sender, "lee");
  });
  it("does not treat a from line that is not first as attribution", () => {
    assert.equal(parseIncoming("x\n[from: heron]\ny").sender, "lee");
  });
});

describe("resolvePriority", () => {
  it("is the flag or the relay's prioritized job class", () => {
    assert.equal(resolvePriority(false, undefined), false);
    assert.equal(resolvePriority(false, "deprioritized"), false);
    assert.equal(resolvePriority(false, "prioritized"), true);
    assert.equal(resolvePriority(true, "deprioritized"), true);
  });
});

describe("renderTurn", () => {
  const t0 = "2026-09-04T12:00:00.000Z";
  it("sends a fresh single message with just the from line", () => {
    assert.equal(renderTurn("heron", [{ body: "hello", arrivedAt: t0 }], { now: "2026-09-04T12:00:01.000Z" }), "[from: heron]\nhello");
  });
  it("adds the mid-turn marker for a high-priority steer and nothing else", () => {
    assert.equal(
      renderTurn("lee", [{ body: "also X", arrivedAt: t0 }], { now: t0, midTurn: true }),
      `[from: lee]\n[arrived mid-turn at ${t0}]\nalso X`,
    );
  });
  it("demarcates each queued prompt with its arrival time", () => {
    const text = renderTurn(
      "heron",
      [
        { body: "first", arrivedAt: t0 },
        { body: "second\nline", arrivedAt: "2026-09-04T12:00:30.000Z" },
      ],
      { now: "2026-09-04T12:05:00.000Z" },
    );
    assert.equal(text, `[from: heron]\n[arrived ${t0}]\nfirst\n\n[arrived 2026-09-04T12:00:30.000Z]\nsecond\nline`);
  });
  it("marks a single message that waited behind other turns", () => {
    assert.equal(
      renderTurn("heron", [{ body: "late", arrivedAt: t0 }], { now: "2026-09-04T12:03:00.000Z" }),
      `[from: heron]\n[arrived ${t0}]\nlate`,
    );
  });
  it("rejects an empty bundle", () => {
    assert.throws(() => renderTurn("x", [], { now: t0 }));
  });
});

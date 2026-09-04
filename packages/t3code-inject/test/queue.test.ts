import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { InjectQueue } from "../src/queue.ts";

const dirs: string[] = [];
const key = { server: "http://127.0.0.1:3773", threadId: "thread-1" };
const alive = new Set<number>([1, 2, 3]);
function open(): InjectQueue {
  const dir = mkdtempSync(join(tmpdir(), "t3code-inject-"));
  dirs.push(dir);
  return new InjectQueue(join(dir, "queue.sqlite"), (pid) => alive.has(pid));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = (s: number) => new Date(Date.UTC(2026, 8, 4, 12, 0, s)).toISOString();

describe("InjectQueue", () => {
  it("bundles all of the earliest sender's queued rows, in arrival order, never across senders", () => {
    const q = open();
    const a1 = q.enqueue({ ...key, sender: "A", body: "a1", arrivedAt: at(1), pid: 1 });
    const b1 = q.enqueue({ ...key, sender: "B", body: "b1", arrivedAt: at(2), pid: 2 });
    const c1 = q.enqueue({ ...key, sender: "C", body: "c1", arrivedAt: at(3), pid: 3 });
    const a2 = q.enqueue({ ...key, sender: "A", body: "a2", arrivedAt: at(4), pid: 1 });
    const b2 = q.enqueue({ ...key, sender: "B", body: "b2", arrivedAt: at(5), pid: 2 });

    const first = q.takeBundle(key, 1, at(10));
    assert.deepEqual(first.map((r) => r.id), [a1, a2]);
    assert.ok(first.every((r) => r.state === "queued"), "rows are returned as read before marking");
    assert.equal(q.get(a1)!.state, "sending");
    assert.equal(q.get(a2)!.pid, 1);
    assert.equal(q.get(b1)!.state, "queued");

    q.settle([a1, a2], { reply: "4 and Paris", turnId: "turn-A" }, at(20));
    assert.equal(q.get(a1)!.reply, "4 and Paris");
    assert.equal(q.get(a2)!.reply, "4 and Paris");
    assert.equal(q.get(a2)!.turn_id, "turn-A");

    assert.deepEqual(q.takeBundle(key, 2, at(21)).map((r) => r.id), [b1, b2]);
    q.settle([b1, b2], { error: "boom" }, at(30));
    assert.equal(q.get(b2)!.state, "failed");
    assert.equal(q.get(b2)!.error, "boom");
    assert.deepEqual(q.takeBundle(key, 3, at(31)).map((r) => r.id), [c1]);
    assert.deepEqual(q.takeBundle(key, 3, at(32)), []);
    assert.equal(q.hasQueued(key), false);
    q.close();
  });

  it("keeps threads and servers apart", () => {
    const q = open();
    const other = q.enqueue({ ...key, threadId: "thread-2", sender: "A", body: "x", arrivedAt: at(1), pid: 1 });
    q.enqueue({ ...key, sender: "A", body: "y", arrivedAt: at(2), pid: 1 });
    assert.equal(q.takeBundle(key, 1, at(3)).length, 1);
    assert.equal(q.get(other)!.state, "queued");
    q.close();
  });

  it("elects one dispatcher per thread and lets a live holder keep it", () => {
    const q = open();
    assert.equal(q.claimDispatcher(key, 1, at(0)), true);
    assert.equal(q.claimDispatcher(key, 2, at(1)), false);
    assert.equal(q.claimDispatcher(key, 1, at(2)), true, "re-claim by the holder is fine");
    assert.equal(q.claimDispatcher({ ...key, threadId: "thread-2" }, 2, at(3)), true);
    q.releaseDispatcher(key, 2);
    assert.equal(q.claimDispatcher(key, 2, at(4)), false, "release by a non-holder is a no-op");
    q.releaseDispatcher(key, 1);
    assert.equal(q.claimDispatcher(key, 2, at(5)), true);
    q.close();
  });

  it("takes over from a dead dispatcher and fails its in-flight rows instead of resending", () => {
    const q = open();
    assert.equal(q.claimDispatcher(key, 3, at(0)), true);
    const sent = q.enqueue({ ...key, sender: "A", body: "a", arrivedAt: at(1), pid: 1 });
    const later = q.enqueue({ ...key, sender: "B", body: "b", arrivedAt: at(2), pid: 2 });
    q.takeBundle(key, 3, at(3));
    alive.delete(3);
    assert.equal(q.claimDispatcher(key, 2, at(4)), true);
    assert.deepEqual(q.failOrphans(key, at(5)), [sent]);
    assert.match(q.get(sent)!.error ?? "", /dispatcher died/);
    assert.equal(q.get(later)!.state, "queued");
    alive.add(3);
    q.close();
  });

  it("settle only touches rows that are still sending", () => {
    const q = open();
    const id = q.enqueue({ ...key, sender: "A", body: "a", arrivedAt: at(1), pid: 1 });
    q.settle([id], { reply: "ignored", turnId: null }, at(2));
    assert.equal(q.get(id)!.state, "queued");
    q.close();
  });
});

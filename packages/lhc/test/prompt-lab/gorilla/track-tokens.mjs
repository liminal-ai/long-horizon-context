// Token tracker: opens the most recent thread for this cwd and prints size numbers.
import { initLhc } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/index.js";

const stub = async () => { throw new Error("no inference in tracker"); };
const sdk = initLhc({
  mode: "manual",
  inferenceCallbacks: {
    smoothPrompt: stub,
    summarizeToolResult: stub,
    compressDetailedTurn: stub,
    summarizeChunkBrief: stub,
  },
});

const cwd = "/Users/leemoore/code/pi-long-horizon/liminal-context";
const list = await sdk.threads.listThreads({ cwd });
if (!list.ok) { console.error("listThreads failed:", list.error); process.exit(1); }
const threads = list.value.threads ?? list.value;
if (!threads.length) { console.log("no threads for cwd"); process.exit(0); }
const newest = threads[threads.length - 1];
const threadId = newest.threadId ?? newest.id;

const overview = await sdk.inspect.overview({ threadId });
if (!overview.ok) { console.error("overview failed:", overview.error); process.exit(1); }
const o = overview.value;
console.log(JSON.stringify({
  threadId,
  title: newest.title ?? null,
  counts: { events: o.eventCount ?? o.counts?.events, messages: o.messageCount ?? o.counts?.messages, turns: o.turnCount ?? o.counts?.turns, chunks: o.chunkCount ?? o.counts?.chunks },
  tokens: o.tokens ?? o.tokenTotals ?? o,
}, null, 2));

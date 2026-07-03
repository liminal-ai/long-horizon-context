import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { initLhc, estimateTokens } from "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/dist/index.js";
const stub = async () => { throw new Error("stub"); };
const sdk = initLhc({ mode: "manual", inferenceCallbacks: { smoothPrompt: stub, summarizeToolResult: stub, compressDetailedTurn: stub, summarizeChunkBrief: stub } });
const ref = { threadId: "th_223371e0d9ed95bf" };
const params = { lowerBound: 120_000, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } };
const preview = await sdk.threadView.previewCompact(ref, { params });
console.log("preview:", JSON.stringify(preview.ok ? preview.value : preview.error).slice(0, 400));
const compact = await sdk.threadView.compact(ref, { params });
console.log("compact:", compact.ok ? "OK" : JSON.stringify(compact.error).slice(0, 400));
if (compact.ok) {
  const r = compact.value;
  console.log("receipt: compactPoint=" + (r.compactPoint ?? r.receipt?.compactPoint) + " gaps=" + JSON.stringify(r.gaps ?? []).slice(0, 200) + " warnings=" + JSON.stringify(r.warnings ?? []).slice(0, 300));
}
const ctx = await sdk.threadView.getLlmRequestContext(ref);
if (ctx.ok) {
  const msgs = ctx.value.messages;
  const renderContent = (c) => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : (b.text ?? JSON.stringify(b)))).join("\n");
    return JSON.stringify(c, null, 1);
  };
  const text = msgs.map((m) => `[${m.role}]\n${renderContent(m.content)}`).join("\n\n");
  writeFileSync("/Users/leemoore/code/pi-long-horizon/liminal-context/gorilla-view-dump.txt", text);
  console.log("dump written: gorilla-view-dump.txt, messages=" + msgs.length + " tokens=" + estimateTokens(text));
}

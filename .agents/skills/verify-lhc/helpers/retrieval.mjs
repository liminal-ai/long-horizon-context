#!/usr/bin/env node
import { fail, makeSdk, seedThread, tempHome, unwrap } from "./lib.mjs";

const store = tempHome();
try {
  const sdk = await makeSdk();
  const { filePath } = await seedThread(sdk, store);

  const turns = unwrap(await sdk.retrieval.getTurns({ filePath }, ["t1", "t2"]), "getTurns");
  if (turns.served.length !== 2) fail(`getTurns served ${turns.served.length}, expected 2: ${JSON.stringify(turns.unserved)}`);
  if (!turns.served.some((t) => t.text.includes("investigate area 1"))) fail("getTurns t1 missing seeded prompt");
  console.log(`getTurns served: ${turns.served.map((t) => t.turnId).join(",")}`);

  const messages = unwrap(await sdk.retrieval.getMessages({ filePath }, ["m1", "m2"]), "getMessages");
  if (messages.served.length !== 2) fail(`getMessages served ${messages.served.length}, expected 2`);
  if (messages.served[0].text !== "turn 1: investigate area 1 please") fail(`getMessages m1 verbatim mismatch: ${messages.served[0].text}`);
  console.log(`getMessages served: ${messages.served.map((m) => m.messageId).join(",")}`);

  const missing = unwrap(await sdk.retrieval.getTurns({ filePath }, ["t999"]), "getTurns missing");
  if (missing.unserved.length !== 1) fail("getTurns t999 should be unserved, not served or silent");
  console.log(`getTurns t999 unserved reason: ${missing.unserved[0].reason ?? JSON.stringify(missing.unserved[0])}`);

  console.log("verify-lhc retrieval: PASS");
} finally {
  store.cleanup();
}

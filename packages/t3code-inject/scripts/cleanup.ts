// List (and with --delete, remove) the throwaway "inject ..." projects the
// proof scripts create on the target server. Reads the shell snapshot stream.
//   node --no-warnings scripts/cleanup.ts [--delete] [--prefix "inject "]
import { parseArgs } from "node:util";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ORCHESTRATION_WS_METHODS, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import { connect, deleteProject } from "./lib.ts";

const { values: a } = parseArgs({ options: { delete: { type: "boolean", default: false }, prefix: { type: "string", default: "inject " } } });
const { rpc } = await connect();
const stream = (rpc.client[ORCHESTRATION_WS_METHODS.subscribeShell] as unknown as (input: object) => Stream.Stream<{ kind: string; snapshot?: OrchestrationShellSnapshot }>)({});
const first = await Effect.runPromise(Stream.runHead(Stream.filter(stream, (item) => item.kind === "snapshot")));
const snapshot = first._tag === "Some" ? first.value.snapshot : undefined;
if (!snapshot) throw new Error("no shell snapshot");
const mine = snapshot.projects.filter((p) => p.title.startsWith(a.prefix!));
console.log(`${snapshot.projects.length} projects on the server; ${mine.length} titled "${a.prefix}…"`);
for (const p of mine) {
  const threads = snapshot.threads.filter((t) => t.projectId === p.id).length;
  console.log(`  ${p.id}  ${p.title}  threads=${threads}`);
  if (a.delete) { await deleteProject(rpc, p.id); console.log("    deleted"); }
}
await rpc.close();

// Create (once) the durable seat thread for a relay seat: a project + Claude
// LHC thread on the target server. Prints the ids as JSON.
//   node --no-warnings scripts/seat.ts --label t3code-wren [--provider claude-lhc] [--workspace DIR]
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, createThread, pickModel } from "./lib.ts";
const { values: a } = parseArgs({ options: { label: { type: "string" }, provider: { type: "string", default: "claude-lhc" }, model: { type: "string" }, workspace: { type: "string" } } });
if (!a.label) throw new Error("--label required");
const { rpc } = await connect();
const modelSelection = await pickModel(rpc, a.provider!, a.model);
const workspaceRoot = a.workspace ?? join(homedir(), ".t3code-inject", "seats", a.label);
const ids = await createThread({ rpc, label: `seat ${a.label}`, workspaceRoot, modelSelection, files: { "README.md": `# ${a.label}\n\nWorkspace of the relay seat ${a.label} (t3code-inject).\n` } });
console.log(JSON.stringify({ ...ids, modelSelection, workspaceRoot }));
await rpc.close();

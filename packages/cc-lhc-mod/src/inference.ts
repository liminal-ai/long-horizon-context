export type InferenceLane = "bridge" | "sdk";

export const inferenceLane = (options: Readonly<Record<string, unknown>>): InferenceLane =>
  options.inferenceWorker === "sdk" ? "sdk" : "bridge";

export type BridgeRequest = {
  id: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  effort?: "low" | "medium" | "high";
};

export type BridgeOutcome =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: "api-error"; status: number | null; error: string }
  | { isAnswered: false; reason: "empty-reply" }
  | { isAnswered: false; reason: "aborted" };

export type BridgeResult = { id: string; outcome: BridgeOutcome };

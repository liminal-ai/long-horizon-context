export type CapturedMessage = {
  type: "user" | "assistant" | "attachment" | "system";
  name?: string;
  role?: "user" | "assistant";
  isMeta?: true;
  content: unknown[];
};

export type CaptureEntry =
  | {
      kind: "row";
      sessionId: string;
      uuid: string;
      door: string;
      origin: string;
      message: CapturedMessage;
      model?: string;
      at: number;
    }
  | { kind: "turn-start"; sessionId: string; turnId: string; at: number }
  | { kind: "step"; sessionId: string; turnId: string; index: number; at: number }
  | { kind: "turn-end"; sessionId: string; turnId: string; isAborted: boolean; reason: string; at: number };

/** How a session came to its thread: `replaced` is an older host's thread this host would not adopt. */
export type How = "new" | "resumed" | "forked" | "replaced";

/** How a session came to its LHC thread, as the sidecar answers a bind, or why it records nothing. */
export type BindAnswer = { threadId?: string; how?: How; notice?: string };

export type CaptureReply = { recorded: number } & BindAnswer;

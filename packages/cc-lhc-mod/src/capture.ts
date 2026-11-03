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

export type CaptureReply = { recorded: number; notice?: string };

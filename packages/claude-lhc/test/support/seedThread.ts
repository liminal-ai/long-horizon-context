import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { threads } from "lhc";
import { mapPrompt, mapSdkMessage } from "../../src/capture/mapper.ts";
import { bindSession, createLhc, createThread, threadRef } from "../../src/lhcHome.ts";

export const SEED_POLICY = { trigger: 500_000, target: 180_000 };

export const seedLhc = () => createLhc({ claudeBin: "claude", env: {}, tokenFamily: "claude-2026" });

const userMessage = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  }) as SDKUserMessage;

const assistantMessage = (uuid: string, text: string): SDKMessage =>
  ({
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    session_id: "",
    message: { id: `msg_${uuid}`, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text }] },
  }) as unknown as SDKMessage;

const resultMessage = (): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid: randomUUID(),
    session_id: "",
  }) as unknown as SDKMessage;

export async function seedThread(home: string, cwd: string): Promise<{ gen1: string; threadId: string }> {
  const gen1 = randomUUID();
  const threadId = await createThread(cwd, home);
  await bindSession(threadId, gen1, home);
  const stored = await threads.setCompactPolicy(threadRef(threadId, home), SEED_POLICY);
  if (!stored.ok) throw new Error(stored.error.reason);
  return { gen1, threadId };
}

export async function captureTurn(home: string, threadId: string, prompt: string, answer: string): Promise<string> {
  const uuid = randomUUID();
  await intake(home, threadId, [
    ...mapPrompt(userMessage(prompt), randomUUID(), false),
    ...mapSdkMessage(assistantMessage(uuid, answer), undefined).events,
    ...mapSdkMessage(resultMessage(), undefined).events,
  ]);
  return uuid;
}

export async function capturePrompt(home: string, threadId: string, prompt: string): Promise<void> {
  await intake(home, threadId, mapPrompt(userMessage(prompt), randomUUID(), false));
}

async function intake(home: string, threadId: string, events: ReturnType<typeof mapPrompt>): Promise<void> {
  const sent = await seedLhc().intakeStream.messageEvents(threadRef(threadId, home), events);
  if (!sent.ok) throw new Error(sent.error.reason);
}

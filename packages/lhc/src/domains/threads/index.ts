import { notImplemented, type OpResult } from "../../shared/errors.js";

export type ThreadRef =
  | { threadId: string; registryPath?: string }
  | { filePath: string };

export interface NewThreadInput {
  filePath: string;
  title?: string;
  registryPath?: string;
}

export interface ThreadInfo {
  threadId: string;
  filePath: string;
  title?: string;
  createdAt: string; // ISO-8601
}

export async function newThread(
  _input: NewThreadInput,
): Promise<OpResult<{ threadId: string; filePath: string }>> {
  return notImplemented("threads.new-thread");
}

export async function resolve(_input: {
  threadId: string;
  registryPath?: string;
}): Promise<OpResult<ThreadInfo>> {
  return notImplemented("threads.resolve");
}

export async function listThreads(_input?: {
  registryPath?: string;
}): Promise<OpResult<ThreadInfo[]>> {
  return notImplemented("threads.list");
}

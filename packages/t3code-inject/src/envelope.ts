// Envelope rules. Pure functions; unit tested.
//
// Sender: the relay's own `[from: x]` or `[from: x, channel: y]` first line
// wins; the sender and channel are carried into the rendered turn. Without one: --from, then LHC_RELAY_SENDER (the relay's job
// sender), then "lee" — a message with no attribution is the owner (phone
// path, or Lee at a terminal).
//
// Priority: --priority, else LHC_RELAY_JOB_CLASS === "prioritized" (Lee's
// phone path enqueues prioritized; agents default to deprioritized).

const FROM_LINE = /^\[from: ([^\],\n]+)(?:, channel: ([^\]\n]+))?\]\r?\n?/;
export const DEFAULT_SENDER = "lee";
/** A single message that waited less than this is sent without an arrival line. */
export const WAIT_MARK_MS = 5_000;

export interface Incoming {
  readonly sender: string;
  /** Channel named in the from line, if any (e.g. "iMessage"). */
  readonly channel: string | null;
  /** Prompt without the from line. */
  readonly body: string;
}

export function parseIncoming(
  prompt: string,
  fallback: { fromFlag?: string | null; envSender?: string | null } = {},
): Incoming {
  const match = FROM_LINE.exec(prompt);
  if (match) {
    return {
      sender: match[1]!.trim(),
      channel: match[2]?.trim() || null,
      body: prompt.slice(match[0].length),
    };
  }
  const sender = fallback.fromFlag?.trim() || fallback.envSender?.trim() || DEFAULT_SENDER;
  return { sender, channel: null, body: prompt };
}

export function resolvePriority(flag: boolean, envJobClass: string | null | undefined): boolean {
  return flag || envJobClass === "prioritized";
}

export interface QueuedPrompt {
  readonly body: string;
  readonly arrivedAt: string;
}

/**
 * One turn's text for one sender. `[from: x]` first, always. A high-priority
 * message that lands in a running turn gets `[arrived mid-turn at t]` next and
 * nothing else: no urgency framing. Queued prompts are each demarcated with
 * their arrival time when there is more than one, or when the single one waited.
 */
export function renderTurn(
  sender: string,
  prompts: readonly QueuedPrompt[],
  options: { now: string; midTurn?: boolean; channel?: string | null },
): string {
  if (prompts.length === 0) throw new Error("renderTurn: no prompts");
  const head = [options.channel ? `[from: ${sender}, channel: ${options.channel}]` : `[from: ${sender}]`];
  if (options.midTurn) head.push(`[arrived mid-turn at ${options.now}]`);
  const only = prompts.length === 1 ? prompts[0]! : null;
  if (only && Date.parse(options.now) - Date.parse(only.arrivedAt) < WAIT_MARK_MS) {
    return `${head.join("\n")}\n${only.body}`;
  }
  const parts = prompts.map((p) => `[arrived ${p.arrivedAt}]\n${p.body}`);
  return `${head.join("\n")}\n${parts.join("\n\n")}`;
}

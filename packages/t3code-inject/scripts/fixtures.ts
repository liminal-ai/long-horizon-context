// A 24-link chain of files, each ~1k tokens with one `CODE nn=word` line and a
// `NEXT:` line naming the following file, plus decoys that share the name
// prefixes but carry wrong codes. A model has to follow the chain one tool
// call at a time; globbing gives conflicting codes. Any provider, any tool
// style (Read or shell) ends up making >= 24 sequential calls.
import { randomBytes } from "node:crypto";

const WORDS = "amber basil cedar delta ember fjord garnet harbor indigo juniper kelp lumen maple nectar ocean pepper quartz raven saffron tundra umber velvet willow zephyr".split(" ");
const DECOY_WORDS = "apple bread candle donkey engine falcon guitar hammer island jacket kettle ladder mirror needle orange pencil quiver rocket saddle teapot".split(" ");
export interface Link { nn: string; word: string; name: string }
export const CODES: ReadonlyArray<{ nn: string; word: string }> = WORDS.map((word, i) => ({ nn: String(i + 1).padStart(2, "0"), word }));
export const START_FILE = "start.txt";

const filler = (tag: string) => Array.from({ length: 70 }, (_, k) => `line ${k + 1}: the quick brown fox jumps over the lazy dog near ${tag}`).join("\n");

export function chainFiles(): { files: Record<string, string>; chain: Link[] } {
  const chain: Link[] = CODES.map(({ nn, word }) => ({ nn, word, name: `link-${nn}-${randomBytes(2).toString("hex")}.txt` }));
  const files: Record<string, string> = {};
  files[START_FILE] = `The first link is ${chain[0]!.name}\n`;
  chain.forEach((link, i) => {
    const next = chain[i + 1]?.name ?? "none";
    files[link.name] = `${filler(link.name)}\nCODE ${link.nn}=${link.word}\nNEXT: ${next}\n${filler(link.name)}\n`;
  });
  for (const { nn } of CODES) {
    for (let d = 0; d < 2; d += 1) {
      const name = `link-${nn}-${randomBytes(2).toString("hex")}.txt`;
      files[name] = `${filler(name)}\nCODE ${nn}=${DECOY_WORDS[(Number(nn) + d) % DECOY_WORDS.length]}\nNEXT: none\n${filler(name)}\n`;
    }
  }
  return { files, chain };
}

export const READ_TASK =
  `Open ${START_FILE} with your file reading tool; it names the first link file. Each link file has a line \`CODE nn=word\` and a line \`NEXT: <file>\`. ` +
  "Follow the chain one file per tool call until NEXT is none. Files not reached through the chain are decoys with wrong codes, so do not list the directory or read files by pattern. " +
  "When the chain ends, reply with the 24 codes as `nn=word`, one per line, and nothing else unless asked.";

/** Which chain link a tool activity touched, from its payload text; "decoy" for a look-alike; null for neither. */
export function linkOf(payloadText: string, chain: readonly Link[]): string | null {
  for (const link of chain) if (payloadText.includes(link.name)) return link.nn;
  return /link-\d\d-[0-9a-f]{4}\.txt/.test(payloadText) ? "decoy" : null;
}

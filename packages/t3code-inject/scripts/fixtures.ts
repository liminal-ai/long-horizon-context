// A 24-link chain of files, each ~700 tokens with one `CODE nn=word` line and a
// `NEXT:` line naming the following file, plus decoys that share the name
// prefixes but carry wrong codes. A model has to follow the chain one tool
// call at a time; globbing gives conflicting codes. Any provider, any tool
// style (Read or shell) ends up making >= 24 sequential calls.
//
// Fresh per call: the code words, the run tag in every file name, and the
// start file name. A thread that ran an earlier chain (the durable relay seat)
// cannot answer a new one from memory.
import { randomBytes, randomInt } from "node:crypto";

const POOL = ("amber basil cedar delta ember fjord garnet harbor indigo juniper kelp lumen maple nectar ocean pepper quartz raven saffron tundra umber velvet willow zephyr " +
  "anvil bison comet dune eagle flint gecko heron iris jasper koala lotus mango nickel opal pearl quill ridge slate topaz urchin violet walnut yarrow " +
  "acorn birch cobalt dahlia elm fennel glacier hazel ivory jade kiwi lark marble nutmeg olive plum quince rowan sage thistle").split(" ");
const DECOY_WORDS = "apple bread candle donkey engine falcon guitar hammer island jacket kettle ladder mirror needle orange pencil quiver rocket saddle teapot".split(" ");
export interface Link { nn: string; word: string; name: string }
export interface Code { nn: string; word: string }
export interface Fixture { files: Record<string, string>; chain: Link[]; codes: Code[]; startFile: string; tag: string; task: string; namePattern: RegExp }

// ~15 lines each side of the code line: a file reads at roughly 700 tokens, so a
// 24-link chain costs ~20k tokens of tool results. (70 lines a side with the
// file name repeated per line came to ~3.6k tokens a file, ~90k a chain, which
// on the durable seat thread crossed the compact trigger mid-turn.)
const filler = (tag: string) => Array.from({ length: 15 }, (_, k) => `line ${k + 1}: the quick brown fox jumps over the lazy dog (${tag.slice(0, 6)})`).join("\n");
/** Matches every file chainFiles() ever writes, any run: used to clear a workspace before a new run. */
export const FIXTURE_FILE = /^(start(-[0-9a-f]{6})?\.txt|(link|chain-[0-9a-f]{6})-\d\d-[0-9a-f]{4}\.txt)$/;

export function chainFiles(): Fixture {
  const tag = randomBytes(3).toString("hex");
  const words = [...POOL];
  for (let i = words.length - 1; i > 0; i -= 1) { const j = randomInt(i + 1); [words[i], words[j]] = [words[j]!, words[i]!]; }
  const codes: Code[] = words.slice(0, 24).map((word, i) => ({ nn: String(i + 1).padStart(2, "0"), word }));
  const fileName = (nn: string) => `chain-${tag}-${nn}-${randomBytes(2).toString("hex")}.txt`;
  const chain: Link[] = codes.map(({ nn, word }) => ({ nn, word, name: fileName(nn) }));
  const startFile = `start-${tag}.txt`;
  const files: Record<string, string> = {};
  files[startFile] = `The first link is ${chain[0]!.name}\n`;
  chain.forEach((link, i) => {
    const next = chain[i + 1]?.name ?? "none";
    files[link.name] = `${filler(link.name)}\nCODE ${link.nn}=${link.word}\nNEXT: ${next}\n${filler(link.name)}\n`;
  });
  for (const { nn } of codes) {
    for (let d = 0; d < 2; d += 1) {
      const name = fileName(nn);
      files[name] = `${filler(name)}\nCODE ${nn}=${DECOY_WORDS[(Number(nn) + d) % DECOY_WORDS.length]}\nNEXT: none\n${filler(name)}\n`;
    }
  }
  const task =
    `Open ${startFile} with your file reading tool; it names the first link file. Each link file has a line \`CODE nn=word\` and a line \`NEXT: <file>\`. ` +
    "Follow the chain one file per tool call until NEXT is none. Files not reached through the chain are decoys with wrong codes, so do not list the directory or read files by pattern. " +
    "This is a new chain with new files and new codes; do not reuse codes from any earlier chain. " +
    "When the chain ends, reply with the 24 codes as `nn=word`, one per line, and nothing else unless asked.";
  return { files, chain, codes, startFile, tag, task, namePattern: new RegExp(`chain-${tag}-\\d\\d-[0-9a-f]{4}\\.txt`) };
}

/** Which chain link a tool activity touched, from its payload text; "decoy" for a look-alike of this run; null for neither. */
export function linkOf(payloadText: string, fx: Pick<Fixture, "chain" | "namePattern">): string | null {
  for (const link of fx.chain) if (payloadText.includes(link.name)) return link.nn;
  return fx.namePattern.test(payloadText) ? "decoy" : null;
}

/** True when every code of the run appears as `nn=word` in the text. */
export function hasAllCodes(text: string, codes: readonly Code[]): boolean {
  return codes.every(({ nn, word }) => new RegExp(`${nn}\\s*=\\s*${word}\\b`, "i").test(text));
}

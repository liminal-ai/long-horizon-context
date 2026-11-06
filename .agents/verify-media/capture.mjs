#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { paneScreen, plainText, renderPng } from "./term-png.mjs";

const USAGE = `usage: capture.mjs --checkout <dir> --session <tmux session> --side base|head --step <name>
                  [--wait-for <text>] <run dir>
  Captures the tmux session's screen into <run dir>/<side>/<step>.png, with the pane text beside it as <step>.txt
  and the commit of <dir> (the checkout whose build the pane runs) and whether it had uncommitted changes as
  <step>.json. --wait-for waits up to 15 s for <text> on screen and fails without it. Refuses, and writes
  nothing, when the pane text holds a token-shaped string.
  Capture the same steps on base and head; publish.mjs pairs them by step name.`;

/** Strings that look like a credential. A capture holding one is never written, so it can never be published. */
const TOKEN_SHAPES = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /ANTHROPIC_(?:AUTH_TOKEN|API_KEY)/,
  /Bearer\s+\S/,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export function tokenShaped(text) {
  for (const shape of TOKEN_SHAPES) {
    const m = shape.exec(text);
    if (m) return m[0];
  }
  return null;
}

export const STEP = /^[a-z0-9][a-z0-9-]*$/;

function commitOf(checkout) {
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" });
  return { sha: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain").trim() !== "" };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      checkout: { type: "string" },
      session: { type: "string" },
      side: { type: "string" },
      step: { type: "string" },
      "wait-for": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const { checkout, session, side, step } = values;
  if (values.help || !checkout || !session || !step || positionals.length !== 1 || !["base", "head"].includes(side)) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (!STEP.test(step)) {
    console.error(`capture REFUSED: step "${step}" is not lowercase letters, digits and hyphens`);
    process.exit(2);
  }
  let screen = paneScreen(session);
  const wanted = values["wait-for"];
  for (const end = Date.now() + 15_000; wanted && !plainText(screen.ansi).includes(wanted); screen = paneScreen(session)) {
    if (Date.now() > end) {
      console.error(`capture FAILED: "${wanted}" never showed in ${session} within 15 s`);
      process.exit(1);
    }
    execFileSync("sleep", ["0.2"]);
  }
  const text = plainText(screen.ansi);
  const token = tokenShaped(text);
  if (token) {
    console.error(
      `capture REFUSED: the pane shows a token-shaped string (${token.slice(0, 6)}…); nothing was written. ` +
        "Drive the capture from a throwaway home with no credentials on screen.",
    );
    process.exit(1);
  }
  const commit = commitOf(resolve(checkout));
  const dir = join(resolve(positionals[0]), side);
  mkdirSync(dir, { recursive: true });
  renderPng(screen, join(dir, `${step}.png`));
  writeFileSync(join(dir, `${step}.txt`), text);
  writeFileSync(join(dir, `${step}.json`), `${JSON.stringify({ step, side, ...commit }, null, 2)}\n`);
  console.log(`capture: ${join(dir, `${step}.png`)} at ${commit.sha}${commit.dirty ? " (dirty)" : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

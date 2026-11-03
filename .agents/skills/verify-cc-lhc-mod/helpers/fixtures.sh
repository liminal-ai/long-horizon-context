#!/usr/bin/env bash
set -euo pipefail
work="${1:?usage: fixtures.sh <home> [lines per file]}/work"
mkdir -p "$work"
node - "$work" "${2:-300}" <<'JS'
const { writeFileSync } = require("node:fs");
const { deflateSync, crc32 } = require("node:zlib");
const [work, count] = process.argv.slice(2);
const words = ["amber", "birch", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper"];
const last = ["whiskey", "echo", "romeo", "xray", "tango", "kilo"];
for (let f = 1; f <= 6; f++) {
  const lines = Array.from({ length: Number(count) }, (_, l) =>
    `line ${l}: ${Array.from({ length: 8 }, (_, k) => `${words[(l * 7 + k * 3 + f) % 10]}${(l * k + f) % 97}`).join(" ")}`,
  );
  writeFileSync(`${work}/f${f}.txt`, `${[...lines, `last word: ${last[f - 1]}`].join("\n")}\n`);
}
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
  return out;
};
const header = Buffer.alloc(13);
header.writeUInt32BE(64, 0);
header.writeUInt32BE(64, 4);
header.set([8, 2, 0, 0, 0], 8);
const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, Buffer.from([255, 32, 32]))]);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: 64 }, () => row)))),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(`${work}/pic.png`, png);
JS
echo "fixtures in $work"

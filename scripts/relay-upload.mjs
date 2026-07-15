#!/usr/bin/env node
import { createHash } from "crypto";
import { createReadStream, statSync } from "fs";
import { basename } from "path";

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    values[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.token || !args.file) {
  console.error("Usage: npm run relay-upload -- --url <uploadUrl> --token <token> --file <localFile>");
  process.exit(2);
}

const stat = statSync(args.file);
if (!stat.isFile()) throw new Error(`Not a file: ${args.file}`);

const response = await fetch(args.url, {
  method: "PUT",
  headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(stat.size),
    "X-Relay-Upload-Token": args.token,
  },
  body: createReadStream(args.file),
  duplex: "half",
});

const text = await response.text();
if (!response.ok) {
  throw new Error(`Upload failed (${response.status}): ${text}`);
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(args.file)) hash.update(chunk);
console.log(JSON.stringify({
  file: basename(args.file),
  bytes: stat.size,
  sha256: hash.digest("hex"),
  response: JSON.parse(text),
}, null, 2));

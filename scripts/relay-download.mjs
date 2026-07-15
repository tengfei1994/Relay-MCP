import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const url = value("--url");
const token = value("--token");
const file = value("--file");

if (!url || !token || !file) {
  console.error("Usage: npm run relay-download -- --url <downloadUrl> --token <token> --file <local-file>");
  process.exit(1);
}

const response = await fetch(url, {
  headers: { "X-Relay-Download-Token": token },
});
if (!response.ok || !response.body) {
  throw new Error(`Download failed: ${response.status} ${await response.text()}`);
}
await pipeline(response.body, createWriteStream(file, { flags: "w" }));
console.log(`Downloaded to ${file}`);

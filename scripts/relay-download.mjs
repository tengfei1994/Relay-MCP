import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const url = value("--url");
const token = value("--token");
const file = value("--file");
const expectedBytesArg = value("--expected-bytes");
const expectedSha256 = value("--expected-sha256")?.toLowerCase();
const expectedBytes = expectedBytesArg == null ? undefined : Number(expectedBytesArg);

if (!url || !token || !file) {
  console.error(
    "Usage: npm run relay-download -- --url <downloadUrl> --token <token> " +
    "--file <local-file> [--expected-bytes N] [--expected-sha256 HASH]"
  );
  process.exit(1);
}
if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
  throw new Error("--expected-bytes must be a non-negative safe integer");
}
if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
  throw new Error("--expected-sha256 must be a 64-character hexadecimal SHA-256 value");
}

const partial = `${file}.part`;
const existingBytes = existsSync(partial) ? statSync(partial).size : 0;
const headers = { "X-Relay-Download-Token": token };
if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;

const response = await fetch(url, { headers });
if (!response.ok || !response.body) {
  throw new Error(`Download failed: ${response.status} ${await response.text()}`);
}

const resumable = existingBytes > 0 && response.status === 206;
await pipeline(response.body, createWriteStream(partial, { flags: resumable ? "a" : "w" }));

const actualBytes = statSync(partial).size;
const advertisedBytes = Number(response.headers.get("x-relay-artifact-bytes"));
const requiredBytes = expectedBytes ?? (
  Number.isSafeInteger(advertisedBytes) && advertisedBytes >= 0 ? advertisedBytes : undefined
);
if (requiredBytes !== undefined && actualBytes !== requiredBytes) {
  throw new Error(`DOWNLOAD_BODY_SIZE_MISMATCH expected=${requiredBytes} actual=${actualBytes}`);
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(partial)) hash.update(chunk);
const actualSha256 = hash.digest("hex");
const requiredSha256 = expectedSha256 ?? response.headers.get("x-relay-sha256")?.toLowerCase();
if (requiredSha256 && actualSha256 !== requiredSha256) {
  throw new Error(`DOWNLOAD_SHA256_MISMATCH expected=${requiredSha256} actual=${actualSha256}`);
}

if (existsSync(file)) unlinkSync(file);
renameSync(partial, file);
console.log(JSON.stringify({
  ok: true,
  file,
  bytes: actualBytes,
  sha256: actualSha256,
  resumedFrom: resumable ? existingBytes : 0,
}, null, 2));

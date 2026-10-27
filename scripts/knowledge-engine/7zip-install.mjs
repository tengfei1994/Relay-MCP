#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const VERSION = '26.05';
const URL = 'https://github.com/ip7z/7zip/releases/download/26.05/7z2605-linux-x64.tar.xz';
const ARCHIVE_SHA = '22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e';
const BINARY_SHA = 'd32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
async function verifyInstalled(destination) {
  if ((await lstat(destination)).isSymbolicLink()) fail('Tool destination cannot be a symlink');
  let manifest; try { manifest = JSON.parse(await readFile(join(destination, 'tool.json'), 'utf8')); } catch { fail('Existing tool directory has no verified manifest'); }
  if (manifest.version !== VERSION || manifest.archiveSha256 !== ARCHIVE_SHA || manifest.files?.['7zz'] !== BINARY_SHA) fail('Existing tool version differs from the pinned release');
  for (const name of ['7zz', 'License.txt', 'readme.txt', 'license.htm']) {
    const path = join(destination, name);
    if ((await lstat(path)).isSymbolicLink() || hash(await readFile(path)) !== manifest.files[name]) fail('Existing tool checksum mismatch');
  }
}
async function download() {
  const response = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) fail('Official tool download failed');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 2_000_000) fail('Tool archive exceeds its pinned size bound'); parts.push(part); }
  return Buffer.concat(parts);
}
async function main() {
  const [argument, flag, archivePath] = process.argv.slice(2);
  if (!argument || (flag && (flag !== '--archive' || !archivePath))) fail('Usage: 7zip-install.mjs <dedicated-output-dir> [--archive verified-archive]');
  const destination = resolve(argument);
  if ([parse(destination).root, resolve(homedir()), resolve(process.cwd())].includes(destination)) fail('Use a dedicated tool directory, never a filesystem or workspace root');
  if (existsSync(destination)) { await verifyInstalled(destination); console.log(JSON.stringify({ installed: true, reused: true, version: VERSION })); return; }
  const raw = archivePath ? await readFile(resolve(archivePath)) : await download();
  if (hash(raw) !== ARCHIVE_SHA) fail('Official 7-Zip archive checksum mismatch');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(destination)) !== dirname(destination)) fail('Tool destination parent cannot contain symlinks');
  const stage = destination + '.tmp-' + randomBytes(8).toString('hex');
  await mkdir(stage, { mode: 0o700 });
  try {
    const archive = join(stage, '.archive.tar.xz'); await writeFile(archive, raw, { mode: 0o600 });
    const helper = join(dirname(fileURLToPath(import.meta.url)), '7zip-unpack.py');
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [helper, archive, stage], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (result.status !== 0 || result.error) fail('Verified tool extraction failed');
    await rm(archive);
    const files = {};
    for (const name of ['7zz', 'License.txt', 'readme.txt', 'license.htm']) { files[name] = hash(await readFile(join(stage, name))); await chmod(join(stage, name), name === '7zz' ? 0o700 : 0o600); }
    if (files['7zz'] !== BINARY_SHA) fail('Official 7-Zip binary checksum mismatch');
    await writeFile(join(stage, 'tool.json'), JSON.stringify({ version: VERSION, platform: 'linux-amd64', source: URL, archiveSha256: ARCHIVE_SHA, files }, null, 2) + '\n', { mode: 0o600 });
    await rename(stage, destination);
    console.log(JSON.stringify({ installed: true, version: VERSION, binarySha256: BINARY_SHA }));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
try { await main(); } catch (error) { console.error('7-Zip installer: ' + error.message); process.exitCode = 1; }
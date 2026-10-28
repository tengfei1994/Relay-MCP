#!/usr/bin/env node
// Relay owns the lifecycle; the upstream API never needs a public listener.
import { mkdir, readFile, writeFile, rename, chmod, readdir, stat, lstat, realpath, copyFile, cp, unlink, open } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, parse } from 'node:path';
import { homedir } from 'node:os';
import { managedEngineEnv } from './knowledge-engine/runtime-env.mjs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), '..');
const upstreamLockPath = join(repository, 'scripts', 'knowledge-engine', 'upstream-lock.json');
const upstreamLock = JSON.parse(await readFile(upstreamLockPath, 'utf8'));
const VERSION = 'v0.8.3';
const COMMIT = '3e22822c1d2397be730c458c7539d0eb8c113a24';
const home = resolve(process.env.KNOWLEDGE_ENGINE_HOME || join(repository, 'runtime', 'knowledge-engine'));
const configPath = join(home, 'engine.json');
const pidPath = join(home, 'run', 'engine.pid.json');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = async (path) => {
  const contents = await readFile(path, 'utf8');
  try { return JSON.parse(contents); }
  catch { fail('Invalid runtime JSON configuration; inspect the private file locally'); }
};
const output = (value) => console.log(JSON.stringify(value, null, 2));
function fail(message) { throw new Error(message); }
function safeHome() {
  if (existsSync(home) && lstatSync(home).isSymbolicLink()) fail('A symlink cannot be used as the dedicated runtime directory');
  if ([parse(home).root, resolve(homedir()), repository].includes(home)) fail('Choose a dedicated knowledge-engine directory, never a filesystem root, home or repository root');
}
async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
async function ensureHome() {
  safeHome();
  for (const dir of ['', 'releases', 'data', 'data/files', 'data/home', 'logs', 'run', 'backups']) {
    if (existsSync(join(home, dir)) && lstatSync(join(home, dir)).isSymbolicLink()) fail('Runtime subdirectories cannot be symlinks');
    await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
    await chmod(join(home, dir), 0o700);
  }
}
function localUrl(value, field) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    fail(`${field} must use an authenticated internal HTTP service on 127.0.0.1`);
  }
  return url.toString().replace(/\/$/, '');
}
function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--')) fail(`Missing value for ${name}`);
  return args[at + 1];
}
async function checksum(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || isAbsolute(name) || name.split('/').some((p) => !p || p === '.' || p === '..') || name.includes(':')) fail('Unsafe relative artifact path');
}
async function manifestFiles(bundle, manifest) {
  if (manifest.schemaVersion !== 1 || manifest.version !== VERSION || manifest.sourceCommit !== COMMIT || manifest.platform !== 'linux-amd64') fail('Artifact does not match the pinned upstream version/platform');
  const expectedPatches = upstreamLock.patches.map(({ id, sha256 }) => ({ id, sha256 }));
  if (manifest.securityPolicy !== upstreamLock.securityPolicy || manifest.sourceArchiveSha256 !== upstreamLock.sourceArchiveSha256 ||
      manifest.goVersion !== upstreamLock.goVersion || JSON.stringify(manifest.relayPatches) !== JSON.stringify(expectedPatches)) {
    fail('Artifact is missing the reviewed logging security patch policy');
  }
  if (manifest.files?.['relay-upstream-lock.json'] !== await checksum(upstreamLockPath) ||
      !Object.hasOwn(manifest.files || {}, 'relay-log-safety-proof.json')) fail('Artifact is missing its locked logging security proof');
  for (const asset of [...upstreamLock.patches, ...upstreamLock.regressionTests]) {
    if (manifest.files['relay-patches/' + asset.file.split('/').pop()] !== asset.sha256) fail('Artifact logging security patch asset mismatch');
  }
  if (!manifest.files || !Object.hasOwn(manifest.files, 'WeKnora-lite') || !Object.hasOwn(manifest.files, 'config/config.yaml') || !Object.keys(manifest.files).some((p) => /^migrations\/sqlite\/\d+.*\.up\.sql$/.test(p))) fail('Artifact is missing its binary, config or SQLite migrations');
  for (const name of ['jieba.dict.utf8', 'hmm_model.utf8', 'user.dict.utf8', 'idf.utf8', 'stop_words.utf8']) {
    if (!Object.hasOwn(manifest.files, 'dict/' + name)) fail('Artifact is missing required Jieba dictionaries');
  }
  if (!Number.isInteger(manifest.migrationVersion) || manifest.migrationVersion < 1) fail('Artifact is missing a migration version');
  const root = await realpath(bundle);
  for (const [name, expected] of Object.entries(manifest.files)) {
    safeRelative(name);
    const file = join(bundle, name);
    const resolved = await realpath(file);
    if (relative(root, resolved).startsWith('..') || isAbsolute(relative(root, resolved)) || !(await lstat(file)).isFile()) fail('Unsafe artifact file or symlink');
    if (!/^[a-f0-9]{64}$/.test(expected) || await checksum(file) !== expected) fail(`Artifact checksum mismatch: ${name}`);
  }
  const proof = await json(join(bundle, 'relay-log-safety-proof.json'));
  if (proof.schemaVersion !== 1 || proof.status !== 'passed' || proof.securityPolicy !== upstreamLock.securityPolicy ||
      proof.binarySha256 !== manifest.files['WeKnora-lite'] || JSON.stringify(proof.relayPatches) !== JSON.stringify(expectedPatches) ||
      !/^[a-f0-9]{64}$/.test(proof.testLogSha256 || '') ||
      !['TestRelayRequestLogOmitsPrivatePayloads', 'TestRelayModelErrorsOmitPrivateResponseAndURL'].every(name => proof.tests?.includes(name))) {
    fail('Artifact logging security regression proof is incomplete');
  }
}
async function readConfig() {
  const config = await json(configPath);
  if (config.schemaVersion !== 1 || typeof config.systemAesKey !== 'string' || Buffer.byteLength(config.systemAesKey) !== 32) fail('Runtime configuration is missing its encryption key; restore the private configuration from backup');
  for (const name of ['gatewayToken', 'jwtSecret']) {
    if (typeof config[name] !== 'string' || config[name].length < 32) fail('Runtime credential configuration is incomplete; restore it from backup');
  }
  // Preserve stored credentials; registration policy applies when generating a new owner password.
  if (typeof config.ownerPassword !== 'string' || config.ownerPassword.length < 8) fail('Runtime owner credential is incomplete; restore it from backup');
  if (typeof config.ownerEmail !== 'string' || !config.ownerEmail.includes('@')) fail('Runtime owner configuration is incomplete');
  localUrl(config.baseUrl, 'baseUrl');
  localUrl(config.relayGatewayUrl, 'relayGatewayUrl');
  if (config.version !== VERSION || config.sourceCommit !== COMMIT) fail('Runtime config version differs from the pinned engine');
  const release = resolve(config.releasePath);
  if (!relative(join(home, 'releases'), release) || relative(join(home, 'releases'), release).startsWith('..') || isAbsolute(relative(join(home, 'releases'), release))) fail('Release directory is outside this runtime');
  return config;
}
async function processState() {
  if (!existsSync(pidPath)) return { running: false };
  const record = await json(pidPath);
  if (!Number.isInteger(record.pid) || record.pid <= 1) fail('Invalid engine PID record');
  try { process.kill(record.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return { running: false, stale: true };
    throw error;
  }
  if (process.platform !== 'linux') return { running: true, owned: false, ...record };
  try {
    const executable = await realpath(`/proc/${record.pid}/exe`);
    const raw = await readFile(`/proc/${record.pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return { running: false, stale: true };
    const config = await readConfig();
    const expected = await realpath(join(config.releasePath, 'WeKnora-lite'));
    return { ...record, running: true, owned: executable === expected && executable === record.executable && fields[19] === record.startTicks };
  } catch (error) {
    if (error.code === 'ENOENT') return { running: false, stale: true };
    throw error;
  }
}
async function install(args) {
  safeHome();
  const state = await processState();
  if (state.running) fail('Stop the existing engine before installing a release');
  let bundle = option(args, '--bundle') || process.env.KNOWLEDGE_ENGINE_BUNDLE;
  if (!bundle) {
    if (process.platform !== 'linux' || process.arch !== 'x64') fail('Build requires Linux amd64; provide --bundle with a verified prebuilt artifact');
    await ensureHome();
    bundle = join(home, 'build', 'bundle');
    const build = spawnSync('bash', [join(dirname(script), 'knowledge-engine', 'build.sh'), join(home, 'build')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    if (build.error) throw build.error;
    if (build.status !== 0) fail('Knowledge engine build failed; active release is unchanged');
  }
  bundle = resolve(bundle);
  const manifest = await json(join(bundle, 'manifest.json'));
  await manifestFiles(bundle, manifest);
  await ensureHome();
  const release = join(home, 'releases', `${VERSION}-${(await checksum(join(bundle, 'manifest.json'))).slice(0, 16)}`);
  if (!existsSync(release)) {
    const stage = `${release}.stage-${randomBytes(6).toString('hex')}`;
    await mkdir(stage, { mode: 0o700 });
    for (const name of Object.keys(manifest.files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true, mode: 0o700 });
      await copyFile(join(bundle, name), join(stage, name));
    }
    await copyFile(join(bundle, 'manifest.json'), join(stage, 'manifest.json'));
    await chmod(join(stage, 'WeKnora-lite'), 0o700);
    if (Object.hasOwn(manifest.files, 'tools/7zip/7zz')) await chmod(join(stage, 'tools', '7zip', '7zz'), 0o700);
    await manifestFiles(stage, manifest);
    await rename(stage, release);
  } else await manifestFiles(release, manifest);
  const previous = existsSync(configPath) ? await readConfig() : null;
  const port = option(args, '--port');
  if (port !== undefined && (!/^\d+$/.test(port) || +port < 1024 || +port > 65535)) fail('Port must be between 1024 and 65535');
  const config = {
    schemaVersion: 1, version: VERSION, sourceCommit: COMMIT,
    baseUrl: localUrl(port ? `http://127.0.0.1:${port}` : previous?.baseUrl || process.env.KNOWLEDGE_ENGINE_BASE_URL || 'http://127.0.0.1:18190', 'baseUrl'),
    relayGatewayUrl: localUrl(option(args, '--gateway-url') || process.env.RELAY_KNOWLEDGE_GATEWAY_URL || previous?.relayGatewayUrl || 'http://127.0.0.1:3000/internal/knowledge-engine/v1', 'relayGatewayUrl'),
    gatewayToken: previous?.gatewayToken || randomBytes(32).toString('hex'),
    ownerEmail: previous?.ownerEmail || 'relay-engine@localhost.invalid',
    ownerPassword: previous?.ownerPassword || randomBytes(21).toString('base64url') + 'aA1!',
    systemAesKey: previous?.systemAesKey || randomBytes(16).toString('hex'),
    jwtSecret: previous?.jwtSecret || randomBytes(32).toString('hex'), releasePath: release,
  };
  await privateJson(configPath, config);
  output({ installed: true, version: VERSION, baseUrl: config.baseUrl, home, releasePath: release });
}

async function runForeground() {
  if (process.platform !== 'linux') fail('Running the bundled engine requires Linux amd64');
  const config = await readConfig();
  if ((await processState()).running) fail('Knowledge engine is already running');
  await manifestFiles(config.releasePath, await json(join(config.releasePath, 'manifest.json')));
  const executable = await realpath(join(config.releasePath, 'WeKnora-lite'));
  const child = spawn(executable, [], { cwd: config.releasePath, env: managedEngineEnv(config, home), stdio: 'inherit' });
  await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no); });
  const raw = await readFile(`/proc/${child.pid}/stat`, 'utf8');
  const startTicks = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  await privateJson(pidPath, { pid: child.pid, executable, startTicks });
  const forward = (signal) => { if (child.exitCode === null) child.kill(signal); };
  process.on('SIGTERM', forward); process.on('SIGINT', forward);
  const exitCode = await new Promise((done) => child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0))));
  if (existsSync(pidPath) && (await json(pidPath)).pid === child.pid) await unlink(pidPath);
  process.exitCode = exitCode;
}
function python(args) {
  const result = spawnSync(process.env.KNOWLEDGE_ENGINE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [join(dirname(script), 'knowledge-engine', 'sqlite-state.py'), ...args], { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail((result.stderr || 'SQLite validation failed').trim());
  return JSON.parse(result.stdout);
}
async function status() {
  if (!existsSync(configPath)) return { state: 'not_installed', ready: false, action: 'Run node scripts/knowledge-engine.mjs install' };
  const config = await readConfig();
  const state = await processState();
  const result = { state: 'stopped', ready: false, version: VERSION, baseUrl: config.baseUrl, home };
  if (!state.running) return result;
  if (!state.owned) return { ...result, state: 'pid_conflict' };
  let healthy = false;
  try { healthy = (await fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
  let database = { ready: false };
  if (existsSync(join(home, 'data', 'weknora.db'))) {
    const manifest = await json(join(config.releasePath, 'manifest.json'));
    try { database = python(['status', join(home, 'data', 'weknora.db'), String(manifest.migrationVersion)]); } catch { database = { ready: false, error: 'Database readiness check failed' }; }
  }
  return { ...result, state: healthy && database.ready ? 'running' : 'starting_or_failed', ready: healthy && database.ready, pid: state.pid, database };
}
async function stop() {
  const state = await processState();
  if (!state.running) {
    if (existsSync(pidPath)) await unlink(pidPath);
    return { stopped: true };
  }
  if (!state.owned) fail('PID identity does not belong to this engine; refusing to signal another process');
  process.kill(state.pid, 'SIGTERM');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (!(await processState()).running) {
      if (existsSync(pidPath)) await unlink(pidPath);
      return { stopped: true };
    }
    await sleep(200);
  }
  fail('Engine did not stop within 45 seconds; no forced kill was sent');
}
async function waitReady(timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.ready) return current;
    await sleep(500);
  }
  fail('Engine failed readiness; inspect the private engine logs');
}
async function start() {
  const before = await status();
  if (before.ready) return before;
  if ((await processState()).running) fail('Engine already has a running process; inspect status/logs before restarting');
  const log = await open(join(home, 'logs', 'engine.log'), 'a', 0o600);
  await log.chmod(0o600);
  const child = spawn(process.execPath, [script, 'run'], { detached: true, env: { ...process.env, KNOWLEDGE_ENGINE_HOME: home }, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await status();
    if (current.ready) return current;
    await sleep(500);
  }
  await stop();
  fail('Engine failed readiness; inspect the private logs/engine.log');
}
async function backup() {
  const config = await readConfig();
  if ((await processState()).running) fail('Stop the engine before backup so database and source files form one consistent snapshot');
  const backupPath = join(home, 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
  await mkdir(backupPath, { mode: 0o700 });
  await cp(join(home, 'data'), join(backupPath, 'data'), { recursive: true });
  python(['backup', join(home, 'data', 'weknora.db'), join(backupPath, 'data', 'weknora.db')]);
  for (const suffix of ['-wal', '-shm']) if (existsSync(join(backupPath, 'data', `weknora.db${suffix}`))) await unlink(join(backupPath, 'data', `weknora.db${suffix}`));
  await privateJson(join(backupPath, 'engine.json'), config);
  if (existsSync(join(home, 'control.json'))) await privateJson(join(backupPath, 'control.json'), await json(join(home, 'control.json')));
  await privateJson(join(backupPath, 'backup.json'), { schemaVersion: 1, version: config.version, sourceCommit: config.sourceCommit, createdAt: new Date().toISOString() });
  return { backupPath };
}
async function restore(backupPath) {
  if (!backupPath) fail('Provide a backup directory');
  const config = await readConfig();
  if ((await processState()).running) fail('Stop the engine before restoring');
  if (existsSync(join(home, 'data', 'weknora.db')) || (await readdir(join(home, 'data', 'files'))).length) fail('Restore requires an empty data directory; existing data is never overwritten');
  const metadata = await json(join(backupPath, 'backup.json'));
  if (metadata.version !== VERSION || metadata.sourceCommit !== COMMIT) fail('Backup version does not match the installed engine');
  const source = await json(join(backupPath, 'engine.json'));
  await cp(join(backupPath, 'data'), join(home, 'data'), { recursive: true });
  await privateJson(configPath, { ...source, baseUrl: config.baseUrl, relayGatewayUrl: config.relayGatewayUrl, releasePath: config.releasePath });
  if (existsSync(join(backupPath, 'control.json'))) await privateJson(join(home, 'control.json'), await json(join(backupPath, 'control.json')));
  return { restored: true, home, baseUrl: config.baseUrl };
}

try {
  safeHome();
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'install': await install(args); break;
    case 'run': await runForeground(); break;
    case 'start': output(await start()); break;
    case 'status': output(await status()); break;
    case 'wait': output(await waitReady()); break;
    case 'stop': output(await stop()); break;
    case 'restart': await stop(); output(await start()); break;
    case 'backup': output(await backup()); break;
    case 'restore': output(await restore(args[0] && resolve(args[0]))); break;
    default: fail('Usage: knowledge-engine.mjs install [--bundle DIR] [--port N] [--gateway-url URL] | run | start | status | stop | restart | backup | restore DIR');
  }
} catch (error) {
  console.error(`Knowledge engine: ${error.message}`);
  process.exitCode = 1;
}
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const launcher = resolve('scripts/knowledge-engine.mjs');
const commit = '3e22822c1d2397be730c458c7539d0eb8c113a24';
function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], {
    encoding: 'utf8', env: { ...process.env, KNOWLEDGE_ENGINE_HOME: home }, timeout: 20_000,
  });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-engine-runtime-'));
  const home = join(root, 'runtime');
  const bundle = join(root, 'bundle');
  const files: Record<string, string> = {
    'WeKnora-lite': 'fixture binary used only to test installer integrity',
    'config/config.yaml': 'server:\n  host: 127.0.0.1\n  port: 18190\n',
    'migrations/sqlite/000001_initial.up.sql': 'SELECT 1;',
    'LICENSE': 'Fixture license',
    'dict/jieba.dict.utf8': 'fixture', 'dict/hmm_model.utf8': 'fixture',
    'dict/user.dict.utf8': 'fixture', 'dict/idf.utf8': 'fixture', 'dict/stop_words.utf8': 'fixture',
  };
  const lockText = readFileSync(resolve('scripts/knowledge-engine/upstream-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const relayPatches = lock.patches.map((p: {id:string;sha256:string}) => ({id:p.id,sha256:p.sha256}));
  files['relay-upstream-lock.json'] = lockText;
  for (const asset of [...lock.patches, ...lock.regressionTests]) files['relay-patches/' + asset.file.split('/').pop()] = readFileSync(resolve('scripts/knowledge-engine', asset.file), 'utf8');
  files['relay-log-safety-proof.json'] = JSON.stringify({schemaVersion:1,status:'passed',securityPolicy:lock.securityPolicy,
    binarySha256:createHash('sha256').update(files['WeKnora-lite']).digest('hex'),testLogSha256:'0'.repeat(64),relayPatches,
    tests:['TestRelayRequestLogOmitsPrivatePayloads','TestRelayModelErrorsOmitPrivateResponseAndURL']});
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(bundle, name, '..'), { recursive: true });
    writeFileSync(join(bundle, name), content);
    hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  const manifest = { schemaVersion: 1, version: 'v0.8.3', sourceCommit: commit,
    goVersion: 'go1.26.10', platform: 'linux-amd64', migrationVersion: 1, sourceArchiveSha256:lock.sourceArchiveSha256,
    securityPolicy:lock.securityPolicy,relayPatches,files: hashes };
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest));
  return { root, home, bundle, manifest, clean: () => rmSync(root, { recursive: true, force: true }) };
}
function database(home: string, dirty = 0) {
  const db = new Database(join(home, 'data', 'weknora.db'));
  db.exec(`CREATE TABLE schema_migrations(version INTEGER, dirty INTEGER);
    INSERT INTO schema_migrations VALUES (1, ${dirty});
    CREATE TABLE users(id TEXT); CREATE TABLE tenants(id TEXT);
    CREATE TABLE knowledge_bases(id TEXT); CREATE TABLE models(id TEXT);
    CREATE TABLE documents(id TEXT, body TEXT); INSERT INTO documents VALUES ('d1','persisted evidence');`);
  db.close();
}

test('installer rejects a filesystem root before writing runtime state', () => {
  const result = run(parse(process.cwd()).root, 'install', '--bundle', 'missing');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dedicated|root/i);
});

test('installer verifies every artifact before switching the active release or creating secrets', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.bundle, 'WeKnora-lite'), 'tampered');
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum/i);
    assert.equal(existsSync(join(f.home, 'engine.json')), false);
  } finally { f.clean(); }
});

test('installer rejects traversal entries and never writes outside its release directory', () => {
  const f = fixture();
  try {
    f.manifest.files['../escape.txt'] = 'a'.repeat(64);
    writeFileSync(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe|relative/i);
    assert.equal(existsSync(join(f.home, 'escape.txt')), false);
  } finally { f.clean(); }
});

test('reinstall preserves generated credentials and status never exposes them', () => {
  const f = fixture();
  try {
    const first = run(f.home, 'install', '--bundle', f.bundle);
    assert.equal(first.status, 0, first.stderr);
    const config = JSON.parse(readFileSync(join(f.home, 'engine.json'), 'utf8'));
    for (const key of ['gatewayToken', 'ownerPassword', 'systemAesKey', 'jwtSecret']) {
      assert.ok(config[key].length >= 32);
      assert.ok(!first.stdout.includes(config[key]));
    }
    assert.equal(config.baseUrl, 'http://127.0.0.1:18190');
    assert.equal(config.relayGatewayUrl, 'http://127.0.0.1:3000/internal/knowledge-engine/v1');
    if (process.platform !== 'win32') assert.equal(statSync(join(f.home, 'engine.json')).mode & 0o777, 0o600);
    const again = run(f.home, 'install', '--bundle', f.bundle);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'engine.json'), 'utf8')), config);
    const status = run(f.home, 'status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'stopped');
    assert.ok(!status.stdout.includes(config.gatewayToken));
  } finally { f.clean(); }
});

test('stop refuses a PID belonging to another live process', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    writeFileSync(join(f.home, 'run', 'engine.pid.json'), JSON.stringify({
      pid: process.pid, executable: join(f.home, 'wrong-binary'), startTicks: '0',
    }));
    const result = run(f.home, 'stop');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity|another|ownership/i);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { f.clean(); }
});

test('backup and restore preserve database content, files and credentials without overwriting existing data', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    database(f.home);
    writeFileSync(join(f.home, 'data', 'files', 'source.md'), 'original evidence');
    writeFileSync(join(f.home, 'control.json'), JSON.stringify({ knowledgeBaseId: 'kb1' }));
    const backup = run(f.home, 'backup');
    assert.equal(backup.status, 0, backup.stderr);
    const backupPath = JSON.parse(backup.stdout).backupPath;
    const restoredHome = join(f.root, 'restored');
    assert.equal(run(restoredHome, 'install', '--bundle', f.bundle, '--port', '18191').status, 0);
    const restore = run(restoredHome, 'restore', backupPath);
    assert.equal(restore.status, 0, restore.stderr);
    const db = new Database(join(restoredHome, 'data', 'weknora.db'), { readonly: true });
    assert.equal((db.prepare('SELECT body FROM documents WHERE id = ?').get('d1') as {body: string}).body, 'persisted evidence');
    db.close();
    assert.equal(readFileSync(join(restoredHome, 'data', 'files', 'source.md'), 'utf8'), 'original evidence');
    assert.equal(JSON.parse(readFileSync(join(restoredHome, 'control.json'), 'utf8')).knowledgeBaseId, 'kb1');
    const before = JSON.parse(readFileSync(join(f.home, 'engine.json'), 'utf8'));
    const after = JSON.parse(readFileSync(join(restoredHome, 'engine.json'), 'utf8'));
    assert.equal(after.systemAesKey, before.systemAesKey);
    assert.equal(after.baseUrl, 'http://127.0.0.1:18191');
    const again = run(restoredHome, 'restore', backupPath);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /empty|existing/i);
  } finally { f.clean(); }
});
test('installer refuses a symlink runtime root instead of changing its target', () => {
  const f = fixture();
  try {
    const target = join(f.root, 'untouched');
    mkdirSync(target);
    symlinkSync(target, f.home, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink|dedicated/i);
    assert.equal(existsSync(join(target, 'engine.json')), false);
  } finally { f.clean(); }
});

test('database readiness rejects dirty or incomplete migrations despite an existing database', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    database(f.home, 1);
    const helper = resolve('scripts/knowledge-engine/sqlite-state.py');
    const inspect = (version: string) => spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      [helper, 'status', join(f.home, 'data', 'weknora.db'), version], { encoding: 'utf8' });
    let result = inspect('1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ready, false);
    const db = new Database(join(f.home, 'data', 'weknora.db'));
    db.exec('UPDATE schema_migrations SET dirty = 0');
    result = inspect('2');
    assert.equal(JSON.parse(result.stdout).ready, false);
    result = inspect('1');
    assert.equal(JSON.parse(result.stdout).ready, true);
    db.exec('DROP TABLE models'); db.close();
    result = inspect('1');
    assert.equal(JSON.parse(result.stdout).ready, false);
  } finally { f.clean(); }
});
test('malformed private configuration errors do not print credential fragments', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    writeFileSync(join(f.home, 'engine.json'), 'secret-must-stay-private');
    const result = run(f.home, 'status');
    assert.notEqual(result.status, 0);
    assert.ok(!result.stderr.includes('secret-mus'));
    assert.match(result.stderr, /configuration|JSON/i);
  } finally { f.clean(); }
});
test('installer rejects a bundle without the dictionaries required after relocation', () => {
  const f = fixture();
  try {
    delete f.manifest.files['dict/jieba.dict.utf8'];
    writeFileSync(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dictionary|dictionaries/i);
  } finally { f.clean(); }
});
test('reinstall refuses incomplete private keys instead of silently replacing encryption identity', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    const configPath = join(f.home, 'engine.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.systemAesKey;
    writeFileSync(configPath, JSON.stringify(config));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /key|credential|configuration/i);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).systemAesKey, undefined);
  } finally { f.clean(); }
});
test('new owner credentials satisfy the upstream registration password policy', () => {
  const f = fixture();
  try {
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.equal(result.status, 0, result.stderr);
    const { ownerPassword } = JSON.parse(readFileSync(join(f.home, 'engine.json'), 'utf8'));
    assert.ok(ownerPassword.length >= 8 && ownerPassword.length <= 32, 'owner password must have 8–32 characters');
    assert.match(ownerPassword, /[a-z]/);
    assert.match(ownerPassword, /[A-Z]/);
    assert.match(ownerPassword, /[0-9]/);
    assert.match(ownerPassword, /[^a-zA-Z0-9]/);
    assert.ok(!result.stdout.includes(ownerPassword));
    assert.ok(!result.stderr.includes(ownerPassword));
  } finally { f.clean(); }
});

test('reinstall preserves an existing owner password accepted by upstream', () => {
  const f = fixture();
  try {
    assert.equal(run(f.home, 'install', '--bundle', f.bundle).status, 0);
    const configPath = join(f.home, 'engine.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.ownerPassword = 'Existing-A1!';
    writeFileSync(configPath, JSON.stringify(config));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), config);
    assert.ok(!result.stdout.includes(config.ownerPassword));
    assert.ok(!result.stderr.includes(config.ownerPassword));
  } finally { f.clean(); }
});
test('installer refuses an upstream bundle without the reviewed logging safety policy', () => {
  const f = fixture();
  try {
    delete (f.manifest as Record<string, unknown>).securityPolicy;
    writeFileSync(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /security|patch|logging/i);
    assert.equal(existsSync(join(f.home, 'engine.json')), false);
  } finally { f.clean(); }
});


test('installer rejects a different security patch identity even when artifact hashes match', () => {
  const f = fixture();
  try {
    f.manifest.relayPatches[0].sha256 = 'f'.repeat(64);
    writeFileSync(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /security|patch/);
    assert.equal(existsSync(join(f.home, 'engine.json')), false);
  } finally { f.clean(); }
});
test('installer refuses failed privacy-test evidence bound to an otherwise intact binary', () => {
  const f = fixture();
  try {
    const path = join(f.bundle, 'relay-log-safety-proof.json');
    const proof = JSON.parse(readFileSync(path, 'utf8'));
    proof.status = 'failed';
    const text = JSON.stringify(proof);
    writeFileSync(path, text);
    f.manifest.files['relay-log-safety-proof.json'] = createHash('sha256').update(text).digest('hex');
    writeFileSync(join(f.bundle, 'manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.home, 'install', '--bundle', f.bundle);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /security regression proof/i);
    assert.equal(existsSync(join(f.home, 'engine.json')), false);
  } finally { f.clean(); }
});

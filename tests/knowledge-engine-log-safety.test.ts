import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The lifecycle helper is intentionally plain Node ESM.
import { managedEngineEnv } from '../scripts/knowledge-engine/runtime-env.mjs';
test('managed runtime suppresses body logs and refuses inherited debug or provider secrets', () => {
  const config = { baseUrl: 'http://127.0.0.1:18190', releasePath: '/isolated/release', systemAesKey: 'private-aes', jwtSecret: 'private-jwt' };
  const inherited = { PATH: '/bin', LOG_LEVEL: 'debug', LLM_DEBUG_LOG: '/tmp/prompt-dump', WEKNORA_LLM_STREAM_RAW_DUMP: '1', WEKNORA_LLM_STREAM_RAW_DUMP_DIR: '/tmp/stream-dump', BAILIAN_API_KEY: 'must-not-inherit' };
  const env = managedEngineEnv(config, '/isolated/runtime', inherited);
  assert.equal(env.LOG_LEVEL, 'warn');
  assert.equal(env.LLM_DEBUG_LOG, 'false');
  assert.equal(env.WEKNORA_LLM_STREAM_RAW_DUMP, 'false');
  assert.equal(env.WEKNORA_LLM_STREAM_RAW_DUMP_DIR, undefined);
  assert.equal(env.BAILIAN_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.SYSTEM_AES_KEY, config.systemAesKey);
});


import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const python = process.platform === 'win32' ? 'python' : 'python3';
test('build verifies pinned security patch assets and refuses tampering before applying', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-log-patch-'));
  try {
    const assets = join(root, 'assets');
    cpSync(resolve('scripts/knowledge-engine'), assets, {recursive:true});
    const helper = join(assets, 'apply-patches.py');
    const verify = () => spawnSync(python, [helper, '--verify-assets'], {encoding:'utf8'});
    assert.equal(verify().status, 0);
    const lock = JSON.parse(readFileSync(join(assets, 'upstream-lock.json'), 'utf8'));
    writeFileSync(join(assets, lock.patches[0].file), 'tampered patch bytes');
    const rejected = verify();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /checksum/i);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
test('patching refuses changed pinned source without modifying it', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-log-source-'));
  try {
    const lock = JSON.parse(readFileSync(resolve('scripts/knowledge-engine/upstream-lock.json'), 'utf8'));
    const target = join(root, lock.patches[0].targets[0].path);
    mkdirSync(join(target, '..'), {recursive:true});
    writeFileSync(target, 'different upstream source');
    const result = spawnSync(python, [resolve('scripts/knowledge-engine/apply-patches.py'), root], {encoding:'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source target checksum/);
    assert.equal(readFileSync(target, 'utf8'), 'different upstream source');
  } finally { rmSync(root, {recursive:true,force:true}); }
});

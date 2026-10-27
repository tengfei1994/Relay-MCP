import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve('scripts/knowledge-engine/7zip-install.mjs');
test('pinned tool installer rejects unsafe destinations and unverified archives before activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-7zip-'));
  try {
    const archive = join(root, 'bad.tar.xz'); writeFileSync(archive, 'untrusted archive');
    const run = (destination: string) => spawnSync(process.execPath, [installer, destination, '--archive', archive], { encoding: 'utf8' });
    const unsafe = run(parse(root).root); assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /dedicated|root/i);
    const destination = join(root, 'tool'); const bad = run(destination); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /checksum/i); assert.equal(existsSync(destination), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CHM resolution uses the managed release and refuses invalid managed state without PATH downgrade', async () => {
  const { resolveChmExtractor, chmExtractionArguments } = await import('../src/knowledge/chm-extractor.js');
  const root = mkdtempSync(join(tmpdir(), 'relay-chm-runtime-'));
  const config = join(root, 'engine.json');
  try {
    assert.equal(resolveChmExtractor({ env: {}, cwd: root, platform: 'linux' }), '7zz');
    assert.equal(resolveChmExtractor({ env: { RELAY_CHM_EXTRACTOR: '/explicit/7zz' }, cwd: root, platform: 'linux' }), '/explicit/7zz');
    writeFileSync(config, '{private-value-must-not-be-disclosed');
    assert.throws(() => resolveChmExtractor({ env: { KNOWLEDGE_ENGINE_HOME: root }, platform: 'linux' }), (error: Error) => /configuration/i.test(error.message) && !error.message.includes('private-value'));
    writeFileSync(config, JSON.stringify({ releasePath: join(root, '..', 'outside') }));
    assert.throws(() => resolveChmExtractor({ env: { KNOWLEDGE_ENGINE_HOME: root }, platform: 'linux' }), /outside|release/i);
    const release = join(root, 'releases', 'fixture'); mkdirSync(release, { recursive: true });
    writeFileSync(config, JSON.stringify({ releasePath: release }));
    assert.throws(() => resolveChmExtractor({ env: { KNOWLEDGE_ENGINE_HOME: root }, platform: 'linux' }), /missing|bundle|install/i);
    mkdirSync(join(release, 'tools', '7zip'), { recursive: true }); writeFileSync(join(release, 'tools', '7zip', '7zz'), 'tampered');
    assert.throws(() => resolveChmExtractor({ env: { KNOWLEDGE_ENGINE_HOME: root }, platform: 'linux' }), /checksum/i);
    assert.deepEqual(chmExtractionArguments('/managed/tools/7zip/7zz', '/output path', '/input.chm'), ['x', '-y', '-bd', '-bb0', '-o/output path', '/input.chm']);
    assert.deepEqual(chmExtractionArguments('hh.exe', 'C:\\out', 'C:\\input.chm'), ['-decompile', 'C:\\out', 'C:\\input.chm']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
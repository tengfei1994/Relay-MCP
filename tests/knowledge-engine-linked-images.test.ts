import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

test('managed upstream lock pins linked-image preservation beside the model privacy patch', () => {
 const base=resolve('scripts/knowledge-engine');
 const lock=JSON.parse(readFileSync(resolve(base,'upstream-lock.json'),'utf8'));
 assert.ok(lock.patches.some((p: {id:string})=>p.id==='0001-model-log-metadata-only'));
 const patch=lock.patches.find((p: {id:string})=>p.id==='0002-preserve-linked-image-hrefs');
 assert.ok(patch,'linked-image preservation patch must be locked');
 assert.equal(createHash('sha256').update(readFileSync(resolve(base,patch.file))).digest('hex'),patch.sha256);
 assert.deepEqual(patch.targets.map((t: {path:string})=>t.path),['internal/infrastructure/docparser/image_resolver.go']);
 const regression=lock.regressionTests.find((t: {target:string})=>t.target==='internal/infrastructure/docparser/relay_linked_image_preservation_test.go');
 assert.ok(regression);
 assert.equal(createHash('sha256').update(readFileSync(resolve(base,regression.file))).digest('hex'),regression.sha256);
 const build=readFileSync(resolve(base,'build.sh'),'utf8');
 assert.match(build,/go test -p 2 \.\/internal\/infrastructure\/docparser/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
// @ts-expect-error The runtime launcher is plain ESM.
import { managedEngineEnv } from '../scripts/knowledge-engine/runtime-env.mjs';

test('managed launcher disables document queue retries even when inherited settings disagree', () => {
 const env=managedEngineEnv({baseUrl:'http://127.0.0.1:18190',releasePath:'/release',systemAesKey:'key',jwtSecret:'jwt'},'/runtime',{RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY:'false'});
 assert.equal(env.RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY,'true');
 assert.equal(env.PROVIDER_MAX_RETRIES,undefined);
});

test('independent no-retry patch and executable queue proof are hash locked', () => {
 const base=resolve('scripts/knowledge-engine');const lock=JSON.parse(readFileSync(resolve(base,'upstream-lock.json'),'utf8'));
 const patch=lock.patches.find((x:{id:string})=>x.id==='0003-managed-document-no-auto-retry');
 assert.ok(patch,'managed document retry patch must be present');
 assert.deepEqual(patch.targets.map((x:{path:string})=>x.path),['internal/application/service/knowledge_task_options.go']);
 for(const asset of [patch,...lock.regressionTests.filter((x:{target:string})=>x.target.includes('relay_document_retry'))]) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(base,asset.file))).digest('hex'),asset.sha256);
 }
 assert.equal(lock.regressionTests.filter((x:{target:string})=>x.target.includes('relay_document_retry')).length,2);
 const build=readFileSync(resolve(base,'build.sh'),'utf8');assert.match(build,/RELAY_RETRY_OPTIONS_PROOF/);assert.match(build,/relay-document-retry-proof\.json/);
});

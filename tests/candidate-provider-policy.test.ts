import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKnowledgeStore } from '../src/knowledge/store.ts';
import { ProviderRegistry, type ProviderConfigInput } from '../src/knowledge/provider-registry.ts';
import { InMemorySecretResolver } from '../src/knowledge/provider-secret.ts';
import { candidateProviderAdapter } from '../src/knowledge/candidate-provider.ts';

type Call = { authorization: string | null; body: Record<string, unknown>; aborted: boolean; release: () => void };
function controlledTransport() {
  const calls: Call[] = [];
  let active = 0, maxActive = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const call: Call = { authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)), aborted: false, release };
    calls.push(call); active++; maxActive = Math.max(active, maxActive);
    let abort!: () => void;
    try {
      await Promise.race([gate, new Promise<never>((_resolve, reject) => {
        abort = () => { call.aborted = true; reject(init?.signal?.reason ?? new Error('aborted')); };
        if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true });
      })]);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } finally { active--; init?.signal?.removeEventListener('abort', abort); }
  };
  return { calls, fetchImpl, get active() { return active; }, get maxActive() { return maxActive; }, releaseAll() { for (const call of calls) call.release(); } };
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, label); await new Promise(resolve => setTimeout(resolve, 2)); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const messages = [{ role: 'user' as const, content: 'Unit policy boundary' }];
async function fixture(fn: (context: { store: ReturnType<typeof createKnowledgeStore>; registry: ProviderRegistry; secondRegistry: ProviderRegistry; secrets: InMemorySecretResolver; http: ReturnType<typeof controlledTransport>; configure: (patch?: Partial<ProviderConfigInput>) => void }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'relay-candidate-policy-'));
  const store = createKnowledgeStore({ dbPath: join(root, 'knowledge.db') });
  const secrets = new InMemorySecretResolver();
  secrets.set('vault://candidate-old', 'unit-old-candidate-token');
  const http = controlledTransport();
  const options = { secrets, fetchImpl: http.fetchImpl, policy: { retryBaseMs: 10 } };
  const registry = new ProviderRegistry(store, undefined, options), secondRegistry = new ProviderRegistry(store, undefined, options);
  const configure = (patch: Partial<ProviderConfigInput> = {}) => { registry.upsert({ id: 'candidate', kind: 'candidate_llm', provider: 'openai-compatible', baseUrl: 'https://unit.invalid/v1', modelId: 'unit-candidate-model', secretRef: 'vault://candidate-old', timeoutMs: 2000, concurrency: 1, maxRetries: 0, actorId: 7, ...patch }); };
  configure();
  try { await fn({ store, registry, secondRegistry, secrets, http, configure }); }
  finally { http.releaseAll(); await tick(); store.close(); rmSync(root, { recursive: true, force: true }); }
}

test('Candidate handles resolved by separate registries share the same-process concurrency limit', async () => fixture(async ({ registry, secondRegistry, http }) => {
  const first = registry.resolveCandidateProvider('candidate').complete(messages[0].content);
  await until(() => http.calls.length === 1, 'first call reaches transport');
  const second = secondRegistry.resolveCandidateProvider('candidate').complete(messages[0].content);
  try {
    await tick(); await tick();
    assert.equal(http.calls.length, 1, 'a new registry/handle must not bypass the running provider slot');
    http.calls[0].release(); await first;
    await until(() => http.calls.length === 2, 'queued call starts after release');
    http.calls[1].release(); await second;
    assert.equal(http.maxActive, 1);
  } finally { http.releaseAll(); await Promise.allSettled([first, second]); }
}));

test('Candidate quota survives repeated resolution and fresh registry instances', async () => fixture(async ({ registry, secondRegistry, http, configure }) => {
  configure({ quota: { maxCalls: 2, windowMs: 60000 } });
  for (const resolver of [registry, secondRegistry]) {
    const pending = resolver.resolveCandidateProvider('candidate').complete(messages[0].content);
    await until(() => http.active === 1, 'allowed call starts');
    http.calls.at(-1)!.release(); await pending;
  }
  const third = registry.resolveCandidateProvider('candidate').complete(messages[0].content);
  const rejection = assert.rejects(third, (error: any) => error.code === 'provider_quota_exceeded');
  // On the buggy implementation, release an unexpected transport call so the
  // assertion fails promptly rather than waiting for a network timeout.
  await tick(); await tick(); http.releaseAll();
  await rejection;
  assert.equal(http.calls.length, 2, 'quota denial happens before transport');
}));

test('A queued Candidate call reads the rotated credential when it gets its slot', async () => fixture(async ({ registry, secrets, http, store }) => {
  const handle = registry.resolveCandidateProvider('candidate');
  const first = handle.complete(messages[0].content);
  await until(() => http.calls.length === 1, 'first call starts');
  const queued = handle.complete(messages[0].content);
  try {
    await tick();
    secrets.set('vault://candidate-new', 'unit-new-candidate-token');
    registry.rotateSecret('candidate', 'vault://candidate-new', 7);
    http.calls[0].release(); await first;
    await until(() => http.calls.length === 2, 'rotated call starts');
    assert.equal(http.calls[1].authorization, 'Bearer unit-new-candidate-token');
    http.calls[1].release(); await queued;
    const audit = JSON.stringify(store.db.prepare('SELECT details_json FROM knowledge_audit').all());
    assert.doesNotMatch(audit, /unit-(old|new)-candidate-token|vault:\/\/candidate/);
  } finally { http.releaseAll(); await Promise.allSettled([first, queued]); }
}));

test('Disabling a provider prevents an already queued Candidate call from reaching transport', async () => fixture(async ({ registry, http }) => {
  const handle = registry.resolveCandidateProvider('candidate');
  const first = handle.complete(messages[0].content);
  await until(() => http.calls.length === 1, 'first call starts');
  const queued = handle.complete(messages[0].content);
  const rejection = assert.rejects(queued, /disabled/i);
  try {
    await tick(); registry.disable('candidate', 7);
    http.calls[0].release(); await first;
    await tick(); await tick(); http.releaseAll();
    await rejection;
    assert.equal(http.calls.length, 1, 'the queued request rechecks disable before dispatch');
  } finally { http.releaseAll(); await Promise.allSettled([first, queued, rejection]); }
}));


test('Candidate adapter forwards JSON output mode and its explicit token ceiling', async () => fixture(async ({ registry, http }) => {
  const provider = candidateProviderAdapter(registry.resolveCandidateProvider('candidate'), 'unit-candidate-model');
  const pending = provider.complete({ prompt: 'A bounded Candidate request', signal: new AbortController().signal, timeoutMs: 1000, maxTokens: 37 });
  await until(() => http.calls.length === 1, 'adapter calls transport');
  try {
    assert.equal(http.calls[0].body.max_tokens, 37);
    assert.deepEqual(http.calls[0].body.response_format, { type: 'json_object' });
    assert.deepEqual(http.calls[0].body.messages, [{ role: 'user', content: 'A bounded Candidate request' }]);
  } finally { http.calls[0].release(); await pending; }
  assert.equal(await pending, 'ok');
}));

test('Candidate caller cancellation aborts the in-flight transport and prevents retries', async () => fixture(async ({ registry, http, configure }) => {
  configure({ maxRetries: 3 });
  const provider = candidateProviderAdapter(registry.resolveCandidateProvider('candidate'), 'unit-candidate-model');
  const controller = new AbortController();
  const pending = provider.complete({ prompt: 'Cancel before response', signal: controller.signal, timeoutMs: 1000 });
  const rejection = assert.rejects(pending);
  await until(() => http.calls.length === 1, 'request reaches transport');
  controller.abort(new Error('caller cancelled'));
  await rejection; await tick();
  assert.equal(http.calls[0].aborted, true, 'the underlying fetch receives cancellation');
  assert.equal(http.active, 0, 'cancelled I/O is no longer consuming the slot');
  assert.equal(http.calls.length, 1, 'caller cancellation must not start a retry');
}));

test('Candidate adapter timeout bounds the entire request below the configured provider timeout', async () => fixture(async ({ registry, http, configure }) => {
  configure({ timeoutMs: 2000, maxRetries: 3 });
  const provider = candidateProviderAdapter(registry.resolveCandidateProvider('candidate'), 'unit-candidate-model');
  const pending = provider.complete({ prompt: 'Short compiler deadline', signal: new AbortController().signal, timeoutMs: 25 });
  await assert.rejects(pending);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].aborted, true);
  assert.equal(http.active, 0);
}));

test('Candidate timeout expires while queued and the removed request never sends later', async () => fixture(async ({ registry, secondRegistry, http }) => {
  const first = registry.resolveCandidateProvider('candidate').complete('Hold the only slot');
  await until(() => http.calls.length === 1, 'first request owns slot');
  const provider = candidateProviderAdapter(secondRegistry.resolveCandidateProvider('candidate'), 'unit-candidate-model');
  const queued = provider.complete({ prompt: 'Must expire before acquiring slot', signal: new AbortController().signal, timeoutMs: 25 });
  try {
    await assert.rejects(queued);
    assert.equal(http.calls.length, 1, 'deadline expiry does not need the active request to finish');
    assert.equal(http.active, 1);
    http.calls[0].release(); await first;
    const next = provider.complete({ prompt: 'Next request remains usable', signal: new AbortController().signal, timeoutMs: 1000 });
    await until(() => http.calls.length === 2, 'next live request gets the released slot');
    assert.equal(http.calls[1].body.max_tokens, 4096, 'adapter has the documented default output bound');
    assert.deepEqual(http.calls[1].body.messages, [{ role: 'user', content: 'Next request remains usable' }]);
    http.calls[1].release(); await next;
    assert.equal(http.calls.length, 2, 'expired queued work was removed permanently');
    assert.equal(http.maxActive, 1);
  } finally { http.releaseAll(); await Promise.allSettled([first, queued]); }
}));

test('A Candidate request cancelled before dispatch sends no HTTP and consumes no quota', async () => fixture(async ({ registry, http, configure }) => {
  configure({ quota: { maxCalls: 1, windowMs: 60000 } });
  const provider = candidateProviderAdapter(registry.resolveCandidateProvider('candidate'), 'unit-candidate-model');
  const controller = new AbortController(); controller.abort(new Error('cancelled before dispatch'));
  await assert.rejects(provider.complete({ prompt: 'Already cancelled', signal: controller.signal, timeoutMs: 1000 }));
  assert.equal(http.calls.length, 0);
  const permitted = provider.complete({ prompt: 'First real attempt', signal: new AbortController().signal, timeoutMs: 1000 });
  await until(() => http.calls.length === 1, 'remaining quota permits the first actual attempt');
  http.calls[0].release(); assert.equal(await permitted, 'ok');
}));

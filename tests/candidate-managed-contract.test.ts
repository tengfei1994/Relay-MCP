import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP and MCP Candidate adapters preserve typed JSON and real model provenance', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-contract-'));
  const env = { DB_PATH: join(root, 'app.db'), KNOWLEDGE_DB_PATH: join(root, 'knowledge.db'), KNOWLEDGE_EVIDENCE_ROOT: join(root, 'evidence'), PROVIDER_SECRET_KEY_FILE: join(root, 'provider.key') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const previousFetch = globalThis.fetch;
  const calls: any[] = []; let invalidTypes = false; let evidenceId = '';
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push(body);
    const output: any = { kind: 'fact', statement: 'The sentinel was observed.', whyProposed: 'The supplied evidence records the sentinel.', evidenceRefs: [evidenceId], intentRefs: [], unknowns: [], reuseBoundary: { scope: 'project' }, confidence: 0.8, confirmedFacts: [], observedBehavior: ['The isolated sentinel exists.'] };
    if (invalidTypes) Object.assign(output, { reuseBoundary: 'project', confidence: '0.8', observedBehavior: 'sentinel', hypothesis: null, reusableStatement: null });
    return Response.json({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  const { default: Fastify } = await import('fastify');
  const { db, runMigrations } = await import('../src/server/db/index.js');
  const { users, projects } = await import('../src/server/db/schema.js');
  const { knowledgeRoutes } = await import('../src/server/routes/knowledge.js');
  const { getKnowledgeStore } = await import('../src/server/knowledge-context.js');
  const { ProviderRegistry } = await import('../src/knowledge/provider-registry.js');
  const { WorkSessionService } = await import('../src/knowledge/work-session.js');
  const { EvidenceStore } = await import('../src/knowledge/evidence-store.js');
  const { registerKnowledgeTools } = await import('../src/mcp/tools/knowledge.js');
  const { startCandidateInsightDispatcher } = await import('../src/knowledge/candidate-dispatch.js');
  runMigrations();
  // Session-backed HTTP adapters verify the actual control-plane project owner.
  db.insert(users).values([{ id: 7, username: 'candidate-fixture', passwordHash: 'unused' }, { id: 8, username: 'other-actor', passwordHash: 'unused' }]).run();
  db.insert(projects).values({ id: 1, userId: 7, name: 'Candidate fixture', workspacePath: root }).run();
  const store = getKnowledgeStore(); store.grantAcl('1', 7, true);
  new ProviderRegistry(store).upsert({ id: 'candidate-fixture', kind: 'candidate_llm', provider: 'openai-compatible', baseUrl: 'https://gateway.test/v1', modelId: 'qwen-plus', actorId: 7 });
  evidenceId = new EvidenceStore(store, env.KNOWLEDGE_EVIDENCE_ROOT).put({ content: Buffer.from('Isolated sentinel.'), mimeType: 'text/plain', sourceKind: 'log', projectId: '1', locator: 'fixture://sentinel' }).id;
  const sessions = new WorkSessionService(store);
  const input = (key: string) => ({ sessionId: sessions.open({ actorId: 7, idempotencyKey: key, intent: { actorId: 7, actions: ['verify'], phase: 'validation', objective: 'Verify the sentinel', constraints: [], acceptanceCriteria: [], projectId: '1', environment: 'nonprod', risk: 'read_only', knowledgeMode: 'capture' } }).id, evidenceRefs: [evidenceId], providerId: 'candidate-fixture', context: {} });
  let httpActor = 7;
  const app = Fastify(); app.decorate('authenticate', async (req: any) => { req.user = { id: httpActor, isAdmin: true }; }); await app.register(knowledgeRoutes);
  const callbacks = new Map<string, (...args: any[]) => any>();
  registerKnowledgeTools({ server: { tool: (name: string, ...args: any[]) => callbacks.set(name, args.at(-1)), resource: () => undefined } as any, user: { id: 7, username: 'candidate-fixture' }, knowledge: store });
  try {
    await t.test('HTTP uses the configured model identity and JSON response mode', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/knowledge/candidate-insights/compile', payload: input('http') });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().insight.generatedBy, 'managed-candidate-llm:candidate-fixture/qwen-plus');
      assert.equal(response.json().insight.fallbackReason, undefined);
      assert.deepEqual(calls.at(-1).response_format, { type: 'json_object' });
      assert.equal(calls.at(-1).model, 'qwen-plus');
    });
    await t.test('MCP uses JSON response mode and the same configured identity', async () => {
      const response = await callbacks.get('knowledge_candidate_insight_compile')!(input('mcp'));
      const insight = JSON.parse(response.content[0].text).insight;
      assert.equal(insight.generatedBy, 'managed-candidate-llm:candidate-fixture/qwen-plus');
      assert.deepEqual(calls.at(-1).response_format, { type: 'json_object' });
    });
    await t.test('compiler prompt states the exact field types and omits unknown optional fields', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/knowledge/candidate-insights/compile', payload: input('typed-prompt') });
      assert.equal(response.statusCode, 201, response.body);
      const prompt = JSON.parse(calls.at(-1).messages.at(-1).content);
      assert.equal(prompt.outputSchema.type, 'object');
      assert.equal(prompt.outputSchema.additionalProperties, false);
      const properties = prompt.outputSchema.properties;
      assert.equal(properties.reuseBoundary.type, 'object');
      assert.equal(properties.confidence.type, 'number');
      assert.equal(properties.observedBehavior.type, 'array');
      assert.equal(properties.observedBehavior.items.type, 'string');
      assert.equal(properties.hypothesis.type, 'string');
      assert.equal(properties.reusableStatement.type, 'object');
      assert.ok(prompt.rules.some((rule: string) => /omit.*optional.*null/i.test(rule)));
    });
    await t.test('HTTP scope review requires the displayed Session revision and a project reviewer', async () => {
      const request = input('scope-review');
      const compiled = await app.inject({ method: 'POST', url: '/api/knowledge/candidate-insights/compile', payload: request });
      assert.equal(compiled.statusCode, 201, compiled.body);
      const id = compiled.json().insight.id;
      store.db.prepare('UPDATE knowledge_candidate_insights SET scope_snapshot_json=NULL WHERE id=?').run(id);
      const url = `/api/knowledge/candidate-insights/${id}/review-scope`;
      const revision = sessions.get({ actorId: 7, sessionId: request.sessionId })!.updatedAt;
      const post = (payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any });
      assert.equal((await post({ reason: 'Explicit review' })).statusCode, 400);
      assert.equal((await post({ reason: 'Explicit review', expectedSessionUpdatedAt: 'stale' })).statusCode, 403);
      httpActor = 8;
      assert.equal((await post({ reason: 'Explicit review', expectedSessionUpdatedAt: revision })).statusCode, 403);
      httpActor = 7;
      assert.equal((store.db.prepare('SELECT scope_snapshot_json FROM knowledge_candidate_insights WHERE id=?').get(id) as {scope_snapshot_json:string|null}).scope_snapshot_json, null);
      const restored = await post({ reason: 'Explicit review', expectedSessionUpdatedAt: revision });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(restored.json().insight.scopeReviewRequired, false);
      assert.equal(restored.json().insight.sourceScope.environment, 'nonprod');
      await app.inject({ method: 'POST', url: `/api/knowledge/candidate-insights/${id}/reject`, payload: { reason: 'Rejected evidence' } });
      assert.equal((await post({ reason: 'Cannot restore rejected', expectedSessionUpdatedAt: revision })).statusCode, 403);
    });
    await t.test('HTTP and MCP async queues are consumed by deployed dispatcher composition with one provider call per job', async () => {
      const requests = [input('http-async'),input('mcp-async')], before=calls.length;
      const first=await app.inject({method:'POST',url:'/api/knowledge/candidate-insights/compile',payload:{...requests[0],async:true}});
      assert.equal(first.statusCode,202,first.body);assert.equal(first.json().job.providerId,'candidate-fixture');
      const replay=await app.inject({method:'POST',url:'/api/knowledge/candidate-insights/compile',payload:{...requests[0],async:true}});
      assert.equal(replay.json().job.id,first.json().job.id);assert.equal(replay.json().enqueued,false);
      const second=JSON.parse((await callbacks.get('knowledge_candidate_insight_compile')!({...requests[1],async:true})).content[0].text);
      assert.equal(calls.length,before,'enqueue never waits for a model');
      httpActor=8;
      assert.equal((await app.inject({method:'GET',url:`/api/knowledge/candidate-insight-jobs/${first.json().job.id}`})).statusCode,404);
      httpActor=7;
      const web=startCandidateInsightDispatcher(()=>store,{intervalMs:25}),mcp=startCandidateInsightDispatcher(()=>store,{intervalMs:25});
      try {
        for(const id of [first.json().job.id,second.job.id]){
          let job:any;
          for(let attempt=0;attempt<100;attempt++){
            job=(await app.inject({method:'GET',url:`/api/knowledge/candidate-insight-jobs/${id}`})).json().job;
            if(job.status==='done'||job.status==='failed')break;
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(job.status,'done');assert.equal(job.attempts,1);
          const insight=(await app.inject({method:'GET',url:`/api/knowledge/candidate-insights/${job.insightId}`})).json().insight;
          assert.equal(insight.generatedBy,'managed-candidate-llm:candidate-fixture/qwen-plus');assert.equal(insight.status,'draft');assert.equal(insight.promotion,undefined);
          const polled=JSON.parse((await callbacks.get('knowledge_candidate_insight_job_get')!({id})).content[0].text).job;
          assert.equal(polled.insightId,insight.id);
        }
        assert.equal(calls.length-before,2);
      } finally {await web.stop();await mcp.stop();}
      const pending=await app.inject({method:'POST',url:'/api/knowledge/candidate-insights/compile',payload:{...input('after-shutdown'),async:true}});
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal((await app.inject({method:'GET',url:`/api/knowledge/candidate-insight-jobs/${pending.json().job.id}`})).json().job.status,'queued');
    });
    await t.test('valid JSON with the observed wrong field types still falls back without coercion', async () => {
      invalidTypes = true;
      const response = await app.inject({ method: 'POST', url: '/api/knowledge/candidate-insights/compile', payload: input('invalid-types') });
      assert.equal(response.statusCode, 201, response.body);
      const insight = response.json().insight;
      assert.equal(insight.generatedBy, 'deterministic-fallback-v1');
      assert.equal(insight.fallbackReason, 'invalid_output');
      assert.equal(insight.status, 'draft');
      assert.deepEqual(insight.evidenceRefs, [evidenceId]);
    });
  } finally {
    await app.close(); store.close(); (db as any).session.client.close(); globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

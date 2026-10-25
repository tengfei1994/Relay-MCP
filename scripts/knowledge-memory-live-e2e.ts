/** Bounded live nonproduction Memory acceptance. Saves metadata and hashes only. */
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = Record<string, any>;
class Failure extends Error { constructor(readonly code: string) { super(code); } }
const requireThat = (value: unknown, code: string) => { if (!value) throw new Failure(code); };
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const root = '/home/ftd/relay-knowledge-engine-nonprod';
const repository = root + '/relay';
const base = 'http://127.0.0.1:18300';
const runId = process.env.RELAY_MEMORY_E2E_RUN_ID ?? 'memory-live-20261025';
const reportPath = root + '/runtime/' + runId + '.json';
const providerId = 'qwen-candidate-nonprod';
const report: Row = { schemaVersion: 1, runId, status: 'running', startedAt: new Date().toISOString(), targetOrigin: base, projectId: '1', environment: 'nonprod', milestones: [], http: [], state: {} };
let token = '', foreignToken = '', safeToSave = false, evidenceId = '';
async function save() {
  if (!safeToSave) return;
  const temp = reportPath + `.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, reportPath); await chmod(reportPath, 0o600);
}
async function step(name: string, work: () => Promise<unknown>) {
  const entry: Row = { name, status: 'running' }; report.milestones.push(entry); await save();
  console.log(`[memory-e2e] ${name}: running`); const started = performance.now();
  try { entry.evidence = await work(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; entry.code = error instanceof Failure ? error.code : 'driver_error'; throw error; }
  finally { entry.durationMs = Math.round(performance.now() - started); await save(); console.log(`[memory-e2e] ${name}: ${entry.status}`); }
}
async function request(operation: string, method: string, path: string, body?: Row, expected = [200], foreign = false): Promise<Row> {
  const event: Row = { operation, method, path }; report.http.push(event); const started = performance.now();
  try {
    const response = await fetch(new URL(path, base), { method, redirect: 'error', signal: AbortSignal.timeout(150_000), headers: { authorization: `Bearer ${foreign ? foreignToken : token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    event.status = response.status;
    const bytes = new Uint8Array(await response.arrayBuffer()); event.responseBytes = bytes.length;
    requireThat(bytes.length <= 4_194_304, 'response_exceeds_bound');
    requireThat(expected.includes(response.status), `http_${response.status}_${operation}`);
    if (response.status >= 400) return {};
    return row(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (error) { if (error instanceof Failure) throw error; throw new Failure('transport_or_json_' + operation); }
  finally { event.latencyMs = Math.round(performance.now() - started); }
}
const endpoint = (id: string) => '/api/knowledge/candidate-insights/' + encodeURIComponent(id);
function insightProof(value: Row): Row {
  return { id: value.id, workSessionId: value.workSessionId, projectId: value.projectId, kind: value.kind, status: value.status, generatedBy: value.generatedBy, fallbackReason: value.fallbackReason, inputHash: value.inputHash, persisted: value.persisted, evidenceRefs: value.evidenceRefs, intentRefs: value.intentRefs, statementSha256: sha(String(value.statement ?? '')), contentSha256: sha(JSON.stringify({ statement: value.statement, whyProposed: value.whyProposed, confirmedFacts: value.confirmedFacts, observedBehavior: value.observedBehavior, reusableStatement: value.reusableStatement })) };
}
function assertManaged(value: Row, sessionId: string) {
  requireThat(value.persisted === true && value.projectId === '1' && value.workSessionId === sessionId && value.status === 'draft', 'candidate_scope_or_state');
  requireThat(value.reuseBoundary?.projectId === '1' && value.reuseBoundary?.environment === 'nonprod', 'candidate_session_scope_missing');
  requireThat(value.generatedBy === `managed-candidate-llm:${providerId}/qwen-plus` && !value.fallbackReason, 'candidate_not_real_managed_output');
  requireThat(Array.isArray(value.evidenceRefs) && value.evidenceRefs.includes(evidenceId) && value.evidenceRefs.every((id: string) => id === evidenceId), 'candidate_evidence_mismatch');
  requireThat(/^[a-f0-9]{64}$/.test(value.inputHash) && typeof value.statement === 'string' && value.statement.length > 0, 'candidate_hash_or_content_missing');
}
async function openSession(label: string) {
  const result = await request('session_open_' + label, 'POST', '/api/knowledge/sessions', { idempotencyKey: `${runId}:${label}`, intent: { actions: ['verify', 'capture'], phase: 'validation', objective: 'Verify the isolated Relay Memory and Evidence workflow using the recorded runtime isolation sentinel.', desiredOutcome: 'An evidence-linked observation suitable for explicit nonproduction review.', constraints: ['Only the isolated nonproduction project and its evidence sentinel are in scope.', 'Do not infer customer outcomes or production behavior from this sentinel.'], acceptanceCriteria: ['The insight cites the sentinel evidence and identifies its limited applicability.'], projectId: '1', environment: 'nonprod', risk: 'read_only', knowledgeMode: 'capture' } }, [201]);
  const session = row(result.session); requireThat(session.id && session.projectId === '1' && session.environment === 'nonprod' && session.status === 'open', 'session_scope_or_state');
  return session;
}
async function closeSession(sessionId: string) {
  const result = await request('session_close', 'POST', `/api/knowledge/sessions/${encodeURIComponent(sessionId)}/close`, { idempotencyKey: `${runId}:close:${sessionId}`, result: { summary: 'Bounded nonproduction HTTP acceptance completed; source evidence remains unchanged.', acceptanceResults: { managedCandidateCompiled: true, evidenceLinked: true } } });
  const session = row(result.session); requireThat(session.status === 'completed' && session.closedAt, 'session_not_closed');
  return { id: session.id, status: session.status, closedAt: session.closedAt };
}
async function main() {
  requireThat(process.env.RELAY_E2E_ISOLATED === '1' && process.platform === 'linux', 'isolated_linux_required');
  requireThat(await realpath(dirname(dirname(fileURLToPath(import.meta.url)))) === repository && await realpath(process.cwd()) === repository, 'exact_nonproduction_checkout_required');
  requireThat(/^[a-zA-Z0-9._-]{1,100}$/.test(runId), 'invalid_run_id');
  for (const path of [repository + '/data/e2e-admin.jwt', repository + '/data/e2e-foreign.jwt']) requireThat((await realpath(path)).startsWith(repository + sep + 'data' + sep), 'token_path_outside_nonproduction');
  token = (await readFile(repository + '/data/e2e-admin.jwt', 'utf8')).trim(); foreignToken = (await readFile(repository + '/data/e2e-foreign.jwt', 'utf8')).trim();
  requireThat(token && foreignToken && !/\s/.test(token + foreignToken), 'invalid_token_file');
  const manifestBytes = await readFile(repository + '/data/nonprod-seed-manifest.json'); const manifest = JSON.parse(manifestBytes.toString('utf8'));
  requireThat(manifest.isolationRoot === root && manifest.environment === 'nonprod' && manifest.adminProjectId === 1 && manifest.foreignProjectId === 2, 'fixture_scope_mismatch');
  evidenceId = manifest.evidence.id; report.fixtureManifestSha256 = sha(manifestBytes); safeToSave = true;
  await step('health_provider_and_evidence', async () => {
    await request('health', 'GET', '/api/health');
    const providers = list((await request('managed_providers', 'GET', '/api/knowledge/providers/managed')).providers);
    const provider = providers.find(p => p.id === providerId); requireThat(provider?.kind === 'candidate_llm' && provider.modelId === 'qwen-plus' && provider.status !== 'disabled', 'candidate_provider_missing');
    const evidence = row((await request('evidence_metadata', 'GET', '/api/knowledge/evidence/' + encodeURIComponent(evidenceId))).evidence);
    requireThat(evidence.projectId === '1' && evidence.sha256 === manifest.evidence.sha256 && evidence.sizeBytes === manifest.evidence.sizeBytes, 'evidence_baseline_mismatch');
    report.state.evidence = { id: evidence.id, sha256: evidence.sha256, sizeBytes: evidence.sizeBytes };
    return { providerId, modelId: provider.modelId, kind: provider.kind, evidence: report.state.evidence };
  });
  let session: Row = {}, insight: Row = {};
  await step('session_open_compile_and_idempotency', async () => {
    session = await openSession('reviewed'); report.state.reviewedSessionId = session.id; await save();
    const body = { sessionId: session.id, evidenceRefs: [evidenceId], providerId, context: { acceptanceRunId: runId, purpose: 'Capture only the observed nonproduction runtime isolation sentinel behavior.' } };
    insight = row((await request('compile', 'POST', '/api/knowledge/candidate-insights/compile', body, [200, 201])).insight);
    report.state.reviewedInsight = insightProof(insight); await save(); assertManaged(insight, session.id);
    const replay = row((await request('compile_replay', 'POST', '/api/knowledge/candidate-insights/compile', body, [200, 201])).insight);
    requireThat(replay.id === insight.id && replay.inputHash === insight.inputHash && JSON.stringify(insightProof(replay)) === JSON.stringify(insightProof(insight)), 'compile_replay_changed_result');
    const items = list((await request('insight_count', 'GET', '/api/knowledge/candidate-insights?projectId=1&limit=200')).insights);
    requireThat(items.filter(i => i.workSessionId === session.id).length === 1, 'compile_replay_created_duplicate');
    return { insight: insightProof(insight), idempotencyStable: true, sessionInsightCount: 1 };
  });
  await step('foreign_actor_denied', async () => {
    await request('foreign_session', 'GET', `/api/knowledge/sessions/${encodeURIComponent(session.id)}`, undefined, [403, 404], true);
    await request('foreign_insight', 'GET', endpoint(insight.id), undefined, [403, 404], true);
    await request('foreign_confirm', 'POST', endpoint(insight.id) + '/confirm', { reason: 'Nonproduction ACL acceptance denial.' }, [403, 404], true);
    return { checks: 3, allDenied: true };
  });
  await step('explicit_review_promotion_and_close', async () => {
    const confirmed = row((await request('confirm', 'POST', endpoint(insight.id) + '/confirm', { reason: 'Explicitly authorized nonproduction acceptance review of the sentinel-derived observation.' })).insight);
    requireThat(confirmed.status === 'accepted' && confirmed.reviewedBy === 1, 'review_not_confirmed');
    const promotion = row((await request('promote', 'POST', endpoint(insight.id) + '/promote', { target: 'case', reason: 'Persist the verified isolated acceptance observation as a nonproduction draft case.', title: 'Nonproduction managed Candidate acceptance' })).promotion);
    requireThat(promotion.target === 'case' && promotion.mode === 'persisted' && promotion.targetId, 'case_promotion_not_persisted');
    const record = await request('promoted_case', 'GET', '/api/knowledge/documents/' + encodeURIComponent(promotion.targetId) + '?projectId=1'); const document = row(record.document);
    requireThat(document.kind === 'case' && document.projectId === '1' && document.environment === 'nonprod' && document.lifecycle === 'draft' && typeof document.body === 'string' && document.body.length > 0, 'promoted_case_scope_or_state');
    const refs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs : document.evidenceRefs;
    requireThat(Array.isArray(refs) && refs.includes(evidenceId), 'promoted_case_missing_evidence');
    const history = list((await request('review_history', 'GET', endpoint(insight.id) + '/history')).history);
    requireThat(history.some(h => h.action === 'confirm') && history.some(h => h.action === 'promote'), 'review_history_missing');
    const closed = await closeSession(session.id);
    report.state.promotedCase = { id: document.id, kind: document.kind, lifecycle: document.lifecycle, projectId: document.projectId, environment: document.environment, bodySha256: sha(document.body), evidenceRefs: refs };
    return { insightId: insight.id, status: confirmed.status, case: report.state.promotedCase, reviewActions: history.map(h => h.action), session: closed };
  });
  await step('leave_real_candidate_for_browser_review', async () => {
    const pendingSession = await openSession('browser-review'); report.state.pendingSessionId = pendingSession.id; await save();
    const pending = row((await request('compile_pending', 'POST', '/api/knowledge/candidate-insights/compile', { sessionId: pendingSession.id, evidenceRefs: [evidenceId], providerId, context: { acceptanceRunId: runId, purpose: 'Prepare the sentinel-based nonproduction observation for a separate browser review without confirming it.' } }, [200, 201])).insight);
    report.state.pendingInsight = insightProof(pending); await save(); assertManaged(pending, pendingSession.id);
    const closed = await closeSession(pendingSession.id);
    return { insight: insightProof(pending), leftForReview: true, session: closed };
  });
  await step('evidence_and_original_memory_preserved', async () => {
    const evidence = row((await request('evidence_after', 'GET', '/api/knowledge/evidence/' + encodeURIComponent(evidenceId))).evidence);
    const memory = row((await request('original_memory_after', 'GET', '/api/knowledge/documents/' + encodeURIComponent(manifest.memory.id) + '?projectId=1')).document);
    requireThat(evidence.sha256 === manifest.evidence.sha256 && evidence.sizeBytes === manifest.evidence.sizeBytes && sha(String(memory.body)) === manifest.memory.bodySha256, 'original_memory_or_evidence_changed');
    return { evidenceId, evidenceSha256: evidence.sha256, memoryId: memory.id, memoryBodySha256: sha(String(memory.body)) };
  });
  report.status = 'passed_live_http'; report.finishedAt = new Date().toISOString(); await save(); console.log('[memory-e2e] passed_live_http');
}
try { await main(); }
catch (error) { report.status = 'failed'; report.failureCode = error instanceof Failure ? error.code : 'driver_error'; report.finishedAt = new Date().toISOString(); await save(); console.error(`[memory-e2e] failed: ${report.failureCode}; state preserved`); process.exitCode = 1; }
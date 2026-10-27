import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore } from "../src/knowledge/store.ts";
import { WeKnoraIngestor, WeKnoraIngestError, normalizeProductContent, type WeKnoraDocumentInput, type WeKnoraDocumentWriter } from "../src/knowledge/weknora-ingest.ts";
import { WeKnoraError } from "../src/knowledge/weknora.ts";
import { MigrationController } from "../src/knowledge/migration-control.ts";

function withStore(fn: (store: ReturnType<typeof createKnowledgeStore>) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "relay-ingest-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  return Promise.resolve(fn(store)).finally(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
}

const baseInput: WeKnoraDocumentInput = {
  idempotencyKey: "import-1",
  title: "Guide",
  content: "<html><body><h1>Guide</h1><script>bad</script><p>Hello</p></body></html>",
  productVersion: "21.3",
  solution: "Core",
  module: "Forms",
  topicId: "topic-1",
  sourcePath: "docs/guide.html",
  parserVersion: "parser-2",
  rawSha256: "raw-1",
  projectId: "p1",
};

function countingWriter(result?: { externalDocumentId: string; externalChunkIds?: string[]; knowledgeBaseId?: string }) {
  const state = { calls: 0, lastContent: "", lastInput: undefined as unknown };
  const writer: WeKnoraDocumentWriter = {
    async upsertDocument(input) {
      state.calls += 1;
      state.lastContent = input.normalizedContent;
      state.lastInput = input;
      return { parseStatus: "completed", externalChunkIds: ["chunk-1"], ...(result ?? { externalDocumentId: `ext-${state.calls}`, knowledgeBaseId: input.modelProvenance?.knowledgeBaseId ?? "kb-1" }) };
    },
  };
  return { writer, state };
}

test("normalized Product Knowledge import is idempotent and preserves LIMS metadata", async () => withStore(async (store) => {
  const { writer, state } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer);
  const first = await ingestor.stage(baseInput);
  const second = await ingestor.stage(baseInput);
  assert.equal(first.id, second.id);
  assert.equal(state.calls, 1);
  assert.equal(first.status, "staged");
  assert.equal(first.normalizedContentSha256, second.normalizedContentSha256);
  assert.ok(first.identityHash);
  const row = store.db.prepare("SELECT product_version,solution,module,source_path,status FROM knowledge_weknora_documents WHERE id=?").get(first.id) as Record<string, unknown>;
  assert.deepEqual(row, { product_version: "21.3", solution: "Core", module: "Forms", source_path: "docs/guide.html", status: "staged" });
  await ingestor.publish(first.id, 7);
  assert.equal(ingestor.get(first.id)?.status, "published");
}));

test("identity dedupe never merges across topic or source boundaries", async () => withStore(async (store) => {
  const { writer, state } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer);
  const first = await ingestor.stage(baseInput);
  // Same content and version, but a different topic: must not merge.
  const otherTopic = await ingestor.stage({ ...baseInput, idempotencyKey: "import-2", topicId: "topic-2" });
  assert.notEqual(otherTopic.id, first.id);
  // Same content under a different source path: must not merge either.
  const otherSource = await ingestor.stage({ ...baseInput, idempotencyKey: "import-3", sourcePath: "docs/other.html" });
  assert.notEqual(otherSource.id, first.id);
  // Fully identical logical scope with a new idempotency key dedupes without a writer call.
  const deduped = await ingestor.stage({ ...baseInput, idempotencyKey: "import-4" });
  assert.equal(deduped.id, first.id);
  assert.equal(state.calls, 3);
}));

test("upstream dedupe cannot merge an external document across Relay scopes", async () => withStore(async (store) => {
  const { writer, state } = countingWriter({ externalDocumentId: "ext-shared", knowledgeBaseId: "kb-1" });
  const ingestor = new WeKnoraIngestor(store, writer);
  const first = await ingestor.stage(baseInput);
  await assert.rejects(ingestor.stage({ ...baseInput, idempotencyKey: "import-5", topicId: "topic-9" }), /scope|identity/i);
  assert.equal(state.calls, 2);
  assert.equal(ingestor.get(first.id)?.topicId, "topic-1");
}));

test("writer failure stages a failed row with a sanitized category and explicit retry recovers without duplicating the external document", async () => withStore(async (store) => {
  let calls = 0;
  const writer: WeKnoraDocumentWriter = {
    async upsertDocument() {
      calls += 1;
      if (calls === 1) throw new WeKnoraError("rate_limited", "WeKnora rate limit exceeded", 429, 3);
      return { externalDocumentId: "ext-retry", knowledgeBaseId: "kb-1", parseStatus: "completed", externalChunkIds: ["retry-chunk"] };
    },
  };
  const ingestor = new WeKnoraIngestor(store, writer);
  await assert.rejects(() => ingestor.stage(baseInput), (error: unknown) => error instanceof WeKnoraIngestError && error.code === "rate_limited");

  const failed = store.db.prepare("SELECT * FROM knowledge_weknora_documents WHERE idempotency_key=?").get("import-1") as Record<string, unknown>;
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure_code, "rate_limited");
  assert.equal(failed.attempt_count, 1);
  assert.ok(String(failed.external_document_id).startsWith("pending:"));

  // A plain repeat call returns the failed record without hitting the writer.
  const repeated = await ingestor.stage(baseInput);
  assert.equal(repeated.status, "failed");
  assert.equal(calls, 1);

  // Explicit retry reuses the same control-plane row and external identity.
  const recovered = await ingestor.stage(baseInput, { retry: true });
  assert.equal(recovered.id, String(failed.id));
  assert.equal(recovered.status, "staged");
  assert.equal(recovered.externalDocumentId, "ext-retry");
  assert.equal(recovered.attemptCount, 2);
  assert.equal(recovered.failureCode, undefined);
  assert.equal(calls, 2);
}));

test("batch import reports per-file outcomes and continues after failures", async () => withStore(async (store) => {
  const writer: WeKnoraDocumentWriter = {
    async upsertDocument(input) {
      if (input.idempotencyKey === "bad-1") throw new Error("upstream 500 with token sk-batch-secret-123");
      return { externalDocumentId: `ext-${input.idempotencyKey}`, parseStatus: "completed", externalChunkIds: ["batch-chunk"] };
    },
  };
  const ingestor = new WeKnoraIngestor(store, writer);
  const report = await ingestor.stageBatch([
    { ...baseInput, idempotencyKey: "ok-1" },
    { ...baseInput, idempotencyKey: "bad-1", topicId: "topic-bad" },
    { ...baseInput, idempotencyKey: "ok-2", topicId: "topic-2" },
  ]);
  assert.equal(report.total, 3);
  assert.equal(report.staged, 2);
  assert.equal(report.failed, 1);
  const failedItem = report.items.find((item) => item.idempotencyKey === "bad-1");
  assert.equal(failedItem?.failureCode, "writer_error");
  assert.doesNotMatch(failedItem?.error ?? "", /sk-batch-secret-123/);
  const failedRow = store.db.prepare("SELECT status,failure_code,failure_message FROM knowledge_weknora_documents WHERE idempotency_key='bad-1'").get() as Record<string, unknown>;
  assert.equal(failedRow.status, "failed");
  assert.doesNotMatch(String(failedRow.failure_message), /sk-batch-secret-123/);
}));

test("only published documents are visible to retrieval scoping", async () => withStore(async (store) => {
  const { writer } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer);
  const staged = await ingestor.stage(baseInput);
  assert.equal(ingestor.isRetrievalVisible(staged), false);
  assert.equal(ingestor.listRetrievalVisible({ productVersion: "21.3" }).length, 0);
  assert.equal(ingestor.retrievalKnowledgeIds().length, 0);

  ingestor.publish(staged.id, 7);
  const visible = ingestor.listRetrievalVisible({ productVersion: "21.3", module: "Forms" });
  assert.equal(visible.length, 1);
  assert.deepEqual(ingestor.retrievalKnowledgeIds({ productVersion: "21.3" }), ["ext-1"]);
  assert.equal(ingestor.listRetrievalVisible({ productVersion: "21.1" }).length, 0, "documents bound to another product version stay out of scope");
  assert.equal(ingestor.listRetrievalVisible({ productVersion: "21.3", module: "Other" }).length, 0);

  ingestor.deprecate(staged.id, 7);
  assert.equal(ingestor.listRetrievalVisible().length, 0);
}));

test("structured Markdown normalization preserves headings, anchors, lists, tables, code, images and links", async () => withStore(async (store) => {
  const { writer, state } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer);
  const html = `<html><body>
    <h2 id="config">Configuration</h2>
    <p>Intro with <a href="other.html">a link</a> and <img src="img.png" alt="diagram">.</p>
    <ul><li>first</li><li>second</li></ul>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>
    <pre><code class="language-js">const x = 1;</code></pre>
  </body></html>`;
  await ingestor.stage({ ...baseInput, idempotencyKey: "md-1", content: html });
  const md = state.lastContent;
  assert.match(md, /<a id="config"><\/a>\n## Configuration/);
  assert.match(md, /- first\n- second/);
  assert.match(md, /\| Name \| Value \|\n\| --- \| --- \|\n\| a \| 1 \|/);
  assert.match(md, /```js\nconst x = 1;\n```/);
  assert.match(md, /\[a link\]\(other\.html\)/);
  assert.match(md, /!\[diagram\]\(img\.png\)/);
  assert.doesNotMatch(md, /<script|<table|<ul>/);
}));

test("normalizeProductContent keeps plain text input stable", () => {
  const markdown = normalizeProductContent("# Already markdown\n\n- item\n");
  assert.match(markdown, /# Already markdown/);
  assert.match(markdown, /- item/);
});

test("migration controller records staged publish and auditable rollback without deleting source", async () => withStore(async (store) => {
  const controller = new MigrationController(store, () => new Date("2026-10-23T00:00:00.000Z"));
  const created = controller.create({ actorId: 7, idempotencyKey: "m-1", kind: "audit_only", sourceManifest: { documents: 1, sourceHash: "sha" } });
  assert.equal(controller.create({ actorId: 7, idempotencyKey: "m-1", kind: "audit_only", sourceManifest: { documents: 99 } }).id, created.id);
  controller.markStaged(created.id, { imported: 1, skipped: 0, failed: 0 }, 7);
  controller.publish(created.id, 7);
  const rolled = controller.rollback(created.id, 7, "verification failed");
  assert.equal(rolled.status, "rolled_back");
  assert.equal(rolled.rollbackReason, "verification failed");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit WHERE entity_id=?").get(created.id) as { count: number }).count, 4);
}));

test("environment and embedding index generation form part of document identity", async () => withStore(async (store) => {
  const { writer } = countingWriter();
  const ingestor = new WeKnoraIngestor(store, writer);
  const provenance = { knowledgeBaseId: "kb-1", providerId: "provider", modelId: "embedding", dimensions: 32, indexVersion: 1 };
  const testDoc = await ingestor.stage({ ...baseInput, environment: "test", modelProvenance: provenance });
  const prodDoc = await ingestor.stage({ ...baseInput, idempotencyKey: "prod", environment: "prod", modelProvenance: provenance });
  const nextIndex = await ingestor.stage({ ...baseInput, idempotencyKey: "index-2", environment: "test", modelProvenance: { ...provenance, knowledgeBaseId: "kb-2", indexVersion: 2 } });
  assert.notEqual(testDoc.id, prodDoc.id);
  assert.notEqual(testDoc.id, nextIndex.id);
  assert.deepEqual(testDoc.modelProvenance, provenance);
  assert.equal(testDoc.upstreamParseStatus, "completed");
  assert.ok(testDoc.upstreamVerifiedAt);
  assert.deepEqual(testDoc.externalChunkIds, ["chunk-1"]);
  ingestor.publish(testDoc.id, 7); ingestor.publish(prodDoc.id, 7);
  assert.deepEqual(ingestor.listRetrievalVisible({ projectId:"p1", environment: "test" }).map((d) => d.id), [testDoc.id]);
  await assert.rejects(ingestor.stage({ ...baseInput, environment: "prod", modelProvenance: provenance }), /idempotency|identity/i);
}));


test("ContextPack source IDs include only explicit global or exact project/environment publications", async () => withStore(async store => {
  const {writer}=countingWriter(); const ingestor=new WeKnoraIngestor(store,writer);
  for (const [key,projectId,environment] of [["global",undefined,undefined],["mine","p1","dev"],["foreign","p2","dev"],["production","p1","prod"],["ambiguous",undefined,"dev"]]) {
    const doc=await ingestor.stage({...baseInput,idempotencyKey:key!,projectId,environment,sourcePath:key}); ingestor.publish(doc.id,7);
  }
  assert.deepEqual(ingestor.listRetrievalVisible({projectId:"p1",environment:"dev"}).map(d=>d.sourcePath).sort(),["global","mine"]);
}));

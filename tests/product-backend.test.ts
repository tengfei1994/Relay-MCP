import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { MigrationController } from "../src/knowledge/migration-control.ts";
import { searchProductBackend, getProductBackend, diffProductBackend, listEngineProductBackend, type ProductBackendControlPlane } from "../src/knowledge/product-backend.ts";
import {updateProductDocumentLifecycle,correctProductMetadata} from "../src/knowledge/knowledge-products.ts";
import { WeKnoraClient } from "../src/knowledge/weknora.ts";
import type { KnowledgeReference, WeKnoraDocumentRead, WeKnoraSearchInput } from "../src/knowledge/weknora.ts";

const NOW = "2026-10-25T00:00:00.000Z";
const KB = "kb-current";
function local(store: KnowledgeStore, id: string, project?: string, environment?: string) {
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,environment,samplemanager_version,source_locator,source_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "product_document", "Local pump manual", "Obsolete local pump body", "approved", project ?? null, environment ?? null, "21.3", "old/" + id, "old-sha", NOW, NOW);
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "pump-family", "guide", "en", "old/" + id, "old-sha", "21.3", NOW, NOW);
}
function mapped(store: KnowledgeStore, id: string, values: { project?: string; environment?: string; status?: string; kb?: string; verified?: boolean; version?: string } = {}) {
  store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,raw_sha256,parser_version,product_version,source_path,project_id,environment,language,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "ext-" + id, values.kb ?? KB, JSON.stringify(["chunk-" + id]), "Verified pump manual", createHash("sha256").update("Actual engine body").digest("hex"), "a".repeat(64), "v2", values.version ?? "21.3", "manual/" + id + ".html#setup", values.project ?? "p1", values.environment ?? "dev", "en", values.status ?? "published", id, NOW, NOW, values.verified === false ? null : NOW, "completed");
}
function reference(id: string, override: Partial<KnowledgeReference> = {}): KnowledgeReference {
  return { provider: "weknora", documentId: "ext-" + id, chunkId: "chunk-" + id, title: "Untrusted upstream title", version: "wrong", sourceLocator: "wrong/private/path", snippet: "Actual engine pump excerpt", score: 0.9, retrievalRunId: "run-1", ...override };
}
async function fixture(fn: (f: {
  store: KnowledgeStore; control: ProductBackendControlPlane; refs: KnowledgeReference[]; reads: string[]; searches: WeKnoraSearchInput[];
  select: () => string; fail: () => void; readResult: (value: WeKnoraDocumentRead) => void;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "relay-product-backend-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  store.grantAcl("p1", 7, true); store.grantAcl("p2", 10, true);
  const controller = new MigrationController(store);
  const refs: KnowledgeReference[] = [], reads: string[] = [], searches: WeKnoraSearchInput[] = [];
  let failing = false, override: WeKnoraDocumentRead | undefined;
  const control: ProductBackendControlPlane = { knowledgeBaseId: KB, client: {
    search: async input => { searches.push(input); if (failing) throw new Error("password: upstream-secret"); return { references: refs, retrievalRunId: "run-1" }; },
    readDocument: async id => { reads.push(id); if (failing) throw new Error("password: upstream-secret"); return override ?? { documentId: id, parseStatus: "completed", title: "Upstream title", content: "Actual engine body", chunks: [{ documentId: id, chunkId: "chunk-" + id.slice(4), content: "Actual engine body", seq: 0, isEnabled: true }] }; },
  } };
  const select = () => {
    const m = controller.create({ actorId: 7, idempotencyKey: "select", sourceManifest: {} });
    store.db.prepare("UPDATE knowledge_migrations SET status='published',published_at=? WHERE id=?").run(NOW, m.id);
    store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,migration_id,updated_by,updated_at) VALUES ('product_provider','weknora',?,?,?)").run(m.id, 7, NOW); return m.id;
  };
  try { await fn({ store, control, refs, reads, searches, select, fail: () => { failing = true; }, readResult: value => { override = value; } }); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
const scope = { userId: 7, projectId: "p1", environment: "dev" };

test("summary source locators survive Product DTO and citation hydration", () => fixture(async ({ store, control, refs, select }) => {
  mapped(store, "good"); select();
  store.db.prepare("UPDATE knowledge_weknora_documents SET source_path='manual.pdf' WHERE id='good'").run();
  refs.push(reference("good", { sourceLocator: "untrusted-path#page=42", sourceLocators: [{ type: "pdf", page: 42 }], matchReason: "summary_match_source_chunk" }));
  const [row] = await searchProductBackend(store, { ...scope, query: "pump" }, control);
  assert.equal(row.sourceLocator, "manual.pdf#page=42");
  assert.equal(row.citation, row.sourceLocator);
  assert.equal((row.citations as any[])[0].sourceLocator, row.sourceLocator);
  assert.deepEqual(row.sourceLocators, [{ type: "pdf", page: 42 }]);
}));

test("local product backend preserves legacy reads but filters foreign project and environment", () => fixture(async ({ store, control }) => {
  local(store, "public");
  local(store, "mine", "p1", "dev");
  local(store, "foreign", "p2", "dev");
  local(store, "production", "p1", "prod");
  const rows = await searchProductBackend(store, scope, control);
  assert.deepEqual(rows.map(row => row.id).sort(), ["mine", "public"]);
  assert.equal((await getProductBackend(store, { ...scope, documentId: "mine" }, control)).body, "Obsolete local pump body");
  await assert.rejects(getProductBackend(store, { ...scope, documentId: "foreign" }, control), /denied|not found/i);
  await assert.rejects(getProductBackend(store, { ...scope, documentId: "production" }, control), /denied|not found/i);
}));

test("engine search prefilters exact project/environment/version/current KB and verified publication", () => fixture(async ({ store, control, refs, searches, select }) => {
  mapped(store, "good");
  mapped(store, "foreign", { project: "p2" });
  mapped(store, "prod", { environment: "prod" });
  mapped(store, "staged", { status: "staged" });
  mapped(store, "deprecated", { status: "deprecated" });
  mapped(store, "unverified", { verified: false });
  mapped(store, "old-kb", { kb: "previous-kb" });
  mapped(store, "old-version", { version: "21.1" });
  select(); refs.push(reference("good"));
  const rows = await searchProductBackend(store, { ...scope, query: "pump", sampleManagerVersion: "21.3" }, control);
  assert.deepEqual(searches[0].knowledgeIds, ["ext-good"]);
  assert.equal(searches[0].documentMetadata!["ext-good"].version, "21.3");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Verified pump manual");
  assert.equal(rows[0].sourcePath, "manual/good.html#setup");
  assert.equal(rows[0].sourceSha256, "a".repeat(64));
  assert.equal(rows[0].sampleManagerVersion, "21.3");
  assert.equal(rows[0].provider, "weknora");
  assert.equal(rows[0].snippet, "Actual engine pump excerpt");
  assert.ok(!JSON.stringify(rows).includes(KB));
}));

test("empty engine scope does not perform an unbounded upstream query", () => fixture(async ({ store, control, searches, select }) => {
  mapped(store, "foreign", { project: "p2" }); select();
  assert.deepEqual(await searchProductBackend(store, { ...scope, query: "pump" }, control), []);
  assert.equal(searches.length, 0);
  await assert.rejects(searchProductBackend(store, { ...scope, userId: 10, query: "pump" }, control), /denied/i);
  assert.equal(searches.length, 0);
}));

test("engine search rejects forged document and chunk references even if upstream returns them", () => fixture(async ({ store, control, refs, select }) => {
  mapped(store, "good"); select();
  refs.push(reference("unknown"));
  await assert.rejects(searchProductBackend(store, { ...scope, query: "pump" }, control), /reference|scope/i);
  refs.splice(0, 1, reference("good", { chunkId: "foreign-chunk" }));
  await assert.rejects(searchProductBackend(store, { ...scope, query: "pump" }, control), /chunk|reference/i);
}));

test("legacy product ID resolves through a published migration and reads only actual engine body", () => fixture(async ({ store, control, reads, select }) => {
  local(store, "legacy-doc", "p1", "dev"); mapped(store, "good");
  const migration = select();
  store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(migration, "legacy-doc", "good", "alias", "ext-good", "published", NOW, NOW);
  const row = await getProductBackend(store, { ...scope, documentId: "legacy-doc" }, control);
  assert.equal(row.id, "legacy-doc");
  assert.equal(row.kind, "product_document");
  assert.equal(row.body, "Actual engine body");
  assert.equal(row.sourceLocator, "manual/good.html#setup");
  assert.equal((row.citations as any[])[0].chunkId, "chunk-good");
  assert.deepEqual(reads, ["ext-good"]);
  assert.ok(!JSON.stringify(row).includes("Obsolete local"));
}));

test("selected engine never falls back to local content or leaks error bodies on outage", () => fixture(async ({ store, control, refs, fail, select }) => {
  local(store, "good", "p1", "dev"); mapped(store, "good"); select(); refs.push(reference("good")); fail();
  for (const operation of [
    () => searchProductBackend(store, { ...scope, query: "pump" }, control),
    () => getProductBackend(store, { ...scope, documentId: "good" }, control),
  ]) await assert.rejects(operation, error => error instanceof Error && /unavailable|degraded/i.test(error.message) && !error.message.includes("upstream-secret"));
}));

test("engine get rejects unpublished, wrong-scope and unknown IDs before fetching content", () => fixture(async ({ store, control, reads, select }) => {
  mapped(store, "foreign", { project: "p2" }); mapped(store, "staged", { status: "staged" }); mapped(store, "prod", { environment: "prod" });
  local(store, "unmigrated", "p1", "dev"); select();
  for (const documentId of ["foreign", "staged", "prod", "unmigrated"]) await assert.rejects(getProductBackend(store, { ...scope, documentId }, control), /denied|not found|migration/i);
  assert.equal(reads.length, 0);
}));

test("engine get rejects stale parse and mismatched chunk ownership without local shadow", () => fixture(async ({ store, control, readResult, select }) => {
  mapped(store, "good"); select();
  readResult({ documentId: "ext-good", parseStatus: "processing", content: "Partial", chunks: [] });
  await assert.rejects(getProductBackend(store, { ...scope, documentId: "good" }, control), /ready|parsed|processing/i);
  readResult({ documentId: "ext-good", parseStatus: "completed", content: "Foreign", chunks: [{ documentId: "ext-foreign", chunkId: "chunk-good", content: "Foreign", seq: 0 }] });
  await assert.rejects(getProductBackend(store, { ...scope, documentId: "good" }, control), /chunk|reference/i);
}));

test("explicit local rollback restores local provider and does not call engine", () => fixture(async ({ store, control, searches, select }) => {
  local(store, "local-only", "p1", "dev"); select();
  new MigrationController(store).setProductProvider("relay_local", 7);
  const rows = await searchProductBackend(store, scope, control);
  assert.deepEqual(rows.map(row => row.id), ["local-only"]);
  assert.equal(searches.length, 0);
}));


test("Product search rechecks publication after a concurrent upstream request", () => fixture(async ({store,control,select}) => {
  mapped(store,"good");select();
  control.client.search=async ()=>{store.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated' WHERE id='good'").run();return {retrievalRunId:"run",references:[reference("good")]};};
  await assert.rejects(searchProductBackend(store,{...scope,query:"pump"},control),/reference|scope|publication/i);
}));

test("a scoped Project can retrieve explicitly global published Product sources without seeing foreign scopes",()=>fixture(async({store,control,refs,select,searches})=>{
  mapped(store,"global");store.db.prepare("UPDATE knowledge_weknora_documents SET project_id=NULL,environment=NULL WHERE id='global'").run();
  mapped(store,"foreign-global-env",{project:"p2",environment:"prod"});
  select();refs.push(reference("global"));
  const rows=await searchProductBackend(store,{...scope,query:"pump"},control);
  assert.equal(rows.length,1);assert.equal(rows[0].id,"global");assert.deepEqual(searches[0].knowledgeIds,["ext-global"]);
}));


test("deprecating a legacy Product ID also removes its migrated publication",()=>fixture(async({store,control,select})=>{
  local(store,"legacy-doc","p1","dev");mapped(store,"good");const migration=select();
  store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(migration,"legacy-doc","good","alias","ext-good","published",NOW,NOW);
  updateProductDocumentLifecycle(store,"legacy-doc","deprecated");
  assert.equal((store.db.prepare("SELECT status FROM knowledge_weknora_documents WHERE id='good'").get() as {status:string}).status,"deprecated");
  assert.deepEqual(await searchProductBackend(store,scope,control),[]);
  await assert.rejects(getProductBackend(store,{...scope,documentId:"legacy-doc"},control),/not found|denied/i);
}));

test("Product diff uses selected engine bodies and enforces both source scopes",()=>fixture(async({store,control,select})=>{
  local(store,"left","p1","dev");local(store,"right","p1","dev");mapped(store,"left");mapped(store,"right");const migration=select();
  for(const id of ["left","right"])store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(migration,id,id,id,"ext-"+id,"published",NOW,NOW);
  const diff=await diffProductBackend(store,{...scope,leftId:"left",rightId:"right"},control);
  assert.ok(JSON.stringify(diff).includes("Actual engine body"));assert.ok(!JSON.stringify(diff).includes("Obsolete local"));
  store.db.prepare("UPDATE knowledge_weknora_documents SET project_id='p2' WHERE id='right'").run();
  await assert.rejects(diffProductBackend(store,{...scope,leftId:"left",rightId:"right"},control),/denied|not found/i);
}));


test("engine listing counts and pages beyond 500 published documents",()=>fixture(async({store,control,select})=>{
  store.db.transaction(()=>{for(let i=0;i<501;i++)mapped(store,"doc-"+String(i).padStart(4,"0"));})();select();
  const page=await listEngineProductBackend(store,{...scope,limit:100,offset:500},control);
  assert.equal(page.page.total,501);assert.equal(page.documents.length,1);assert.equal(page.documents[0].id,"doc-0500");
}));

test("engine catalog status filters never return approved publications for draft or deprecated",()=>fixture(async({store,control,select,reads,searches})=>{
  mapped(store,"published");mapped(store,"staged",{status:"staged"});mapped(store,"deprecated",{status:"deprecated"});mapped(store,"foreign",{project:"p2"});mapped(store,"old-binding",{kb:"old-kb"});select();
  for(const status of [undefined,"","approved","published"]){
    const result=await listEngineProductBackend(store,{...scope,...{status},limit:1,offset:0},control);
    assert.deepEqual(result.documents.map(row=>row.id),["published"],String(status));
    assert.equal(result.documents[0].lifecycle,"approved");assert.equal(result.page.total,1);
  }
  for(const status of ["draft","deprecated","staged","failed","unknown"]){
    const result=await listEngineProductBackend(store,{...scope,...{status},limit:50,offset:100},control);
    assert.deepEqual(result.documents,[],status);assert.deepEqual(result.page,{limit:50,offset:100,total:0});assert.equal(result.provider,"weknora");
  }
  await assert.rejects(listEngineProductBackend(store,{...scope,userId:10,...{status:"draft"}},control),/denied/i);
  assert.equal(reads.length,0);assert.equal(searches.length,0);
}));


test("local rollback keeps same-family Product diff compatible",()=>fixture(async({store,control})=>{
  local(store,"left","p1","dev");local(store,"right","p1","dev");
  const diff=await diffProductBackend(store,{...scope,leftId:"left",rightId:"right"},control);
  assert.equal(diff.leftId,"left");assert.equal(diff.rightVersion,"21.3");
}));

test("display metadata and no-op corrections preserve publication; changed source identity requires validation",()=>fixture(async({store,control,select})=>{
  local(store,"legacy-doc","p1","dev");mapped(store,"good");const migration=select();
  store.db.prepare("INSERT INTO knowledge_migration_documents(migration_id,local_document_id,document_id,idempotency_key,external_document_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(migration,"legacy-doc","good","alias","ext-good","published",NOW,NOW);
  assert.equal(correctProductMetadata(store,{ids:["legacy-doc"],authority:"official",documentType:"guide",language:"en",reason:"reviewed"}).engineRepublishRequired,0);
  assert.equal((await getProductBackend(store,{...scope,documentId:"legacy-doc"},control)).authority,"official");
  assert.equal(correctProductMetadata(store,{ids:["legacy-doc"],module:"New module",reason:"source correction"}).engineRepublishRequired,1);
  assert.deepEqual(await searchProductBackend(store,scope,control),[]);
}));


test("Product read passes the immutable normalized source hash and rejects corrupted source text",()=>fixture(async({store,control,select})=>{
  mapped(store,"good");select();
  const original=control.client.readDocument;
  let hash: string | undefined;
  control.client.readDocument=async(id,options)=>{hash=options?.expectedNormalizedSha256;return original(id,options);};
  assert.equal((await getProductBackend(store,{...scope,documentId:"good"},control)).body,"Actual engine body");
  assert.equal(hash,createHash("sha256").update("Actual engine body").digest("hex"));
  control.client.readDocument=async(id,options)=>({...await original(id,options),content:"Corrupted source text"});
  await assert.rejects(getProductBackend(store,{...scope,documentId:"good"},control),/hash|integrity|identity/i);
}));

test("Product read rechecks the normalized hash and ACL after the original-file request",()=>fixture(async({store,control,select})=>{
  mapped(store,"good");select();
  const original=control.client.readDocument;
  control.client.readDocument=async(id,options)=>{
    const result=await original(id,options);
    store.db.prepare("UPDATE knowledge_weknora_documents SET normalized_content_sha256=? WHERE id='good'").run("a".repeat(64));
    return result;
  };
  await assert.rejects(getProductBackend(store,{...scope,documentId:"good"},control),/hash|integrity|identity/i);
  control.client.readDocument=async(id,options)=>{
    const result=await original(id,options);
    store.db.prepare("UPDATE knowledge_acl SET can_read=0 WHERE project_id='p1' AND user_id=7").run();
    return result;
  };
  await assert.rejects(getProductBackend(store,{...scope,documentId:"good"},control),/denied/i);
}));


test("Product source limit is applied after real client chunk-to-document projection", () => fixture(async ({ store, control, select }) => {
  mapped(store, "dense"); mapped(store, "other"); select();
  const chunks = Array.from({ length: 180 }, (_, i) => "dense-" + i);
  store.db.prepare("UPDATE knowledge_weknora_documents SET external_chunk_ids_json=? WHERE id='dense'").run(JSON.stringify(chunks));
  const candidates = [...chunks.map((id, i) => ({ id, knowledge_id: "ext-dense", content: "Dense source " + i, chunk_type: "text", score: 1 - i / 1000 })),
    { id: "chunk-other", knowledge_id: "ext-other", content: "Independent source", chunk_type: "text", score: 0.7 }];
  control.client = new WeKnoraClient({ baseUrl: "https://engine.invalid", fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ success: true, data: candidates.slice(0, request.match_count) }), { headers: { "content-type": "application/json" } });
  } });
  const results = await searchProductBackend(store, { ...scope, query: "configuration", limit: 2 }, control);
  assert.deepEqual(results.map(row => [row.id, row.snippet]), [["dense", "Dense source 0"], ["other", "Independent source"]]);
  assert.equal((results[0].citations as any[])[0].chunkId, "dense-0");
}));

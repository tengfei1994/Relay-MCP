import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore, type KnowledgeStore } from "../src/knowledge/store.ts";
import { ActiveWikiService } from "../src/knowledge/active-wiki.ts";
import { EngineWikiService, type EngineWikiTransport } from "../src/knowledge/engine-wiki.ts";
import { WikiService } from "../src/knowledge/wiki.ts";

const NOW = "2026-10-25T00:00:00.000Z";
const KB = "private-kb";
type RemotePage = Record<string, any>;

/** Transport double mirrors upstream v0.8.3 raw Wiki API. Local ACL/audit/DB are real. */
function upstream() {
  const pages = new Map<string, RemotePage>();
  const histories = new Map<string, RemotePage[]>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let unavailable = false;
  let beforeResponse: (() => void) | undefined;
  const revision = (page: RemotePage) => ({ id: "revision-" + page.version, page_id: page.id, slug: page.slug, version: page.version, title: page.title, content: page.content, page_type: "concept", status: "published", summary: "", aliases: [], edit_source: "user", editor_id: "", edited_at: NOW, created_at: NOW });
  const request: EngineWikiTransport = async (method, path, body) => {
    calls.push({ method, path, body });
    if (unavailable) throw new Error("secret upstream body must not escape");
    beforeResponse?.();
    const url = new URL(path, "http://engine.invalid");
    const prefix = "/api/v1/knowledgebase/private-kb/wiki";
    assert.ok(url.pathname.startsWith(prefix));
    const route = url.pathname.slice(prefix.length);
    const data = body as any;
    if (route === "/pages" && method === "POST") {
      const page = { id: "upstream-" + data.slug, tenant_id: 1, knowledge_base_id: KB, slug: data.slug, title: data.title, content: data.content, page_type: data.page_type, status: "published", source_refs: data.source_refs ?? [], chunk_refs: data.chunk_refs ?? [], summary: "", aliases: [], in_links: [], out_links: [], page_metadata: {}, version: 1, created_at: NOW, updated_at: NOW };
      pages.set(page.slug, page); histories.set(page.slug, []);
      return structuredClone(page);
    }
    if (route === "/pages" && method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const all = [...pages.values()].filter(p => (p.title + " " + p.content).includes(query));
      const page = Number(url.searchParams.get("page") ?? 1), size = Number(url.searchParams.get("page_size") ?? 20);
      return { pages: structuredClone(all.slice((page - 1) * size, page * size)), total: all.length, page, page_size: size, total_pages: Math.ceil(all.length / size) };
    }
    if (route.startsWith("/pages/")) {
      const slug = decodeURIComponent(route.slice(7)), page = pages.get(slug);
      if (!page) throw new Error("upstream not found");
      if (method === "GET") return structuredClone(page);
      assert.equal(data.version, page.version, "PUT must use optimistic concurrency");
      histories.get(slug)!.unshift(revision(page));
      if (data.title !== undefined) page.title = data.title;
      page.content = data.content; page.version++;
      return structuredClone(page);
    }
    if (route.startsWith("/revisions/")) {
      const slug = decodeURIComponent(route.slice(11)), rows = histories.get(slug) ?? [];
      if (url.searchParams.has("version")) {
        const historical = rows.find(r => r.version === Number(url.searchParams.get("version")));
        if (!historical) throw Object.assign(new Error("historical revision not found"), { status: 404 });
        return structuredClone(historical);
      }
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
      return { revisions: structuredClone(rows.slice(offset, offset + limit).map(({ content, ...r }) => r)), total: rows.length, current_version: pages.get(slug)!.version };
    }
    if (route === "/revert" && method === "POST") {
      const page = pages.get(data.slug)!, rev = histories.get(data.slug)!.find(r => r.version === data.version)!;
      if (data.version === page.version) throw Object.assign(new Error("cannot revert to current version"), { status: 400 });
      histories.get(data.slug)!.unshift(revision(page));
      page.title = rev.title; page.content = rev.content; page.version++;
      return structuredClone(page);
    }
    throw new Error("Unexpected Wiki request");
  };
  return { request, calls, pages, histories, onResponse: (fn: () => void) => { beforeResponse = fn; }, fail: () => { unavailable = true; } };
}

async function fixture(fn: (f: { store: KnowledgeStore; wiki: EngineWikiService; remote: ReturnType<typeof upstream> }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "relay-engine-wiki-"));
  const store = createKnowledgeStore({ dbPath: join(root, "knowledge.db") });
  // Root owns migration040; make the fixture work while its independent implementation is in flight.
  for (const [table, column, type] of [
    ["knowledge_wiki_pages", "environment", "TEXT"],
    ["knowledge_weknora_documents", "environment", "TEXT"],
    ["knowledge_weknora_documents", "upstream_verified_at", "TEXT"],
    ["knowledge_weknora_documents", "upstream_parse_status", "TEXT"],
  ]) {
    if (!(store.db.prepare("PRAGMA table_info(" + table + ")").all() as any[]).some(r => r.name === column)) store.db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
  }
  store.grantAcl("p1", 7, true); store.grantAcl("p1", 8, false); store.grantAcl("p2", 10, true);
  const remote = upstream();
  const wiki = new EngineWikiService(store, { knowledgeBaseId: KB, request: remote.request }, () => new Date(NOW));
  try { await fn({ store, wiki, remote }); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

function document(store: KnowledgeStore, values: { id?: string; project?: string | null; environment?: string; kb?: string; status?: string; verified?: boolean } = {}) {
  const id = values.id ?? "doc-1";
  store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,raw_sha256,parser_version,product_version,source_path,project_id,environment,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "external-" + id, values.kb ?? KB, JSON.stringify(["chunk-" + id]), "Source manual", "n".repeat(64), "a".repeat(64), "v1", "21.3", "manual/pump.html#setup", (values.project === undefined ? "p1" : values.project), values.environment ?? null, values.status ?? "published", id, NOW, NOW, values.verified === false ? null : NOW, "completed");
}
const create = (wiki: EngineWikiService, overrides: Record<string, any> = {}) => wiki.create({ actorId: 7, pageKey: "pump-triage", title: "Pump triage", body: "Inspect pump.", projectId: "p1", sourceRefs: ["doc-1"], reason: "Initial", ...overrides });

for (const operation of ["publish", "deprecate", "edit", "rollback"] as const) {
  for (const concurrentChange of ["reviewer-acl", "sources"] as const) {
    test(`Wiki ${operation} no-op still checks a second store's ${concurrentChange} change`, () => fixture(async ({store,wiki,remote}) => {
      document(store);document(store,{id:"doc-2"});const page=await create(wiki);
      if(operation==="publish")await wiki.publish({actorId:7,id:page.id,reason:"Review"});
      if(operation==="deprecate")await wiki.deprecate({actorId:7,id:page.id,reason:"Retire"});
      const other=createKnowledgeStore({dbPath:store.db.name}),transaction=store.db.transaction.bind(store.db);
      let interleaved=false;const writesBefore=remote.calls.filter(call=>call.method!=="GET").length;
      (store.db as any).transaction=(fn:any)=>{
        if(!interleaved){interleaved=true;if(concurrentChange==="reviewer-acl")other.db.prepare("UPDATE knowledge_acl SET can_review=0 WHERE user_id=7 AND project_id='p1'").run();else other.db.prepare("UPDATE knowledge_wiki_pages SET source_refs_json='[\"doc-2\"]' WHERE id=?").run(page.id);}
        return transaction(fn);
      };
      try {
        const input={actorId:7,id:page.id,reason:"No change"};
        await assert.rejects(operation==="edit"?wiki.edit({...input,body:page.body}):operation==="rollback"?wiki.rollback({...input,revision:1}):wiki[operation](input),/concurrent|reviewer|denied/i);
        assert.ok(interleaved);assert.equal(remote.calls.filter(call=>call.method!=="GET").length,writesBefore);
      } finally {(store.db as any).transaction=transaction;other.close();}
    }));
  }
  for (const concurrentChange of ["status", "revision", "sources", "source-withdrawal"] as const) {
    test(`Wiki ${operation} rejects a second store's ${concurrentChange} change before commit`, () => fixture(async ({store,wiki}) => {
      document(store); document(store,{id:"doc-2"}); const page=await create(wiki);
      if(operation==="rollback") await wiki.edit({actorId:7,id:page.id,body:"Revision two",reason:"Prepare history"});
      const other=createKnowledgeStore({dbPath:store.db.name});
      const transaction=store.db.transaction.bind(store.db);
      let interleaved=false;
      const auditCount=()=>Number((store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_audit WHERE entity_id=?").get(page.id) as {n:number}).n);
      const beforeAudit=auditCount();
      // Real independent WAL writer commits exactly after the remote response
      // has been hydrated and before the first store acquires its write lock.
      (store.db as any).transaction=(fn:any)=>{
        if(!interleaved){
          interleaved=true;
          if(concurrentChange==="status")other.db.prepare("UPDATE knowledge_wiki_pages SET status=? WHERE id=?").run(operation==="publish"?"deprecated":"published",page.id);
          if(concurrentChange==="revision")other.db.prepare("UPDATE knowledge_wiki_pages SET current_revision=current_revision+1 WHERE id=?").run(page.id);
          if(concurrentChange==="sources")other.db.prepare("UPDATE knowledge_wiki_pages SET source_refs_json='[\"doc-2\"]' WHERE id=?").run(page.id);
          if(concurrentChange==="source-withdrawal")other.db.prepare("UPDATE knowledge_weknora_documents SET status='deprecated' WHERE id='doc-1'").run();
        }
        return transaction(fn);
      };
      try {
        const input={actorId:7,id:page.id,reason:"Concurrent review"};
        const work=operation==="edit"?wiki.edit({...input,body:"Changed source summary"}):operation==="rollback"?wiki.rollback({...input,revision:1}):wiki[operation](input);
        await assert.rejects(work,/conflict|concurrent|deprecated|source|citation/i);
        assert.ok(interleaved);assert.equal(auditCount(),beforeAudit,"rejected operation must not write a successful review audit");
        const persisted=other.db.prepare("SELECT status,current_revision,source_refs_json FROM knowledge_wiki_pages WHERE id=?").get(page.id) as any;
        if(concurrentChange==="status")assert.equal(persisted.status,operation==="publish"?"deprecated":"published");
        if(concurrentChange==="sources")assert.equal(persisted.source_refs_json,'["doc-2"]');
        if(concurrentChange==="revision")assert.equal(persisted.current_revision,operation==="rollback"?3:2);
      } finally {(store.db as any).transaction=transaction;other.close();}
    }));
  }
}

test("engine Wiki rejects unauthorized create before any upstream write", () => fixture(async ({ wiki, remote }) => {
  await assert.rejects(create(wiki, { actorId: 10 }), /denied/i);
  await assert.rejects(create(wiki, { actorId: 8 }), /reviewer/i);
  assert.equal(remote.calls.length, 0);
}));

test("engine Wiki stores bodies and revisions upstream while hydrating Relay citations", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  assert.equal(page.body, "Inspect pump.");
  assert.deepEqual(page.sourceRefs, ["doc-1"]);
  assert.equal(page.citations[0].sourceLocator, "manual/pump.html#setup");
  assert.equal(page.citations[0].sourceSha256, "a".repeat(64));
  assert.deepEqual(page.citations[0].chunkIds, ["chunk-doc-1"]);
  assert.equal((store.db.prepare("SELECT body FROM knowledge_wiki_pages WHERE id=?").get(page.id) as any).body, "");
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_wiki_page_revisions").get() as any).n, 0);
  assert.ok(!JSON.stringify(page).includes(KB));
  const replay = await create(wiki, { body: "Ignored replay" });
  assert.equal(replay.id, page.id);
  assert.equal(replay.body, "Inspect pump.");
  assert.equal(remote.calls.filter(c => c.method === "POST").length, 1);
}));

test("engine Wiki read gates require published state and exact environment before upstream reads", () => fixture(async ({ store, wiki, remote }) => {
  document(store, { environment: "dev" });
  const page = await create(wiki, { environment: "dev" });
  const count = remote.calls.length;
  await assert.rejects(wiki.get({ actorId: 8, id: page.id, environment: "dev" }), /published/i);
  await assert.rejects(wiki.get({ actorId: 7, id: page.id, environment: "prod" }), /denied/i);
  await assert.rejects(wiki.get({ actorId: 10, id: page.id, environment: "dev" }), /denied/i);
  assert.equal(remote.calls.length, count);
  await wiki.publish({ actorId: 7, id: page.id, environment: "dev", reason: "Reviewed" });
  assert.equal((await wiki.get({ actorId: 8, id: page.id, environment: "dev" })).status, "published");
}));

test("engine Wiki rejects unknown, foreign, staged, unverified and wrong-KB source mappings", () => fixture(async ({ store, wiki, remote }) => {
  for (const [id, values] of [
    ["foreign", { project: "p2" }], ["staged", { status: "staged" }], ["unverified", { verified: false }], ["other-kb", { kb: "another-kb" }], ["prod", { environment: "prod" }],
  ] as const) document(store, { id, ...values });
  for (const ref of ["missing", "foreign", "staged", "unverified", "other-kb", "prod"]) {
    await assert.rejects(create(wiki, { sourceRefs: [ref] }), /source|citation/i);
  }
  assert.equal(remote.calls.length, 0);
}));

test("engine Wiki rejects unknown upstream citations and does not trust provider titles", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  const upstreamPage = [...remote.pages.values()][0];
  upstreamPage.source_refs = ["external-doc-1|provider title"];
  const read = await wiki.get({ actorId: 7, id: page.id });
  assert.equal(read.citations[0].title, "Source manual");
  upstreamPage.source_refs = ["unknown|forged"];
  await assert.rejects(wiki.get({ actorId: 7, id: page.id }), /source|citation/i);
  upstreamPage.source_refs = ["external-doc-1|title"]; upstreamPage.chunk_refs = ["foreign-chunk"];
  await assert.rejects(wiki.get({ actorId: 7, id: page.id }), /chunk|citation/i);
}));

test("engine Wiki edit, full revision read, diff and revert use remote history with audit", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  await wiki.publish({ actorId: 7, id: page.id, reason: "Review" });
  const edited = await wiki.edit({ actorId: 7, id: page.id, body: "Inspect pump.\nCheck fuse.", reason: "Add check" });
  assert.equal(edited.currentRevision, 2);
  assert.equal(edited.status, "draft", "new remote content needs fresh publication");
  const revisions = await wiki.listRevisions({ actorId: 7, id: page.id });
  assert.deepEqual(revisions.map(r => r.revision), [2, 1]);
  assert.equal(revisions[1].body, "Inspect pump.");
  const diff = await wiki.diffRevisions({ actorId: 7, id: page.id, fromRevision: 1, toRevision: 2 });
  assert.match(diff, /^\+Check fuse\./m);
  const reverted = await wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "Restore" });
  assert.equal(reverted.currentRevision, 3);
  assert.equal(reverted.body, "Inspect pump.");
  assert.ok(remote.calls.some(c => c.path.endsWith("/revert") && c.body.version === 1));
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_wiki_page_revisions").get() as any).n, 0);
  const audits = store.db.prepare("SELECT action,details_json FROM knowledge_audit WHERE entity_id=?").all(page.id) as any[];
  assert.ok(audits.some(a => a.action === "wiki.rollback"));
  assert.ok(audits.every(a => !a.details_json.includes("Inspect pump")));
}));

test("current-only Wiki history and rollback never request the nonexistent current snapshot", () => fixture(async ({ store, wiki, remote }) => {
  document(store); const page = await create(wiki);
  assert.equal([...remote.histories.values()][0].length, 0);
  assert.deepEqual((await wiki.listRevisions({ actorId: 7, id: page.id })).map(r => r.revision), [1]);
  assert.deepEqual(await wiki.listRevisions({ actorId: 7, id: page.id, offset: 1 }), []);
  const count = remote.calls.length;
  const same = await wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "Already current" });
  assert.equal(same.currentRevision, 1);
  assert.ok(remote.calls.slice(count).every(call => call.method === "GET" && !call.path.includes("/revisions/")));
  assert.ok(!remote.calls.some(call => call.path.includes("version=1")));
}));

test("Wiki revision pagination merges current once and filters publication before paging", () => fixture(async ({ store, wiki, remote }) => {
  document(store); const page = await create(wiki);
  await wiki.publish({ actorId: 7, id: page.id, reason: "Review first" });
  await wiki.edit({ actorId: 7, id: page.id, body: "Unpublished second", reason: "Draft" });
  await wiki.edit({ actorId: 7, id: page.id, body: "Reviewed third", reason: "Improve" });
  await wiki.publish({ actorId: 7, id: page.id, reason: "Review third" });
  assert.deepEqual([...remote.histories.values()][0].map(r => r.version), [2, 1]);
  for (const [actorId, expected] of [[7, [3, 2, 1]], [8, [3, 1]]] as const) {
    const seen: number[] = [];
    for (let offset = 0; offset <= expected.length; offset++) seen.push(...(await wiki.listRevisions({ actorId, id: page.id, limit: 1, offset })).map(r => r.revision));
    assert.deepEqual(seen, expected);
  }
  await assert.rejects(wiki.diffRevisions({ actorId: 8, id: page.id, fromRevision: 2, toRevision: 3 }), /reviewed/i);
  const diff = await wiki.diffRevisions({ actorId: 8, id: page.id, fromRevision: 1, toRevision: 3 });
  assert.match(diff, /Reviewed third/);
  assert.ok(!remote.calls.some(call => call.path.includes("version=3")), "current version comes from the page response");
  store.db.prepare("DELETE FROM knowledge_audit WHERE entity_id=? AND action='wiki.publish' AND json_extract(details_json,'$.revision')=3").run(page.id);
  assert.deepEqual((await wiki.listRevisions({ actorId: 8, id: page.id })).map(r => r.revision), [1], "published state alone cannot authorize an unaudited current version");
  await assert.rejects(wiki.diffRevisions({ actorId: 8, id: page.id, fromRevision: 1, toRevision: 3 }), /reviewed/i);
}));

test("Wiki history refuses concurrent version changes instead of mixing pagination snapshots", () => fixture(async ({ store, wiki, remote }) => {
  document(store); const page = await create(wiki);
  await wiki.edit({ actorId: 7, id: page.id, body: "second", reason: "Update" });
  const changing = new EngineWikiService(store, { knowledgeBaseId: KB, request: async (method, path, body) => {
    const result = await remote.request(method, path, body);
    return path.includes("/revisions/") && path.includes("limit=") ? { ...(result as RemotePage), current_version: 3 } : result;
  } });
  await assert.rejects(changing.listRevisions({ actorId: 7, id: page.id }), /changed while reading history/i);
}));

test("engine Wiki remote outage cannot return shadow content or commit lifecycle success", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  const before = (store.db.prepare("SELECT COUNT(*) n FROM knowledge_audit WHERE entity_id=?").get(page.id) as any).n;
  remote.fail();
  for (const operation of [
    () => wiki.get({ actorId: 7, id: page.id }),
    () => wiki.publish({ actorId: 7, id: page.id, reason: "Publish" }),
    () => wiki.edit({ actorId: 7, id: page.id, body: "New", reason: "Edit" }),
    () => wiki.listRevisions({ actorId: 7, id: page.id }),
    () => wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "Revert" }),
  ]) await assert.rejects(operation, e => e instanceof Error && /unavailable|degraded/i.test(e.message) && !e.message.includes("secret upstream"));
  assert.equal((store.db.prepare("SELECT status FROM knowledge_wiki_pages WHERE id=?").get(page.id) as any).status, "draft");
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_audit WHERE entity_id=?").get(page.id) as any).n, before);
}));

test("engine Wiki lists and searches upstream without leaking unmapped or unpublished pages", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const first = await create(wiki);
  await wiki.publish({ actorId: 7, id: first.id, reason: "Review" });
  await create(wiki, { pageKey: "draft", title: "Draft pump" });
  remote.pages.set("foreign", { id: "foreign-id", slug: "foreign", title: "Secret pump", content: "private", version: 1, source_refs: [], chunk_refs: [] });
  const result = await wiki.list({ actorId: 8, projectId: "p1", search: "pump", limit: 1 });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(p => p.id), [first.id]);
  assert.ok(!("body" in result.items[0]));
  assert.ok(remote.calls.some(c => c.path.includes("/pages?") && c.path.includes("query=pump")));
}));

test("engine Wiki blocks unreviewed upstream changes and local legacy IDs", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  await wiki.publish({ actorId: 7, id: page.id, reason: "Review" });
  const upstreamPage = [...remote.pages.values()][0]; upstreamPage.version = 2; upstreamPage.content = "Unreviewed change";
  await assert.rejects(wiki.get({ actorId: 8, id: page.id }), /review|revision/i);
  assert.equal((await wiki.get({ actorId: 7, id: page.id })).status, "draft");
  await assert.rejects(wiki.get({ actorId: 7, id: "legacy-local-wiki" }), /migration|not found/i);
}));

test("engine Wiki deprecate blocks readers and mutations without deleting remote history", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  const page = await create(wiki);
  await wiki.publish({ actorId: 7, id: page.id, reason: "Review" });
  await wiki.deprecate({ actorId: 7, id: page.id, reason: "Superseded" });
  await assert.rejects(wiki.get({ actorId: 8, id: page.id }), /published|deprecated/i);
  await assert.rejects(wiki.edit({ actorId: 7, id: page.id, body: "Cannot edit", reason: "Try" }), /deprecated/i);
  await assert.rejects(wiki.rollback({ actorId: 7, id: page.id, revision: 1, reason: "Try" }), /deprecated/i);
  assert.equal(remote.pages.size, 1);
}));


test("source-verified generated Wiki pages are discovered as drafts for reviewers only", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  remote.pages.set("concept/pump", { id: "generated-1", knowledge_base_id: KB, slug: "concept/pump", title: "Generated pump guide", content: "Synthesized from the manual.", version: 1, source_refs: ["external-doc-1|Upstream title"], chunk_refs: ["chunk-doc-1"], created_at: NOW, updated_at: NOW });
  const reader = await wiki.list({ actorId: 8, projectId: "p1" });
  assert.equal(reader.total, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_wiki_pages").get() as any).n, 0);
  const reviewer = await wiki.list({ actorId: 7, projectId: "p1" });
  assert.equal(reviewer.total, 1);
  const discovered = reviewer.items[0];
  assert.equal(discovered.status, "draft");
  assert.deepEqual(discovered.sourceRefs, ["doc-1"]);
  assert.equal((store.db.prepare("SELECT body,external_slug FROM knowledge_wiki_pages WHERE id=?").get(discovered.id) as any).body, "");
  assert.equal((store.db.prepare("SELECT external_slug FROM knowledge_wiki_pages WHERE id=?").get(discovered.id) as any).external_slug, "concept/pump");
  const read = await wiki.get({ actorId: 7, id: discovered.id });
  assert.equal(read.body, "Synthesized from the manual.");
  assert.equal((await wiki.list({ actorId: 7, projectId: "p1" })).items[0].id, discovered.id);
  await wiki.publish({ actorId: 7, id: discovered.id, reason: "Reviewed generated draft" });
  assert.equal((await wiki.list({ actorId: 8, projectId: "p1" })).total, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_audit WHERE action='wiki.discover'").get() as any).n, 1);
}));

test("generated Wiki discovery never adopts foreign, missing or unverified source pages", () => fixture(async ({ store, wiki, remote }) => {
  document(store, { id: "foreign", project: "p2" });
  document(store, { id: "unverified", verified: false });
  for (const [slug, refs] of [["foreign", ["external-foreign|Foreign"]], ["missing", ["external-missing|Unknown"]], ["unverified", ["external-unverified|Unverified"]], ["no-sources", []]] as const) {
    remote.pages.set(slug, { id: slug, knowledge_base_id: KB, slug, title: slug, content: "Unsafe draft", version: 1, source_refs: refs, chunk_refs: [], created_at: NOW, updated_at: NOW });
  }
  assert.equal((await wiki.list({ actorId: 7, projectId: "p1" })).total, 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_wiki_pages").get() as any).n, 0);
  await assert.rejects(wiki.adopt({ actorId: 7, slug: "foreign", projectId: "p1", reason: "Try" }), /source|citation/i);
  const count = remote.calls.length;
  await assert.rejects(wiki.adopt({ actorId: 8, slug: "foreign", projectId: "p1", reason: "Try" }), /reviewer/i);
  assert.equal(remote.calls.length, count);
}));


test("Wiki reads recheck publication after the upstream response", () => fixture(async ({store,wiki,remote}) => {
  document(store); const page=await create(wiki); await wiki.publish({actorId:7,id:page.id,reason:"Review"});
  remote.onResponse(()=>store.db.prepare("UPDATE knowledge_wiki_pages SET status='deprecated' WHERE id=?").run(page.id));
  await assert.rejects(wiki.get({actorId:8,id:page.id}),/published|deprecated/i);
}));

function generated(remote: ReturnType<typeof upstream>, slug: string, ids: string[]) {
  remote.pages.set(slug, { id: 'generated-' + slug, knowledge_base_id: KB, slug, title: slug, content: 'Generated source-backed Wiki.', version: 1,
    source_refs: ids.map(id => 'external-' + id + '|Source'), chunk_refs: ids.map(id => 'chunk-' + id), created_at: NOW, updated_at: NOW });
}

test("generated Wiki slugs converge to one canonical topic while retaining duplicate drafts and citations", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  store.db.prepare("UPDATE knowledge_weknora_documents SET topic_id='topic-shared' WHERE id='doc-1'").run();
  generated(remote, "generated/one", ["doc-1"]);
  generated(remote, "generated/two", ["doc-1"]);
  const first = await wiki.adopt({ actorId: 7, slug: "generated/one", projectId: "p1", reason: "Review source" });
  const second = await wiki.adopt({ actorId: 7, slug: "generated/two", projectId: "p1", reason: "Review duplicate source" });
  assert.equal(second.id, first.id);
  const rows = store.db.prepare("SELECT id,status,source_refs_json FROM knowledge_wiki_pages ORDER BY created_at,id").all() as Array<{ id: string; status: string; source_refs_json: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === "draft"));
  assert.deepEqual(JSON.parse(rows[0].source_refs_json), ["doc-1"]);
  assert.deepEqual(JSON.parse(rows[1].source_refs_json), ["doc-1"]);
  assert.equal((await wiki.list({ actorId: 7, projectId: "p1" })).total, 1);
  const duplicate = rows.find(row => row.id !== first.id);
  assert.ok(duplicate);
  assert.equal((await wiki.get({ actorId: 7, id: duplicate.id, projectId: "p1" })).duplicateOf, first.id);
  await assert.rejects(wiki.publish({ actorId: 7, id: duplicate.id, projectId: "p1", reason: "Must stay draft" }), /duplicate|canonical/i);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_audit WHERE action='wiki.discover_duplicate'").get() as { n: number }).n, 1);
  assert.equal(remote.calls.filter(call => call.method === "POST").length, 0);
}));

test("generated Wiki fallback identity keeps distinct upstream slugs separate", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  document(store, { id: "doc-2" });
  generated(remote, "fallback/one", ["doc-1"]);
  generated(remote, "fallback/two", ["doc-1"]);
  generated(remote, "different-topic", ["doc-2"]);
  await wiki.adopt({ actorId: 7, slug: "fallback/one", projectId: "p1", reason: "Review fallback" });
  await wiki.adopt({ actorId: 7, slug: "fallback/two", projectId: "p1", reason: "Review duplicate fallback" });
  await wiki.adopt({ actorId: 7, slug: "different-topic", projectId: "p1", reason: "Review another topic" });
  assert.equal((await wiki.list({ actorId: 7, projectId: "p1" })).total, 3);
}));

test('project Wiki may cite global Product sources while retaining explicitly chosen private scope', () => fixture(async ({ store, wiki }) => {
  document(store, { id: 'global', project: null });
  document(store, { environment: 'nonprod' });
  const page = await create(wiki, { environment: 'nonprod', sourceRefs: ['global', 'doc-1'] });
  assert.equal(page.projectId, 'p1'); assert.equal(page.environment, 'nonprod');
  assert.deepEqual(page.sourceRefs.sort(), ['doc-1', 'global']);
  await wiki.publish({ actorId: 7, id: page.id, environment: 'nonprod', reason: 'Review scoped synthesis' });
  await assert.rejects(wiki.get({ actorId: 10, id: page.id, environment: 'nonprod' }), /denied/i);
  assert.equal((await wiki.get({ actorId: 8, id: page.id, environment: 'nonprod' })).status, 'published');
}));

test('all-global generated Wiki is adopted once globally and readable from either authorized project context', () => fixture(async ({ store, wiki, remote }) => {
  document(store, { id: 'global', project: null }); generated(remote, 'global-guide', ['global']);
  const first = await wiki.list({ actorId: 7, projectId: 'p1', environment: 'nonprod' });
  assert.equal(first.total, 1); const page = first.items[0];
  assert.equal(page.projectId, undefined); assert.equal(page.environment, undefined);
  assert.equal(page.productVersion, '21.3');
  const second = await wiki.list({ actorId: 10, projectId: 'p2', environment: 'prod' });
  assert.deepEqual(second.items.map(p => p.id), [page.id]);
  assert.equal((await wiki.get({ actorId: 10, id: page.id, projectId: 'p2', environment: 'prod' })).id, page.id);
  await wiki.publish({ actorId: 7, id: page.id, projectId: 'p1', environment: 'nonprod', reason: 'Review global source' });
  assert.equal((await wiki.get({ actorId: 8, id: page.id, projectId: 'p1', environment: 'prod' })).status, 'published');
  assert.equal((await wiki.list({ actorId: 8, projectId: 'p1', environment: 'prod' })).total, 1);
  const before = remote.calls.length;
  await assert.rejects(wiki.get({ actorId: 99, id: page.id, environment: 'prod' }), /denied/i);
  assert.equal(remote.calls.length, before);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM knowledge_audit WHERE action='wiki.discover'").get() as any).n, 1);
  assert.deepEqual(store.db.prepare('SELECT project_id,environment,body FROM knowledge_wiki_pages WHERE id=?').get(page.id), { project_id: null, environment: null, body: '' });
}));

test('global plus one-project generated sources infer project scope and scoped lists include global pages', () => fixture(async ({ store, wiki, remote }) => {
  document(store, { id: 'global', project: null }); document(store, { environment: 'nonprod' });
  generated(remote, 'global-guide', ['global']); generated(remote, 'scoped-guide', ['global', 'doc-1']);
  const mixed = await wiki.adopt({ actorId: 7, slug: 'scoped-guide', reason: 'Infer source scope' });
  assert.equal(mixed.projectId, 'p1'); assert.equal(mixed.environment, 'nonprod');
  const own = await wiki.list({ actorId: 7, projectId: 'p1', environment: 'nonprod' });
  assert.equal(own.total, 2); assert.ok(own.items.some(p => p.id === mixed.id));
  const foreign = await wiki.list({ actorId: 10, projectId: 'p2', environment: 'nonprod' });
  assert.equal(foreign.total, 1); assert.equal(foreign.items[0].projectId, undefined);
  await assert.rejects(wiki.get({ actorId: 10, id: mixed.id, projectId: 'p2', environment: 'nonprod' }), /denied/i);
}));

test('global sources do not authorize foreign or multiple-project generated citations even for a multi-project reviewer', () => fixture(async ({ store, wiki, remote }) => {
  store.grantAcl('p2', 7, true);
  document(store, { id: 'global', project: null }); document(store, { environment: 'nonprod' });
  document(store, { id: 'foreign', project: 'p2', environment: 'nonprod' });
  generated(remote, 'foreign-mix', ['global', 'foreign']); generated(remote, 'two-projects', ['global', 'doc-1', 'foreign']);
  assert.equal((await wiki.list({ actorId: 7, projectId: 'p1', environment: 'nonprod' })).total, 0);
  await assert.rejects(wiki.adopt({ actorId: 7, slug: 'two-projects', reason: 'Try mixed project sources' }), /source|scope|citation/i);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM knowledge_wiki_pages').get() as any).n, 0);
}));

test('only both-null source scope is global and version filters still apply', () => fixture(async ({ store, wiki, remote }) => {
  document(store, { id: 'global', project: null });
  document(store, { id: 'environment-only', project: null, environment: 'prod' });
  generated(remote, 'global-guide', ['global']); generated(remote, 'environment-mix', ['global', 'environment-only']);
  await assert.rejects(wiki.adopt({ actorId: 7, slug: 'environment-mix', environment: 'prod', reason: 'Try ambiguous scope' }), /source|scope|citation/i);
  assert.equal((await wiki.list({ actorId: 7, projectId: 'p1', environment: 'nonprod', productVersion: '21.1' })).total, 0);
  const allowed = await wiki.list({ actorId: 7, projectId: 'p1', environment: 'nonprod', productVersion: '21.3' });
  assert.equal(allowed.total, 1); assert.equal(allowed.items[0].pageKey.endsWith('global-guide'), true);
}));

test('global Wiki rechecks caller project ACL and source scope after the upstream response', () => fixture(async ({ store, wiki, remote }) => {
  document(store, { id: 'global', project: null }); generated(remote, 'global-guide', ['global']);
  const page = await wiki.adopt({ actorId: 7, slug: 'global-guide', reason: 'Discover global page' });
  await wiki.publish({ actorId: 7, id: page.id, reason: 'Review global page' });
  store.grantAcl('p2', 8, false);
  remote.onResponse(() => store.db.prepare('DELETE FROM knowledge_acl WHERE user_id=8 AND project_id=?').run('p1'));
  await assert.rejects(wiki.get({ actorId: 8, id: page.id, projectId: 'p1', environment: 'nonprod' }), /denied/i);
  remote.onResponse(() => store.db.prepare("UPDATE knowledge_weknora_documents SET project_id='p2' WHERE id='global'").run());
  await assert.rejects(wiki.get({ actorId: 7, id: page.id, projectId: 'p1', environment: 'nonprod' }), /source|scope|citation/i);
}));


test("Wiki chunk citations reflect actual page references, not all authorized source chunks", () => fixture(async ({ store, wiki, remote }) => {
  document(store);
  store.db.prepare("UPDATE knowledge_weknora_documents SET external_chunk_ids_json=? WHERE id='doc-1'")
    .run(JSON.stringify(["chunk-doc-1", "uncited-chunk"]));
  const page = await create(wiki);
  const upstreamPage = [...remote.pages.values()][0];
  upstreamPage.chunk_refs = ["chunk-doc-1"];
  const cited = await wiki.get({ actorId: 7, id: page.id });
  assert.deepEqual(cited.citations[0].chunkIds, ["chunk-doc-1"]);
  upstreamPage.chunk_refs = [];
  const documentOnly = await wiki.get({ actorId: 7, id: page.id });
  assert.deepEqual(documentOnly.sourceRefs, ["doc-1"]);
  assert.deepEqual(documentOnly.citations[0].chunkIds, []);
}));
test("hybrid Wiki reads engine content and citations while Product routing stays local", () => fixture(async ({ store, wiki }) => {
  document(store);
  const page = await create(wiki);
  const active = new ActiveWikiService(store, new WikiService(store), wiki);
  const read = await active.get({ actorId: 7, id: page.id, projectId: "p1" });
  assert.equal(read.body, "Inspect pump.");
  if (!("citations" in read)) throw new Error("Expected engine Wiki citations");
  assert.equal(read.citations[0].documentId, "doc-1");
  assert.equal(read.citations[0].chunkIds.length, 1);
  const list = await active.list({ actorId: 7, projectId: "p1", status: "draft" });
  assert.deepEqual(list.items.map(item => item.id), [page.id]);
}));

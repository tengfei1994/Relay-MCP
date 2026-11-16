import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { importKnowledgeProducts } from "../src/knowledge/knowledge-products.js";
import { getConfirmedMemory, getMemorySubmission, reviewLegacyMemoryScope, reviewMemorySubmission, searchConfirmedMemories, submitMemory, type MemoryAccess } from "../src/knowledge/memory-v2.js";
import { readPublicProduct, searchPublicProductChunks } from "../src/knowledge/product-search-v2.js";
import { wikiPageVisible, wikiRevisionVisible } from "../src/knowledge/wiki-access.js";
import { captureKnowledgeCandidates } from "../src/knowledge/capture-worker.js";
import { listLegacyCandidatesForReview, reviewLegacyCandidate } from "../src/knowledge/legacy-candidate-review.js";
import { CONFIRMED_MEMORY_MIGRATION } from "../src/knowledge/migrations/047-confirmed-memory.js";
import { publicSourceLocation } from "../src/knowledge/source-display.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-v2-"));
  const store = new KnowledgeStore({ dbPath:join(root,"knowledge.db"), appDbPath:join(root,"app.db"), evidenceRoot:join(root,"evidence") });
  const close = () => { store.close(); rmSync(root,{recursive:true,force:true}); };
  return { root, store, close };
}
function access(actorId: number, projects: string[], general: () => boolean, isAdmin = false): MemoryAccess {
  return { actorId, isAdmin, canReadGeneral:general, assertProject(id) { if (!projects.includes(id)) throw new Error("Project access denied"); } };
}

test("source citations omit server filesystem paths and URL credentials",()=>{
  assert.equal(publicSourceLocation("product-doc:C:\\private\\guide.md#page=2"),"product-doc:guide.md#page=2");
  assert.equal(publicSourceLocation("file:///home/private/guide.md"),"guide.md");
  assert.equal(publicSourceLocation("manuals/guide.md#page=2"),"manuals/guide.md#page=2");
  assert.equal(publicSourceLocation("https://user:secret@example.test/guide?token=secret#page=2"),"https://example.test/guide#page=2");
});

test("only explicitly classified published product chunks are searchable, including multiple chunks per document", async () => {
  const {root,store,close}=fixture();
  try {
    const docs=join(root,"docs"); mkdirSync(docs); writeFileSync(join(docs,"guide.md"),"# Manual\n\n## Configure\nCalibration alpha.\n\n## Inspect\nCalibration beta.");
    const imported=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:"21.3",product:"LIMS"});
    const id=imported.documents[0]; assert.ok(id);
    assert.equal((await searchPublicProductChunks(store,{query:"Calibration"})).references.length,0);
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product',?)").run(id,new Date().toISOString());
    const found=await searchPublicProductChunks(store,{query:"Calibration",productVersion:"21.3"});
    assert.equal(found.references.length,2); assert.ok(found.references.every(row=>row.documentId===id));
    assert.equal((await searchPublicProductChunks(store,{query:"Calibration",productVersion:"wrong"})).references.length,0);
    const first=found.references[0]; const read=await readPublicProduct(store,{documentId:id,chunkId:String(first.chunkId)}); assert.equal(read.body,first.snippet);
    store.db.prepare("UPDATE knowledge_documents SET source_locator=? WHERE id=?").run("product-doc:C:\\private\\guide.md",id);
    store.db.prepare("UPDATE knowledge_product_documents SET source_path=? WHERE id=?").run("C:\\private\\guide.md",id);
    const sanitized=await readPublicProduct(store,{documentId:id});assert.equal(sanitized.sourcePath,"guide.md");assert.equal(sanitized.sourceLocator,"product-doc:guide.md");
    await assert.rejects(readPublicProduct(store,{documentId:id,chunkId:"another:chunk:0"}),/chunk/i);
    store.db.prepare("UPDATE knowledge_product_classifications SET classification='project' WHERE document_id=?").run(id);
    assert.equal((await searchPublicProductChunks(store,{query:"Calibration"})).references.length,0);
    await assert.rejects(readPublicProduct(store,{documentId:id}),/access denied/i);
  } finally {close();}
});

test("imports with the same source name cannot deprecate or merge documents from other access scopes",async()=>{
  const {root,store,close}=fixture();
  try {
    const publicDir=join(root,"public"),projectDir=join(root,"project");mkdirSync(publicDir);mkdirSync(projectDir);
    writeFileSync(join(publicDir,"guide.md"),"# Guide\n\nPublic version.");
    writeFileSync(join(projectDir,"guide.md"),"# Guide\n\nPrivate project version.");
    const publicId=importKnowledgeProducts(store,{root:publicDir,sampleManagerVersion:"21",classification:"product"}).documents[0];
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product','now')").run(publicId);
    const projectOne=importKnowledgeProducts(store,{root:projectDir,sampleManagerVersion:"21",classification:"project",sourceProjectId:"1"}).documents[0];
    store.db.prepare("UPDATE knowledge_documents SET project_id='1' WHERE id=?").run(projectOne);
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'project','now')").run(projectOne);
    const projectTwo=importKnowledgeProducts(store,{root:projectDir,sampleManagerVersion:"21",classification:"project",sourceProjectId:"2"}).documents[0];
    assert.notEqual(projectOne,projectTwo);
    assert.equal(store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id=?").get(publicId).lifecycle,"approved");
    assert.equal(store.db.prepare("SELECT lifecycle FROM knowledge_documents WHERE id=?").get(projectOne).lifecycle,"approved");
    const found=await searchPublicProductChunks(store,{query:"Public"});assert.ok(found.references.some(ref=>ref.documentId===publicId));
  } finally {close();}
});

test("submissions are idempotent and visible in search only after explicit administrator review", () => {
  const {store,close}=fixture();
  try {
    let general=true;
    const author=access(7,["1"],()=>general), admin=access(99,[],()=>false,true), other=access(8,["2"],()=>true);
    const input={idempotencyKey:"candidate-one",requestedScope:"project" as const,projectId:"1",title:"Reconnect after reset",memoryType:"Fact" as const,statement:"Restart the connection after a reset.",objective:"Restore access",unknowns:["Other versions"],sourceRefs:["Project 1: diagnostic note"]};
    const first=submitMemory(store,author,input), duplicate=submitMemory(store,author,input);
    assert.equal(first.id,duplicate.id); assert.equal(first.status,"pending");
    assert.deepEqual(first.evidenceRefs, []);
    assert.equal(getMemorySubmission(store,author,first.id).status,"pending");
    assert.equal(getMemorySubmission(store,admin,first.id).status,"pending");
    assert.throws(()=>getMemorySubmission(store,other,first.id),/not found/);
    assert.throws(()=>getMemorySubmission(store,access(7,[],()=>true),first.id),/denied/);
    assert.throws(()=>submitMemory(store,author,{...input,statement:"different"}),/Idempotency/);
    assert.equal(searchConfirmedMemories(store,author,{projectId:"1",scope:"project"}).page.total,0);
    assert.throws(()=>reviewMemorySubmission(store,author,{id:first.id,action:"approve",reason:"reviewed"}),/Administrator/);
    const reviewed=reviewMemorySubmission(store,admin,{id:first.id,action:"approve",scope:"general",reason:"Reviewed and generalized",statement:"Reconnect after a reset."});
    assert.equal(reviewed.status,"approved"); assert.ok(reviewed.memoryId);
    const generalMemory=getConfirmedMemory(store,other,String(reviewed.memoryId));
    assert.equal(generalMemory.memoryScope,"general"); assert.equal(generalMemory.sourceProjectId,undefined); assert.deepEqual(generalMemory.evidenceRefs,[]);
    assert.equal(generalMemory.source.sourceRefs,undefined);
    assert.deepEqual(getConfirmedMemory(store,author,String(reviewed.memoryId)).source.sourceRefs,["Project 1: diagnostic note"]);
    general=false;
    assert.throws(()=>getConfirmedMemory(store,author,String(reviewed.memoryId)),/denied/);
    const combined=searchConfirmedMemories(store,author,{scope:"both",projectId:"1"}); assert.equal(combined.generalAccess,"denied");
    assert.throws(()=>searchConfirmedMemories(store,author,{scope:"project",projectId:"2"}),/denied/);
  } finally {close();}
});

test("historical confirmed Memory search matches before pagination", () => {
  const {store,close}=fixture();
  try {
    const insert=store.db.prepare(`INSERT INTO knowledge_confirmed_memories(id,memory_type,title,statement,details_json,project_id,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at,memory_scope) VALUES (?,'Fact',?,?,'{}','1','{}','[]','{}',1,?,'{}','confirmed',?,?,'project')`);
    const now=new Date().toISOString();
    store.db.transaction(()=>{for(let i=0;i<120;i++) insert.run(`mem-${i}`,i===0?"unique historic term":`recent ${i}`,"observation",new Date(Date.UTC(2025,0,1,0,0,i)).toISOString(),now,now);})();
    const result=searchConfirmedMemories(store,access(1,["1"],()=>false),{scope:"project",projectId:"1",query:"unique historic",limit:10});
    assert.equal(result.page.total,1); assert.equal(result.results[0].id,"mem-0");
  } finally {close();}
});

test("review decisions are visible to submitters and do not publish rejected or incomplete candidates", () => {
  const {store,close}=fixture();
  try {
    const author=access(7,[],()=>true), admin=access(99,[],()=>false,true);
    for (const action of ["needs_info","reject"] as const) {
      const candidate=submitMemory(store,author,{idempotencyKey:`review-${action}`,requestedScope:"general",title:"Experience",memoryType:"Fact",statement:"Unverified experience"});
      const result=reviewMemorySubmission(store,admin,{id:candidate.id,action,reason:"Further review"});
      assert.equal(result.status,action === "reject" ? "rejected" : "needs_info");
      const visible=getMemorySubmission(store,author,candidate.id);
      assert.equal(visible.reviewerId,99); assert.ok(visible.reviewedAt); assert.equal(visible.reviewReason,"Further review");
      assert.equal(visible.memoryId,undefined);
    }
    assert.equal(searchConfirmedMemories(store,author,{}).page.total,0);
  } finally {close();}
});

test("Memory defaults combine the selected project with general records and paginate confirmed results", () => {
  const {store,close}=fixture();
  try {
    const author=access(7,["1"],()=>true), admin=access(99,[],()=>false,true);
    for (const [scope,projectId] of [["project","1"],["general",undefined]] as const) {
      const submitted=submitMemory(store,author,{idempotencyKey:`scope-${scope}`,requestedScope:scope,projectId,title:`${scope} experience`,memoryType:"Fact",statement:"Confirmed experience"});
      reviewMemorySubmission(store,admin,{id:submitted.id,action:"approve",reason:"Reviewed"});
    }
    const selected=searchConfirmedMemories(store,author,{projectId:"1"});
    assert.equal(selected.scope,"both"); assert.equal(selected.page.total,2);
    assert.deepEqual(new Set(selected.results.map(item=>item.memoryScope)),new Set(["project","general"]));
    const unselected=searchConfirmedMemories(store,author,{});
    assert.equal(unselected.scope,"general"); assert.equal(unselected.page.total,1);
    const next=searchConfirmedMemories(store,author,{projectId:"1",limit:1,offset:1});
    assert.equal(next.results.length,1); assert.equal(next.page.total,2); assert.equal(next.page.offset,1);
    assert.throws(()=>searchConfirmedMemories(store,access(7,["1"],()=>false),{scope:"general"}),/denied/);
  } finally {close();}
});

test("global Wiki cannot expose unclassified project sources",()=>{
  const {root,store,close}=fixture();
  try {
    const docs=join(root,"docs"); mkdirSync(docs); writeFileSync(join(docs,"guide.md"),"# Manual\n\nPrivate source text.");
    const id=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:"21"}).documents[0];
    store.db.prepare("UPDATE knowledge_documents SET project_id='1' WHERE id=?").run(id);
    const row={id:"page-not-stored",project_id:null,source_refs_json:JSON.stringify([id])};
    assert.equal(wikiPageVisible(store,row,true),false);
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product',?)").run(id,new Date().toISOString());
    assert.equal(wikiPageVisible(store,row,true),true); assert.equal(wikiPageVisible(store,row,false),false);
  } finally {close();}
});

test("Wiki revisions require their own verified source scope",()=>{
  const {root,store,close}=fixture();
  try {
    const docs=join(root,"docs");mkdirSync(docs);writeFileSync(join(docs,"public.md"),"# Public\n\nPublic text.");writeFileSync(join(docs,"private.md"),"# Private\n\nProject text.");
    const [first,second]=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:"21"}).documents;
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,'product','now'),(?,'project','now')").run(first,second);
    store.db.prepare("UPDATE knowledge_documents SET project_id='1' WHERE id=?").run(second);
    store.db.prepare("INSERT INTO knowledge_wiki_pages(id,page_key,title,body,status,source_refs_json,current_revision,created_by,created_at,updated_at) VALUES ('page','page','Page','public','published',?,2,1,'now','now')").run(JSON.stringify([first]));
    store.db.prepare("INSERT INTO knowledge_wiki_revision_sources(page_id,revision,source_refs_json) VALUES ('page',1,?),('page',2,?)").run(JSON.stringify([second]),JSON.stringify([first]));
    assert.equal(wikiRevisionVisible(store,"page",1,true),false);
    assert.equal(wikiRevisionVisible(store,"page",2,true),true);
    assert.equal(wikiRevisionVisible(store,"page",3,true),false);
    store.db.prepare("UPDATE knowledge_product_classifications SET classification='product' WHERE document_id=?").run(second);
    assert.equal(wikiRevisionVisible(store,"page",1,true),true);
  } finally {close();}
});

test("hosted product search validates each chunk, publication changes, and engine errors",async()=>{
  const {store,close}=fixture();
  try {
    const now=new Date().toISOString();
    store.db.prepare("INSERT INTO knowledge_integration_settings(key,value,updated_at) VALUES ('product_provider','weknora',?)").run(now);
    store.db.prepare("INSERT INTO knowledge_weknora_documents(id,external_document_id,external_knowledge_base_id,external_chunk_ids_json,title,normalized_content_sha256,parser_version,product_version,source_path,status,idempotency_key,created_at,updated_at,upstream_verified_at,upstream_parse_status) VALUES (?,?,?,?,?,?,?,?,?,'published',?,?,?,?,?)")
      .run('mapped','external','kb',JSON.stringify(['chunk-1','chunk-2']),'Verified title','digest','v1','21.3','manual.html','mapped',now,now,now,'completed');
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES ('mapped','product',?)").run(now);
    const refs=['chunk-1','chunk-2'].map(chunkId=>({provider:'weknora',documentId:'external',chunkId,title:'untrusted title',sourcePath:'private/path',snippet:'untrusted',retrievalRunId:'r'}));
    const control={knowledgeBaseId:'kb',client:{
      requestJson:async()=>({}), search:async()=>({retrievalRunId:'r',references:refs}),
      getChunk:async (id:string)=>({chunkId:id,documentId:'external',content:`verified ${id}`,seq:0,isEnabled:true,indexStatus:'ready',sourceLocators:[{type:'pdf',page:3}]}),
      readDocument:async()=>({documentId:'external',parseStatus:'completed',content:'verified document',chunks:[{documentId:'external',chunkId:'chunk-1',content:'verified chunk',seq:0}]}),
    }} as any;
    const found=await searchPublicProductChunks(store,{query:'calibration',productVersion:'21.3'},control);
    assert.equal(found.references.length,2);assert.equal(found.references[0].title,'Verified title');assert.equal(found.references[0].sourcePath,'manual.html');assert.equal(found.references[0].snippet,'verified chunk-1');
    assert.equal((await readPublicProduct(store,{documentId:'mapped',chunkId:'chunk-1'},control)).body,'verified chunk-1');
    await assert.rejects(readPublicProduct(store,{documentId:'mapped',chunkId:'foreign'},control),/chunk/i);
    control.client.getChunk=async()=>({chunkId:'wrong',documentId:'external',content:'forged',seq:0});
    await assert.rejects(searchPublicProductChunks(store,{query:'calibration'},control),/invalid chunk/i);
    control.client.getChunk=async(id:string)=>{store.db.prepare("UPDATE knowledge_weknora_documents SET external_chunk_ids_json='[]' WHERE id='mapped'").run();return {chunkId:id,documentId:'external',content:'old',seq:0};};
    await assert.rejects(searchPublicProductChunks(store,{query:'calibration'},control),/publication changed/i);
    store.db.prepare("UPDATE knowledge_weknora_documents SET external_chunk_ids_json=? WHERE id='mapped'").run(JSON.stringify(['chunk-1','chunk-2']));
    control.client.search=async()=>{throw new Error('private upstream password');};
    await assert.rejects(searchPublicProductChunks(store,{query:'calibration'},control),(error:Error)=>/engine.*unavailable/i.test(error.message)&&!error.message.includes('password'));
    store.db.prepare("UPDATE knowledge_product_classifications SET classification='pending' WHERE document_id='mapped'").run();
    control.client.requestJson=async()=>{throw new Error('private upstream password');};
    await assert.rejects(searchPublicProductChunks(store,{query:'calibration'},control),(error:Error)=>/engine.*unavailable/i.test(error.message)&&!error.message.includes('password'));
  } finally {close();}
});

test("routine and failed tool events never create candidates or call inference",async()=>{
  const {store,close}=fixture();
  try {
    for(let i=0;i<3;i++) store.append({id:`event-${i}`,type:"job.finished",occurredAt:new Date().toISOString(),projectId:"1",jobId:`job-${i}`,payload:i===2 ? {status:"failed",error:"connection failed",log:"connection failed"} : {status:"succeeded",stdout:"routine output"}});
    let calls=0;
    await captureKnowledgeCandidates(store,"knowledge-capture",20,undefined,{inference:async()=>{calls++;return "unused";}});
    assert.equal(calls,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_memory_submissions").get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM relay_domain_events").get().n,3);
    assert.ok(Number(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_observations").get().n)>0);
  } finally {close();}
});

test("administrator can review a historical candidate without receiving its project ACL",()=>{
  const {store,close}=fixture();
  try {
    const now=new Date().toISOString();
    store.upsertDocument({id:"legacy-candidate",kind:"candidate",title:"Old candidate",body:"Old diagnostic material",lifecycle:"draft",projectId:"1",locator:"event:historical",createdAt:now,updatedAt:now});
    const admin=access(99,[],()=>false,true), owner=access(7,["1"],()=>false);
    assert.equal(listLegacyCandidatesForReview(store,admin).length,1);
    assert.throws(()=>reviewLegacyCandidate(store,owner,{id:"legacy-candidate",action:"reject",reason:"reviewed"}),/Administrator/);
    const reviewed=reviewLegacyCandidate(store,admin,{id:"legacy-candidate",action:"approve",reason:"Manually checked",scope:"project",title:"Reviewed fix",statement:"Restart the service after reset.",memoryType:"Fact"});
    assert.ok(reviewed.memoryId); assert.equal(store.canRead(99,"1"),false);
    const found=searchConfirmedMemories(store,owner,{scope:"project",projectId:"1",query:"restart"});
    assert.equal(found.results[0].source.kind,"legacy");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_legacy_candidate_reviews").get().n,1);
    assert.throws(()=>reviewLegacyCandidate(store,admin,{id:"legacy-candidate",action:"approve",reason:"twice",scope:"project",title:"A",statement:"B"}),/already/);
  } finally {close();}
});

test("migration retains project Memory and quarantines historical global records and project-source documents",()=>{
  const root=mkdtempSync(join(tmpdir(),"knowledge-migration-v2-")), options={dbPath:join(root,"knowledge.db"),appDbPath:join(root,"app.db")};
  let store=new KnowledgeStore(options);
  try {
    const docs=join(root,"docs");mkdirSync(docs);writeFileSync(join(docs,"old.md"),"# Old\n\nHistorical project material.");
    const id=importKnowledgeProducts(store,{root:docs,sampleManagerVersion:"21"}).documents[0];
    store.db.prepare("UPDATE knowledge_scope_bindings SET source_project_id='1' WHERE document_id=?").run(id);
    // Old Wiki pages can contain section citations absent from source_refs_json.
    store.db.prepare("INSERT INTO knowledge_wiki_pages(id,page_key,title,body,status,source_refs_json,current_revision,created_by,created_at,updated_at) VALUES ('old-wiki','old-wiki','Old Wiki','Private historical text','published','[]',1,1,'now','now')").run();
    store.db.prepare("INSERT INTO knowledge_wiki_sections(id,page_id,section_key,section_kind,title,body,created_at,updated_at) VALUES ('old-section','old-wiki','main','common','Main','Private text','now','now')").run();
    store.db.prepare("INSERT INTO knowledge_wiki_section_citations(id,section_id,document_id,created_at) VALUES ('old-citation','old-section',?,'now')").run(id);
    store.db.pragma("foreign_keys=OFF");
    store.db.exec(`DROP TRIGGER IF EXISTS knowledge_wiki_revision_sources_insert; DROP TABLE knowledge_wiki_revision_sources; DROP TRIGGER IF EXISTS knowledge_product_chunk_fts_delete; DROP TABLE knowledge_product_chunk_fts; DROP TABLE knowledge_memory_scope_reviews; DROP TABLE knowledge_legacy_candidate_reviews; DROP TABLE knowledge_memory_submissions; DROP TABLE knowledge_product_classifications; DROP TABLE knowledge_confirmed_memories; ${CONFIRMED_MEMORY_MIGRATION.sql} DELETE FROM schema_migrations WHERE version='055-knowledge-access';`);
    const insert=store.db.prepare(`INSERT INTO knowledge_confirmed_memories(id,memory_type,title,statement,details_json,project_id,scope_json,evidence_refs_json,source_json,confirmed_by,confirmed_at,audit_json,status,created_at,updated_at) VALUES(?,'Fact',?,?,?,'1',?,'[]',?,1,?,?,'confirmed',?,?)`);
    const now=new Date().toISOString();
    for(const [memoryId,visibility] of [["project-old","project"],["global-old","global"]]) insert.run(memoryId,memoryId,"legacy statement",JSON.stringify({subject:memoryId,value:"legacy statement"}),JSON.stringify({projectId:"1",scopeType:"project",scopeKey:"1",visibility}),JSON.stringify({kind:"legacy",locator:"old"}),now,JSON.stringify({action:"manual",reason:"old"}),now,now);
    store.close();store=new KnowledgeStore(options);
    const migrated=store.db.prepare("SELECT id,memory_scope FROM knowledge_confirmed_memories ORDER BY id").all() as Array<{id:string;memory_scope:string}>;
    assert.deepEqual(migrated,[{id:"global-old",memory_scope:"review"},{id:"project-old",memory_scope:"project"}]);
    assert.equal(store.db.prepare("SELECT 1 FROM knowledge_product_classifications WHERE document_id=?").get(id),undefined);
    const snapshot=store.db.prepare("SELECT source_refs_json FROM knowledge_wiki_revision_sources WHERE page_id='old-wiki' AND revision=1").get() as {source_refs_json:string};
    assert.deepEqual(JSON.parse(snapshot.source_refs_json),[id]);
    store.db.prepare("DELETE FROM knowledge_wiki_section_citations WHERE id='old-citation'").run();
    assert.equal(wikiRevisionVisible(store,"old-wiki",1,true),false,"removing a current citation must not widen an old revision");
    store.migrate(); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_confirmed_memories").get().n,2);
    const admin=access(99,[],()=>false,true);reviewLegacyMemoryScope(store,admin,{id:"global-old",scope:"general",reason:"Generalized",title:"General fix",statement:"Reviewed generalized statement"});
    const memory=getConfirmedMemory(store,access(2,[],()=>true),"global-old");assert.equal(memory.memoryScope,"general");assert.equal(memory.sourceProjectId,undefined);
    const history=store.db.prepare("SELECT previous_title,previous_statement,previous_details_json FROM knowledge_memory_scope_reviews WHERE memory_id=?").get("global-old") as Record<string,unknown>;
    assert.equal(history.previous_title,"global-old");assert.match(String(history.previous_details_json),/legacy statement/);
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

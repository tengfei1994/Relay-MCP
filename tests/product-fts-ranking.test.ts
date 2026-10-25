import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore,type KnowledgeStore} from "../src/knowledge/store.ts";
import {searchKnowledgeProducts} from "../src/knowledge/knowledge-products.ts";
import {searchProductBackend} from "../src/knowledge/product-backend.ts";

function add(store:KnowledgeStore,id:string,chunks:string[],extra:{project?:string;environment?:string;version?:string;module?:string;lifecycle?:string;updated?:string}={}){
  const now="2026-10-25T00:00:00.000Z";
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,environment,samplemanager_version,module,source_locator,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,"product_document","Guide "+id,chunks.join("\n"),extra.lifecycle??"approved",extra.project??null,extra.environment??null,extra.version??"21.3",extra.module??"Workflow",id+".md",now,extra.updated??now);
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,source_path,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(id,id,"guide",id+".md",extra.version??"21.3",now,now);
  chunks.forEach((content,ordinal)=>{
    store.db.prepare("INSERT INTO knowledge_chunks(id,document_id,ordinal,content,content_sha256) VALUES(?,?,?,?,?)").run(id+ordinal,id,ordinal,content,"fixture");
    store.db.prepare("INSERT INTO knowledge_fts(document_id,title,body) VALUES(?,?,?)").run(id,"Guide "+id,content);
  });
}
async function fixture(run:(store:KnowledgeStore)=>void|Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),"product-fts-")),store=createKnowledgeStore({dbPath:join(dir,"knowledge.db")});
  try{await run(store);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

test("Product FTS ranks each document by its best actual chunk and returns that chunk's snippet",()=>fixture(store=>{
  add(store,"strong",["needle "+"filler ".repeat(100),"best passage needle needle needle needle needle"]);
  add(store,"weak",["needle "+"filler ".repeat(150)],{updated:"2026-10-26T00:00:00.000Z"});
  add(store,"middle",["middle passage needle "+"filler ".repeat(10)]);
  add(store,"substring",["needlework needlework"],{updated:"2026-10-27T00:00:00.000Z"});
  const raw=store.db.prepare("SELECT document_id,snippet(knowledge_fts,2,'<mark>','</mark>','…',36) AS snippet,bm25(knowledge_fts) AS rank FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank,rowid").all('"needle"') as Array<{document_id:string;snippet:string;rank:number}>;
  const best=[...new Map(raw.map(row=>row.document_id).map(id=>[id,raw.find(row=>row.document_id===id)!])).values()];
  assert.equal(best[0].document_id,"strong");assert.match(best[0].snippet,/best passage/);
  const actual=searchKnowledgeProducts(store,{query:"needle",limit:2});
  assert.deepEqual(actual.map(row=>row.id),best.slice(0,2).map(row=>row.document_id));
  for(const [index,row] of actual.entries()){
    assert.equal(row.rank,best[index].rank);assert.ok(Number(row.rank)<0,"a zero rank indicates the unintended LIKE fallback");
    assert.equal(row.snippet,best[index].snippet);assert.equal(row.summary,best[index].snippet);
  }
  assert.equal(new Set(actual.map(row=>row.id)).size,2);
  assert.deepEqual(searchKnowledgeProducts(store,{query:"needle",limit:1}).map(row=>row.id),["strong"]);
}));

test("FTS filters version/module/deprecation before applying the document limit",()=>fixture(store=>{
  add(store,"old-version",["needle needle needle"],{version:"21.1"});
  add(store,"other-module",["needle needle needle"],{module:"Admin"});
  add(store,"deprecated",["needle needle needle"],{lifecycle:"deprecated"});
  add(store,"visible",["visible needle "+"filler ".repeat(30)]);
  const actual=searchKnowledgeProducts(store,{query:"needle",sampleManagerVersion:"21.3",module:"Workflow",limit:1});
  assert.deepEqual(actual.map(row=>row.id),["visible"]);assert.ok(Number(actual[0].rank)<0);
  const history=searchKnowledgeProducts(store,{query:"needle",sampleManagerVersion:"21.3",module:"Workflow",includeDeprecated:true});
  assert.deepEqual(new Set(history.map(row=>row.id)),new Set(["deprecated","visible"]));
}));

test("local Product FTS keeps project/environment ACL filtering and authorized result limits",()=>fixture(async store=>{
  store.grantAcl("p1",7,true);store.grantAcl("p2",8,true);
  add(store,"foreign",["needle needle needle"],{project:"p2",environment:"dev"});
  add(store,"production",["needle needle needle"],{project:"p1",environment:"prod"});
  add(store,"mine",["private needle needle","other needle "+"filler ".repeat(30)],{project:"p1",environment:"dev"});
  add(store,"global",["public needle "+"filler ".repeat(60)]);
  const actual=await searchProductBackend(store,{userId:7,projectId:"p1",environment:"dev",query:"needle",limit:2});
  assert.deepEqual(actual.map(row=>row.id),["mine","global"]);assert.ok(actual.every(row=>Number(row.rank)<0));
  assert.deepEqual((await searchProductBackend(store,{userId:7,projectId:"p1",environment:"dev",query:"needle",limit:1})).map(row=>row.id),["mine"]);
  await assert.rejects(searchProductBackend(store,{userId:8,projectId:"p1",environment:"dev",query:"needle"}),/denied/);
}));

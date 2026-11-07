import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("product catalogs contain reviewed public sources and paginate independently of Project access",async()=>{
  const root=mkdtempSync(join(tmpdir(),"product-catalog-http-")),keys=["DB_PATH","KNOWLEDGE_DB_PATH"] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));process.env.DB_PATH=join(root,"app.db");process.env.KNOWLEDGE_DB_PATH=join(root,"knowledge.db");
  const {default:Fastify}=await import("fastify"),{db,runMigrations}=await import("../src/server/db/index.js"),{users}=await import("../src/server/db/schema.js"),{knowledgeRoutes}=await import("../src/server/routes/knowledge.js"),{getKnowledgeStore}=await import("../src/server/knowledge-context.js");
  runMigrations();db.insert(users).values([{id:7,username:"reader",passwordHash:"unused",knowledgeEnabled:true},{id:8,username:"no-access",passwordHash:"unused",knowledgeEnabled:false}]).run();
  const store=getKnowledgeStore(),now="2026-10-25T00:00:00Z";
  store.db.prepare("INSERT INTO knowledge_topics(id,canonical_key,canonical_title,created_at,updated_at) VALUES ('manual','manual','Manual',?,?)").run(now,now);
  const add=(id:string,classification:string,project:string|null)=>{
    store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,project_id,source_locator,created_at,updated_at) VALUES (?,'product_document',?,'body','approved',?,?,?,?)").run(id,id,project,`${id}.md`,now,now);
    store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,language,source_path,source_sha256,version,created_at,updated_at) VALUES (?,?,'guide','en',?,'sha',?,?,?)").run(id,`family-${id}`,`${id}.md`,id,now,now);
    store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product_version,source_path,status,created_at,updated_at) VALUES (?,'manual',?,?,?,'active',?,?)").run(`binding-${id}`,id,id,`${id}.md`,now,now);
    store.db.prepare("INSERT INTO knowledge_product_classifications(document_id,classification,updated_at) VALUES (?,?,?)").run(id,classification,now);
  };
  store.db.transaction(()=>{for(let i=0;i<105;i++)add(`public-${String(i).padStart(3,"0")}`,"product",null);add("private-project","project","99");})();
  const app=Fastify();app.decorate("authenticate",async(req:any)=>{req.user={id:Number(req.headers["x-user"] ?? 7),isAdmin:false};});await app.register(knowledgeRoutes);
  try {
    const first=await app.inject({url:"/api/knowledge/product-documents/versions?limit=100&offset=0"});assert.equal(first.statusCode,200);assert.equal(first.json().page.total,105);assert.equal(first.json().versions.length,100);
    const last=await app.inject({url:"/api/knowledge/product-documents/versions?limit=100&offset=100"});assert.equal(last.statusCode,200);assert.equal(last.json().versions.length,5);assert.ok(!last.body.includes("private-project"));
    const topics=await app.inject({url:"/api/knowledge/product-topics"});assert.equal(topics.statusCode,200);assert.equal(topics.json().topics[0].revisionCount,105);assert.equal(topics.json().topics[0].versions.length,100);assert.equal(topics.json().topics[0].versionsTruncated,true);
    const detail=await app.inject({url:"/api/knowledge/product-topics/manual?limit=100&offset=100"});assert.equal(detail.statusCode,200);assert.equal(detail.json().page.total,105);assert.equal(detail.json().versions.length,5);assert.ok(!detail.body.includes("private-project"));
    assert.equal((await app.inject({url:"/api/knowledge/product-topics",headers:{"x-user":"8"}})).statusCode,403);
    assert.equal((await app.inject({url:"/api/knowledge/product-documents/private-project"})).statusCode,404);
  } finally {await app.close();store.close();(db as any).session.client.close();for(const key of keys)previous[key]===undefined ? delete process.env[key] : process.env[key]=previous[key];rmSync(root,{recursive:true,force:true});}
});

import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createKnowledgeStore} from "../src/knowledge/store.ts";
import {importKnowledgeProducts} from "../src/knowledge/knowledge-products.ts";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function fixture(fn:(store:ReturnType<typeof createKnowledgeStore>,source:string)=>void){
 const root=mkdtempSync(join(tmpdir(),"product-parser-version-")),source=join(root,"docs");mkdirSync(source);
 const store=createKnowledgeStore({dbPath:join(root,"knowledge.db")});
 try{fn(store,source);}finally{store.close();rmSync(root,{recursive:true,force:true});}
}
test("HTML parser upgrade creates a new source identity while retaining old body/revision and URLs",()=>fixture((store,source)=>{
 const html='<html><body><h1>Guide</h1><p>Read <a href="next.htm#part">next</a>.</p></body></html>',raw=sha(html),oldId='product-document-'+sha(["guide","21.3","guide.htm",raw].join("\0")).slice(0,32);
 writeFileSync(join(source,"guide.htm"),html);
 const oldBody='# Guide\n\nRead next.',oldRevision='legacy-revision';
 store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,samplemanager_version,source_locator,source_sha256,created_at,updated_at) VALUES(?,'product_document','Guide',?,'approved','21.3','product-doc:guide.htm',?,'then','then')").run(oldId,oldBody,raw);
 store.db.prepare("INSERT INTO knowledge_product_revisions(id,normalized_content_sha256,raw_sha256,title,body,parser_version,created_at,updated_at) VALUES(?,?,?,'Guide',?,'html-2','then','then')").run(oldRevision,sha(oldBody.toLowerCase().replace(/\s+/g,' ')),raw,oldBody);
 store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,source_path,source_sha256,version,metadata_json,revision_id,created_at,updated_at) VALUES(?,'guide','guide','guide.htm',?,'21.3',?,?,'then','then')").run(oldId,raw,JSON.stringify({parserVersion:'html-2'}),oldRevision);
 const options={root:source,sampleManagerVersion:'21.3',documentFamilyId:'guide'};
 const first=importKnowledgeProducts(store,options);
 assert.equal(first.updated,1);assert.notEqual(first.documents[0],oldId);
 const old=store.db.prepare("SELECT d.body,d.lifecycle,p.revision_id FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id WHERE d.id=?").get(oldId) as any;
 assert.equal(old.body,oldBody);assert.equal(old.revision_id,oldRevision);assert.equal(old.lifecycle,'deprecated');
 const current=store.db.prepare("SELECT metadata_json FROM knowledge_product_documents WHERE id=?").get(first.documents[0]) as any;
 assert.equal(JSON.parse(current.metadata_json).parserVersion,'html-3');
 const count=(store.db.prepare('SELECT COUNT(*) n FROM knowledge_product_revisions').get() as any).n;
 const replay=importKnowledgeProducts(store,options);assert.equal(replay.unchanged,1);assert.deepEqual(replay.documents,first.documents);
 assert.equal((store.db.prepare('SELECT COUNT(*) n FROM knowledge_product_revisions').get() as any).n,count);
}));
test("case and code whitespace are part of immutable revision identity",()=>fixture((store,source)=>{
 const path=join(source,'guide.md');writeFileSync(path,'# Code\n\n```csharp\nvar Name = "A B";\n```');
 const a=importKnowledgeProducts(store,{root:source,sampleManagerVersion:'21.1',documentFamilyId:'code'});
 writeFileSync(path,'# Code\n\n```csharp\nvar name = "a  b";\n```');
 const b=importKnowledgeProducts(store,{root:source,sampleManagerVersion:'21.3',documentFamilyId:'code'});
 const revisions=[a,b].map(r=>(store.db.prepare('SELECT revision_id FROM knowledge_product_documents WHERE id=?').get(r.documents[0]) as any).revision_id);
 assert.notEqual(revisions[0],revisions[1]);
 for(const report of [a,b]){const row=store.db.prepare('SELECT d.body,r.body revisionBody FROM knowledge_documents d JOIN knowledge_product_documents p ON p.id=d.id JOIN knowledge_product_revisions r ON r.id=p.revision_id WHERE d.id=?').get(report.documents[0]) as any;assert.equal(row.body,row.revisionBody);}
}));
test("source anchors bind sections and code headings do not become document sections",()=>fixture((store,source)=>{
 writeFileSync(join(source,'guide.md'),'# Guide\n\n```text\n# This is source code\n```\n\n<a id="Original_Anchor"></a>\n## Setup\nDo a thing.');
 const r=importKnowledgeProducts(store,{root:source,sampleManagerVersion:'21.3'});
 const row=store.db.prepare('SELECT sections_json FROM knowledge_product_documents WHERE id=?').get(r.documents[0]) as any;
 const sections=JSON.parse(row.sections_json);assert.equal(sections.length,2);assert.equal(sections[1].anchor,'Original_Anchor');
}));

test("an existing parser-scoped revision keeps its persisted identity during import",()=>fixture((store,source)=>{
 const body='# Restored\n\nExact source content.',revisionId='restored-revision-custom-id';
 writeFileSync(join(source,'restored.md'),body);
 store.db.prepare("INSERT INTO knowledge_product_revisions(id,normalized_content_sha256,title,body,parser_version,created_at,updated_at) VALUES(?,?,?,?,'html-3','then','then')").run(revisionId,sha(body),'Restored',body);
 const result=importKnowledgeProducts(store,{root:source,sampleManagerVersion:'21.3'});
 assert.equal(result.failed,0);assert.equal(result.imported,1);
 assert.equal((store.db.prepare('SELECT revision_id FROM knowledge_product_documents WHERE id=?').get(result.documents[0]) as any).revision_id,revisionId);
 assert.equal((store.db.prepare('SELECT COUNT(*) n FROM knowledge_product_revisions').get() as any).n,1);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));


function legacyTopicFixture(store:ReturnType<typeof createKnowledgeStore>,source:string){
 const html='<html><body><h1>Guide</h1><p>Read <a href="next.htm#part">next</a>.</p></body></html>',raw=sha(html),body='# Guide\n\nRead next.';
 writeFileSync(join(source,'guide.htm'),html);
 store.db.prepare("INSERT INTO knowledge_topics(id,canonical_key,canonical_title,kind,domain,metadata_json,created_at,updated_at) VALUES('curated-topic','product:guide','Guide','product_document','product','{\"reviewed\":true}','then','then')").run();
 store.db.prepare("INSERT INTO knowledge_product_revisions(id,normalized_content_sha256,raw_sha256,title,body,parser_version,created_at,updated_at) VALUES('retained-html2',?,?,'Guide',?,'html-2','then','then')").run(sha(body.toLowerCase().replace(/\s+/g,' ')),raw,body);
 const oldIds:Record<string,string>={};
 for(const version of ['21.1','21.3']){
  const id='product-document-'+sha(['guide',version,'guide.htm',raw].join('\0')).slice(0,32);oldIds[version]=id;
  store.db.prepare("INSERT INTO knowledge_documents(id,kind,title,body,lifecycle,samplemanager_version,source_locator,source_sha256,created_at,updated_at) VALUES(?,'product_document','Guide',?,'approved',?,'product-doc:guide.htm',?,'then','then')").run(id,body,version,raw);
  store.db.prepare("INSERT INTO knowledge_product_documents(id,document_family_id,document_type,source_path,source_sha256,version,metadata_json,revision_id,created_at,updated_at) VALUES(?,'guide','guide','guide.htm',?,?,?,'retained-html2','then','then')").run(id,raw,version,JSON.stringify({parserVersion:'html-2'}));
  store.db.prepare("INSERT INTO knowledge_product_document_bindings(id,topic_id,document_id,product,product_version,source_path,match_method,match_confidence,status,created_at,updated_at) VALUES(?,'curated-topic',?,'SampleManager',?,'guide.htm','reviewed',1,'active','then','then')").run('binding-'+version,id,version);
 }
 return {oldIds,body,html};
}

test('parser upgrade advances the occupied current topic binding while retaining history and other versions',()=>fixture((store,source)=>{
 const legacy=legacyTopicFixture(store,source);
 const binding=(version:string)=>store.db.prepare('SELECT * FROM knowledge_product_document_bindings WHERE product_version=?').get(version) as any;
 const otherBefore=binding('21.1'),before=binding('21.3');
 const revisionBefore=store.db.prepare("SELECT * FROM knowledge_product_revisions WHERE id='retained-html2'").get();
 const options={root:source,sampleManagerVersion:'21.3',product:'SampleManager',documentFamilyId:'guide'};
 const first=importKnowledgeProducts(store,options);assert.equal(first.failed,0);assert.equal(first.updated,1);
 const current=first.documents[0],after=binding('21.3');
 assert.notEqual(current,legacy.oldIds['21.3']);assert.equal(after.document_id,current);
 for(const key of ['id','topic_id','product','product_version','source_path','match_method','match_confidence','status','created_at'])assert.equal(after[key],before[key],key);
 assert.deepEqual(binding('21.1'),otherBefore);
 assert.deepEqual(store.db.prepare("SELECT * FROM knowledge_product_revisions WHERE id='retained-html2'").get(),revisionBefore);
 assert.deepEqual(store.db.prepare('SELECT body,lifecycle FROM knowledge_documents WHERE id=?').get(legacy.oldIds['21.3']),{body:legacy.body,lifecycle:'deprecated'});
 assert.equal((store.db.prepare('SELECT lifecycle FROM knowledge_documents WHERE id=?').get(legacy.oldIds['21.1']) as any).lifecycle,'approved');
 const counts=()=>['knowledge_documents','knowledge_product_revisions','knowledge_topics','knowledge_product_document_bindings'].map(t=>(store.db.prepare('SELECT COUNT(*) n FROM '+t).get() as any).n);
 const beforeReplay=counts();const replay=importKnowledgeProducts(store,options);assert.equal(replay.unchanged,1);assert.deepEqual(replay.documents,[current]);assert.deepEqual(counts(),beforeReplay);assert.deepEqual(binding('21.3'),after);assert.deepEqual(binding('21.1'),otherBefore);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('an unchanged html-3 replay repairs a binding left on the deprecated parser source',()=>fixture((store,source)=>{
 const legacy=legacyTopicFixture(store,source),options={root:source,sampleManagerVersion:'21.3',product:'SampleManager',documentFamilyId:'guide'};
 const first=importKnowledgeProducts(store,options);assert.equal(first.failed,0);
 // Persist the exact state produced by the pre-fix importer: new source exists,
 // old source is deprecated, but UNIQUE(topic,version) kept the old binding.
 store.db.prepare("UPDATE knowledge_product_document_bindings SET document_id=?,updated_at='then' WHERE id='binding-21.3'").run(legacy.oldIds['21.3']);
 const documentsBefore=store.db.prepare('SELECT id,body,lifecycle FROM knowledge_documents ORDER BY id').all();
 const replay=importKnowledgeProducts(store,options);assert.equal(replay.failed,0);assert.equal(replay.unchanged,1);
 assert.equal((store.db.prepare("SELECT document_id FROM knowledge_product_document_bindings WHERE id='binding-21.3'").get() as any).document_id,first.documents[0]);
 assert.deepEqual(store.db.prepare('SELECT id,body,lifecycle FROM knowledge_documents ORDER BY id').all(),documentsBefore);
 const repaired=store.db.prepare("SELECT * FROM knowledge_product_document_bindings WHERE id='binding-21.3'").get();
 importKnowledgeProducts(store,options);assert.deepEqual(store.db.prepare("SELECT * FROM knowledge_product_document_bindings WHERE id='binding-21.3'").get(),repaired);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('replaying a deprecated source never moves the current topic binding backward',()=>fixture((store,source)=>{
 const path=join(source,'guide.htm'),old='<h1>Guide</h1><p>original</p>',current='<h1>Guide</h1><p>current</p>',options={root:source,sampleManagerVersion:'21.3',documentFamilyId:'guide'};
 writeFileSync(path,old);const first=importKnowledgeProducts(store,options);
 writeFileSync(path,current);const second=importKnowledgeProducts(store,options);assert.equal(second.updated,1);
 assert.equal((store.db.prepare('SELECT document_id FROM knowledge_product_document_bindings WHERE product_version=?').get('21.3') as any).document_id,second.documents[0]);
 writeFileSync(path,old);const replay=importKnowledgeProducts(store,options);assert.equal(replay.unchanged,1);assert.deepEqual(replay.documents,first.documents);
 assert.equal((store.db.prepare('SELECT document_id FROM knowledge_product_document_bindings WHERE product_version=?').get('21.3') as any).document_id,second.documents[0]);
}));

test('an unrelated same-title source cannot take a reviewed topic version binding',()=>fixture((store,source)=>{
 const legacy=legacyTopicFixture(store,source);rmSync(join(source,'guide.htm'));
 writeFileSync(join(source,'unrelated.htm'),'<h1>Guide</h1><p>Unrelated same-title source.</p>');
 const before=store.db.prepare("SELECT * FROM knowledge_product_document_bindings WHERE id='binding-21.3'").get();
 const result=importKnowledgeProducts(store,{root:source,sampleManagerVersion:'21.3',documentFamilyId:'unrelated'});
 assert.equal(result.failed,0);assert.equal(result.imported,1);
 assert.deepEqual(store.db.prepare("SELECT * FROM knowledge_product_document_bindings WHERE id='binding-21.3'").get(),before);
 assert.equal((store.db.prepare('SELECT lifecycle FROM knowledge_documents WHERE id=?').get(legacy.oldIds['21.3']) as any).lifecycle,'approved');
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
}));

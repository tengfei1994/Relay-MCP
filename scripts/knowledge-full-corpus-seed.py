import argparse,datetime,hashlib,json,pathlib,sqlite3,sys
ROOT=pathlib.Path('/home/ftd/relay-knowledge-engine-nonprod')
EXPECTED='712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009'
def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def require(ok,code):
 if not ok: raise RuntimeError(code)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true')
 parser.add_argument('--manifest',default=str(ROOT/'runtime/full-213/manifest.jsonl'))
 parser.add_argument('--manifest-sha256',default=EXPECTED)
 parser.add_argument('--source-db',default=str(ROOT/'bulk/knowledge.db'))
 parser.add_argument('--target-db',default=str(ROOT/'relay/data/knowledge.db'))
 parser.add_argument('--environment',choices=['nonprod-full-213','nonprod-full-213-v3'],default='nonprod-full-213')
 args=parser.parse_args();environment=args.environment;expected=args.manifest_sha256
 require(sys.platform=='linux' and ROOT.resolve()==ROOT,'nonproduction_root_required')
 manifest=pathlib.Path(args.manifest);source_db=pathlib.Path(args.source_db);target_db=pathlib.Path(args.target_db)
 require(manifest.resolve().is_relative_to(ROOT) and source_db.resolve().is_relative_to(ROOT) and target_db.resolve().is_relative_to(ROOT),'source_outside_nonproduction_root')
 require(target_db.is_file() and source_db.is_file() and source_db.resolve()!=target_db.resolve(),'distinct_existing_databases_required')
 raw=manifest.read_bytes()
 require(hashlib.sha256(raw).hexdigest()==expected,'manifest_hash_changed')
 rows=[json.loads(x) for x in raw.decode().splitlines() if x]
 require(len(rows)==5372 and len({x['targetLocalId'] for x in rows})==5372,'corpus_count_invalid')
 bulk=sqlite3.connect('file:'+str(source_db)+'?mode=ro',uri=True);bulk.row_factory=sqlite3.Row
 target=sqlite3.connect(str(target_db));target.row_factory=sqlite3.Row
 target.execute('pragma busy_timeout=10000');target.execute('pragma foreign_keys=ON')
 require(target.execute("select count(*) from knowledge_ingest_jobs where status in ('queued','running')").fetchone()[0]==0,'ingest_jobs_active')
 longfile=ROOT/'runtime/full-213/long-page-budget.json';longbudget=json.loads(longfile.read_text()) if longfile.exists() else {}
 prepared=[];counts={'documents':0,'chunks':0,'bindings':0,'scopeBindings':0,'created':0,'existing':0,'unbudgeted':0}
 for m in rows:
  require(m['environment']==environment and m['projectId']=='1' and m['version']=='21.3','unexpected_scope')
  if environment.endswith('-v3'):require(m['sourceParserVersion']=='html-3','structured_parser_required')
  d=dict(bulk.execute('select * from knowledge_documents where id=?',(m['bulkSourceId'],)).fetchone());p=dict(bulk.execute('select * from knowledge_product_documents where id=?',(m['bulkSourceId'],)).fetchone())
  require(digest(d['body'])==m['bodySha256'] and p['source_sha256']==m['rawSha256'] and p['source_path']==m['sourcePath'],'source_identity_changed')
  require(digest(p['metadata_json'])==m['sourceMetadataSha256'] and digest(p['sections_json'])==m['sectionsSha256'],'source_structure_changed')
  b=m['preview'];budget=b.get('embeddingBatches') if b.get('status')=='ok' else None
  if budget is None and environment=='nonprod-full-213' and longbudget.get('bodySha256')==m['bodySha256']: budget=longbudget['embeddingBatches']
  if budget is None:counts['unbudgeted']+=1
  metadata=json.loads(p['metadata_json']);metadata['engineAcceptance']={'corpus':environment.removeprefix('nonprod-'),'manifestSha256':expected,'bodySha256':m['bodySha256'],'normalizedSha256':m['normalizedSha256'],'embeddingRequests':budget,'bulkSourceId':m['bulkSourceId']}
  d.update(id=m['targetLocalId'],project_id='1',environment=environment);p.update(id=m['targetLocalId'],metadata_json=json.dumps(metadata,separators=(',',':')))
  existing=target.execute('select body,project_id,environment from knowledge_documents where id=?',(d['id'],)).fetchone()
  if existing:require(digest(existing['body'])==m['bodySha256'] and existing['project_id']=='1' and existing['environment']==environment,'target_identity_conflict')
  counts['existing' if existing else 'created']+=1
  chunks=[dict(x) for x in bulk.execute('select * from knowledge_chunks where document_id=?',(m['bulkSourceId'],))]
  bindings=[dict(x) for x in bulk.execute('select * from knowledge_product_document_bindings where document_id=?',(m['bulkSourceId'],))]
  if environment.endswith('-v3'):
   # Topic/version bindings are globally unique in the existing catalog. An
   # acceptance projection must not rebind an older scope's immutable source.
   # Preserve the source identity explicitly and use a dedicated target catalog.
   metadata['engineAcceptance']['topicProjection']=[{'sourceTopicId':b['topic_id'],'targetTopicId':'topic-full213-'+digest(environment+'|'+b['topic_id'])[:32]} for b in bindings]
   p['metadata_json']=json.dumps(metadata,separators=(',',':'))
  scopes=[dict(x) for x in bulk.execute('select * from knowledge_scope_bindings where document_id=?',(m['bulkSourceId'],))]
  if environment.endswith('-v3'):
   require(p.get('revision_id') and len(scopes)==1,'revision_or_scope_binding_missing')
   require(all(s['scope_type']=='environment' and s['scope_key']==environment and s['visibility']=='project' and s['source_project_id']=='1' for s in scopes),'unsafe_source_scope')
  require(len(bindings)<=1,'multiple_topic_bindings_need_explicit_selection')
  counts['documents']+=1;counts['chunks']+=len(chunks);counts['bindings']+=len(bindings);counts['scopeBindings']+=len(scopes)
  prepared.append((m,d,p,chunks,bindings,scopes))
 if not args.apply: print(json.dumps({'dryRun':True,'manifestSha256':expected,'environment':environment,**counts}));return
 require(counts['unbudgeted']==0,'all_documents_require_embedding_forecast')
 backup=ROOT/'runtime/backups'/('full-seed-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'.db')
 dest=sqlite3.connect(backup);target.backup(dest);dest.close();backup.chmod(0o600)
 def insert(table,row,verify=()):
  old=target.execute('select * from '+table+' where id=?',(row['id'],)).fetchone()
  if old:
   require(all(old[k]==row[k] for k in verify),'existing_projection_conflict');return
  keys=list(row);target.execute('insert into '+table+' ('+','.join(keys)+') values ('+','.join('?' for _ in keys)+')',[row[k] for k in keys])
 with target:
  for m,d,p,chunks,bindings,scopes in prepared:
   insert('knowledge_documents',d,('body','environment','project_id'))
   if p.get('revision_id'):
    rev=bulk.execute('select * from knowledge_product_revisions where id=?',(p['revision_id'],)).fetchone();require(rev is not None,'revision_missing')
    persisted=target.execute('select * from knowledge_product_revisions where normalized_content_sha256=? and parser_version=?',(rev['normalized_content_sha256'],rev['parser_version'])).fetchone()
    if persisted:
     require(persisted['body']==rev['body'],'revision_content_conflict');p['revision_id']=persisted['id']
    else:insert('knowledge_product_revisions',dict(rev),('body','normalized_content_sha256','parser_version'))
   insert('knowledge_product_documents',p,('source_path','source_sha256','metadata_json','sections_json'))
   for chunk in chunks:
    chunk.update(id='chunk-full213-'+digest(chunk['id']+'|'+d['id'])[:32],document_id=d['id'])
    insert('knowledge_chunks',chunk,('document_id','content'))
   for scope in scopes:
    if environment=='nonprod-full-213':scope.update(scope_type='environment',scope_key=environment,visibility='project',source_project_id='1')
    scope.update(id='scope-full213-'+digest(scope['id']+'|'+d['id'])[:32],document_id=d['id'])
    insert('knowledge_scope_bindings',scope,('document_id','scope_type','scope_key','visibility','source_project_id'))
   for binding in bindings:
    topic=bulk.execute('select * from knowledge_topics where id=?',(binding['topic_id'],)).fetchone();require(topic is not None,'topic_missing');topic=dict(topic)
    if environment.endswith('-v3'):
     source_topic_id=topic['id'];source_key=topic['canonical_key']
     topic['id']='topic-full213-'+digest(environment+'|'+source_topic_id)[:32]
     topic['canonical_key']='acceptance:'+environment+':'+source_key
     topic_meta=json.loads(topic.get('metadata_json') or '{}');topic_meta['acceptanceSourceTopic']={'id':source_topic_id,'canonicalKey':source_key,'environment':environment};topic['metadata_json']=json.dumps(topic_meta,separators=(',',':'))
     binding['topic_id']=topic['id']
    insert('knowledge_topics',topic,('canonical_key','domain'))
    binding.update(id='binding-full213-'+digest(binding['id']+'|'+d['id'])[:32],document_id=d['id'])
    insert('knowledge_product_document_bindings',binding,('document_id','topic_id'))
  require(not target.execute('pragma foreign_key_check').fetchall(),'foreign_key_check_failed')
  require(target.execute('select count(*) from knowledge_documents where environment=?',(environment,)).fetchone()[0]==5372,'target_count_mismatch')
 print(json.dumps({'seeded':True,'manifestSha256':expected,'environment':environment,'backup':str(backup),**counts}))
if __name__=='__main__':
 try:main()
 except Exception as e:
  safe=str(e) if isinstance(e,RuntimeError) else 'seed_failed_no_private_diagnostics';print(json.dumps({'error':safe}),file=sys.stderr);sys.exit(1)

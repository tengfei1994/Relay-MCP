import copy, importlib.util, json, pathlib, unittest, sqlite3
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'scripts/knowledge-index-content-validate.py'
spec=importlib.util.spec_from_file_location('index_validator',SCRIPT);validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)

def fixture():
 text='normalized input';contents=['one\nline','two'];m={'targetLocalId':'local','sourcePath':'source.htm','rawSha256':'raw','normalizedSha256':validator.digest(text),'version':'21.3','environment':validator.ENVIRONMENT,'projectId':'1'}
 budget={'normalizedSha256':m['normalizedSha256'],'indexableChunks':2,'indexableChunkHashes':[validator.digest(x) for x in contents]}
 mapping={'external_document_id':'external','external_knowledge_base_id':validator.KB_ID,'external_chunk_ids_json':'["a","b"]','status':'staged','upstream_parse_status':'completed','upstream_verified_at':'date','project_id':'1','environment':validator.ENVIRONMENT,'source_path':'source.htm','raw_sha256':'raw','normalized_content_sha256':m['normalizedSha256'],'parser_version':validator.PARSER_VERSION,'product_version':'21.3','model_provenance_json':json.dumps(validator.PROVENANCE)}
 knowledge={'id':'external','knowledge_base_id':validator.KB_ID,'embedding_model_id':validator.MODEL_ID,'parse_status':'completed','enable_status':'enabled','deleted_at':None,'tenant_id':1}
 chunks=[{'id':identity,'knowledge_id':'external','knowledge_base_id':validator.KB_ID,'tenant_id':1,'content':content,'chunk_index':i,'chunk_type':'text','is_enabled':1,'index_status':'ready','deleted_at':None} for i,(identity,content) in enumerate(zip(['a','b'],contents))]
 embeds=[{'id':i+1,'chunk_id':chunk['id'],'source_id':chunk['id'],'knowledge_id':'external','knowledge_base_id':validator.KB_ID,'dimension':1024,'is_enabled':1} for i,chunk in enumerate(chunks)]
 return [m,budget,mapping,knowledge,chunks,embeds,{1,2},text.encode()]

class IndexContentTests(unittest.TestCase):
 def test_building_index_provider_state_is_frozen_explicitly_not_assumed_ready(self):
  scope=self.flash_scope();db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
  db.executescript('CREATE TABLE knowledge_provider_configs(id TEXT,status TEXT,model_id TEXT,dimensions INTEGER,index_version INTEGER);')
  db.execute('INSERT INTO knowledge_provider_configs VALUES(?,?,?,?,?)',('qwen','pending_reindex',scope.model_id,1024,2))
  validator.verify_provider_binding(db,scope,'pending_reindex')
  with self.assertRaisesRegex(validator.ValidationError,'relay_provider_binding_mismatch'):validator.verify_provider_binding(db,scope,'ready')
  db.execute("UPDATE knowledge_provider_configs SET status='disabled'")
  with self.assertRaisesRegex(validator.ValidationError,'relay_provider_binding_mismatch'):validator.verify_provider_binding(db,scope,'pending_reindex')
  db.close()
 def flash_scope(self):
  return validator.ValidationScope('flash-kb','qwen','qwen3.7-text-embedding-flash',2,'flash-model','flash-alias','html-3-engine-full213-v4-flash',1024)
 def test_explicit_flash_binding_rejects_legacy_mapping_and_wrong_provider_revision(self):
  scope=self.flash_scope();values=fixture()
  with self.assertRaisesRegex(validator.ValidationError,'mapping_identity_mismatch'):validator.validate_indexed_document(*values,scope=scope)
  values[2].update(external_knowledge_base_id=scope.knowledge_base_id,parser_version=scope.parser_version,model_provenance_json=json.dumps(validator.provenance(scope)))
  values[3].update(knowledge_base_id=scope.knowledge_base_id,embedding_model_id=scope.engine_model_id)
  for row in values[4]+values[5]:row['knowledge_base_id']=scope.knowledge_base_id
  self.assertEqual(validator.validate_indexed_document(*values,scope=scope)['chunksVerified'],2)
  for field,value in [('indexVersion',1),('providerId','other'),('modelId','qwen3.7-text-embedding')]:
   with self.subTest(field=field):
    wrong=copy.deepcopy(values);p=validator.provenance(scope);p[field]=value;wrong[2]['model_provenance_json']=json.dumps(p)
    with self.assertRaisesRegex(validator.ValidationError,'mapping_model_provenance_mismatch'):validator.validate_indexed_document(*wrong,scope=scope)
 def test_two_migrations_same_local_id_are_selected_by_exact_migration_not_environment(self):
  scope=self.flash_scope();db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
  db.executescript('CREATE TABLE knowledge_migrations(id TEXT,kind TEXT,status TEXT,idempotency_key TEXT,source_manifest_json TEXT); CREATE TABLE knowledge_migration_documents(migration_id TEXT,local_document_id TEXT,document_id TEXT);')
  manifest=fixture()[0];manifest['bodySha256']='body';doc={'localDocumentId':'local','bodySha256':'body','sourceSha256':'raw','sourcePath':'source.htm','productVersion':'21.3','projectId':'1','environment':validator.ENVIRONMENT}
  frozen={'parserVersion':scope.parser_version,'filters':{'productVersion':'21.3','projectId':'1','environment':validator.ENVIRONMENT},'documents':[doc]}
  db.execute('INSERT INTO knowledge_migrations VALUES(?,?,?,?,?)',('flash','product_knowledge','created','flash-key',json.dumps(frozen)))
  db.executemany('INSERT INTO knowledge_migration_documents VALUES(?,?,?)',[('legacy','local','old-mapping'),('flash','local','flash-mapping')])
  links=validator.migration_links(db,'flash','flash-key',scope,[manifest]);self.assertEqual(list(links),['local']);self.assertEqual(links['local']['document_id'],'flash-mapping')
  with self.assertRaisesRegex(validator.ValidationError,'migration_identity_mismatch'):validator.migration_links(db,'legacy','flash-key',scope,[manifest])
  with self.assertRaisesRegex(validator.ValidationError,'migration_identity_mismatch'):validator.migration_links(db,'flash','wrong-key',scope,[manifest])
  frozen['documents'][0]['bodySha256']='changed';db.execute('UPDATE knowledge_migrations SET source_manifest_json=?',(json.dumps(frozen),))
  with self.assertRaisesRegex(validator.ValidationError,'migration_frozen_source_mismatch'):validator.migration_links(db,'flash','flash-key',scope,[manifest])
  db.close()
 def test_complete_real_bytes_and_vector_rows(self):
  result=validator.validate_indexed_document(*fixture());self.assertEqual(result['chunksVerified'],2);self.assertEqual(result['storedFileVerified'],True)
 def test_changed_chunk_byte_fails(self):
  values=fixture();values[4][0]['content']='one line'
  with self.assertRaisesRegex(validator.ValidationError,'chunk_bytes_mismatch'):validator.validate_indexed_document(*values)
 def test_reordered_chunks_fail(self):
  values=fixture();values[4][0]['chunk_index']=1;values[4][1]['chunk_index']=0
  with self.assertRaisesRegex(validator.ValidationError,'chunk_bytes_mismatch'):validator.validate_indexed_document(*values)
 def test_summary_cannot_replace_missing_text_chunk(self):
  values=fixture();values[4][1]['chunk_type']='summary'
  with self.assertRaisesRegex(validator.ValidationError,'indexable_chunk_count_mismatch'):validator.validate_indexed_document(*values)
 def test_wrong_scope_or_model_fails(self):
  for field,value in [('environment','nonprod-full-213'),('external_knowledge_base_id','other'),('model_provenance_json','{}')]:
   with self.subTest(field=field):
    values=fixture();values[2][field]=value
    with self.assertRaises(validator.ValidationError):validator.validate_indexed_document(*values)
 def test_missing_vector_row_fails(self):
  values=fixture();values[6]={1}
  with self.assertRaisesRegex(validator.ValidationError,'vector_row_missing'):validator.validate_indexed_document(*values)
 def test_wrong_dimension_fails(self):
  values=fixture();values[5][0]['dimension']=768
  with self.assertRaisesRegex(validator.ValidationError,'embedding_identity_mismatch'):validator.validate_indexed_document(*values)
 def test_uploaded_file_sha_must_match(self):
  values=fixture();values[7]=b'altered'
  with self.assertRaisesRegex(validator.ValidationError,'stored_file_sha_mismatch'):validator.validate_indexed_document(*values)
 def test_chunk_mapping_must_match_actual_chunks(self):
  values=fixture();values[2]['external_chunk_ids_json']='["a","wrong"]'
  with self.assertRaisesRegex(validator.ValidationError,'mapped_chunk_ids_mismatch'):validator.validate_indexed_document(*values)
if __name__=='__main__':unittest.main()

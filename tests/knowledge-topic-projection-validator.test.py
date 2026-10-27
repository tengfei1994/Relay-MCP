import copy, importlib.util, json, pathlib, sqlite3, tempfile, unittest
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'scripts/knowledge-topic-projection-validate.py'
spec=importlib.util.spec_from_file_location('topic_validator',SCRIPT);validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)
ENV='nonprod-full-213-v3'
SCHEMA='''
CREATE TABLE knowledge_documents(id TEXT PRIMARY KEY,kind TEXT,body TEXT,project_id TEXT,environment TEXT,samplemanager_version TEXT,source_sha256 TEXT);
CREATE TABLE knowledge_product_documents(id TEXT PRIMARY KEY,source_path TEXT,source_sha256 TEXT,metadata_json TEXT,sections_json TEXT,version TEXT);
CREATE TABLE knowledge_topics(id TEXT PRIMARY KEY,canonical_key TEXT,canonical_title TEXT,kind TEXT,domain TEXT,metadata_json TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE knowledge_product_document_bindings(id TEXT PRIMARY KEY,topic_id TEXT,document_id TEXT,product TEXT,product_version TEXT,source_path TEXT,match_method TEXT,match_confidence REAL,status TEXT,created_at TEXT,updated_at TEXT);
'''
def connection():
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;db.executescript(SCHEMA);return db
def insert(db,table,row):
 db.execute('INSERT INTO '+table+' ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',list(row.values()))
def fixture():
 source,target,backup=connection(),connection(),connection()
 old_topic={'id':'legacy-topic','canonical_key':'legacy:key','canonical_title':'Old','kind':'product_document','domain':'product','metadata_json':'{}','created_at':'old','updated_at':'old'}
 old_binding={'id':'legacy-binding','topic_id':'legacy-topic','document_id':'legacy-document','product':'SampleManager','product_version':'21.3','source_path':'old.htm','match_method':'family_id','match_confidence':0.7,'status':'active','created_at':'old','updated_at':'old'}
 for db in [target,backup]:insert(db,'knowledge_topics',old_topic);insert(db,'knowledge_product_document_bindings',old_binding)
 metadata=json.dumps({'parserVersion':'html-3'},separators=(',',':'));raw='a'*64;body='structured body';source_id='source-doc';target_id='target-doc'
 doc={'id':source_id,'kind':'product_document','body':body,'project_id':'1','environment':ENV,'samplemanager_version':'21.3','source_sha256':raw}
 product={'id':source_id,'source_path':'source.htm','source_sha256':raw,'metadata_json':metadata,'sections_json':'[]','version':'21.3'}
 topic={'id':'source-topic','canonical_key':'source:key','canonical_title':'New','kind':'product_document','domain':'product','metadata_json':'{"sourceField":"kept"}','created_at':'new','updated_at':'new'}
 binding={'id':'source-binding','topic_id':topic['id'],'document_id':source_id,'product':'SampleManager','product_version':'21.3','source_path':'source.htm','match_method':'family_id','match_confidence':0.9,'status':'active','created_at':'new','updated_at':'new'}
 for table,row in [('knowledge_documents',doc),('knowledge_product_documents',product),('knowledge_topics',topic),('knowledge_product_document_bindings',binding)]:insert(source,table,row)
 target_topic_id='topic-full213-'+validator.digest(ENV+'|'+topic['id'])[:32]
 topic_projection={'sourceTopicId':topic['id'],'targetTopicId':target_topic_id}
 acceptance={'corpus':'full-213-v3','manifestSha256':'manifest-sha','bulkSourceId':source_id,'bodySha256':validator.digest(body),'normalizedSha256':validator.digest(body),'embeddingRequests':1,'topicProjection':[topic_projection]}
 target_product={**product,'id':target_id,'metadata_json':json.dumps({'parserVersion':'html-3','engineAcceptance':acceptance},separators=(',',':'))}
 target_topic={**topic,'id':target_topic_id,'canonical_key':'acceptance:'+ENV+':'+topic['canonical_key'],'metadata_json':json.dumps({'sourceField':'kept','acceptanceSourceTopic':{'id':topic['id'],'canonicalKey':topic['canonical_key'],'environment':ENV}},separators=(',',':'))}
 target_binding={**binding,'id':'binding-full213-'+validator.digest(binding['id']+'|'+target_id)[:32],'topic_id':target_topic_id,'document_id':target_id}
 for table,row in [('knowledge_documents',{**doc,'id':target_id}),('knowledge_product_documents',target_product),('knowledge_topics',target_topic),('knowledge_product_document_bindings',target_binding)]:insert(target,table,row)
 manifest=[{'bulkSourceId':source_id,'targetLocalId':target_id,'sourcePath':product['source_path'],'rawSha256':raw,'bodySha256':validator.digest(body),'normalizedSha256':validator.digest(body),'sourceMetadataSha256':validator.digest(metadata),'sectionsSha256':validator.digest('[]'),'version':'21.3','projectId':'1','environment':ENV,'sourceParserVersion':'html-3','topicBindings':[binding]}]
 return source,target,backup,manifest,target_topic_id,target_binding['id']
class TopicProjectionTests(unittest.TestCase):
 def fixture(self):
  data=fixture()
  for db in data[:3]:self.addCleanup(db.close)
  return data
 def run_validation(self,data):return validator.validate_projection(*data[:3],data[3],'manifest-sha',expected_count=1)
 def test_valid_projection_and_all_legacy_fields(self):
  data=self.fixture();report=self.run_validation(data);self.assertEqual(report['documentsVerified'],1);self.assertEqual(report['topicBindingsVerified'],1);self.assertEqual(report['legacyTopics']['rows'],1);self.assertEqual(report['legacyBindings']['rows'],1);self.assertEqual(report['legacyTopics']['backupSha256'],report['legacyTopics']['targetRowsSha256']);self.assertEqual(report['canonicalProvenanceSource'],'knowledge_topics.metadata_json.acceptanceSourceTopic')
 def test_wrong_document_id_mapping_fails(self):
  data=self.fixture();metadata=json.loads(data[1].execute('SELECT metadata_json FROM knowledge_product_documents').fetchone()[0]);metadata['engineAcceptance']['topicProjection'][0]['targetTopicId']='wrong';data[1].execute('UPDATE knowledge_product_documents SET metadata_json=?',(json.dumps(metadata),))
  with self.assertRaisesRegex(validator.ValidationError,'document_topic_projection_mismatch'):self.run_validation(data)
 def test_wrong_target_topic_canonical_fails(self):
  data=self.fixture();data[1].execute('UPDATE knowledge_topics SET canonical_key=? WHERE id=?',('wrong',data[4]))
  with self.assertRaisesRegex(validator.ValidationError,'target_topic_projection_mismatch'):self.run_validation(data)
 def test_source_canonical_provenance_must_match_source_table(self):
  data=self.fixture();metadata=json.loads(data[1].execute('SELECT metadata_json FROM knowledge_topics WHERE id=?',(data[4],)).fetchone()[0]);metadata['acceptanceSourceTopic']['canonicalKey']='wrong-source';data[1].execute('UPDATE knowledge_topics SET metadata_json=? WHERE id=?',(json.dumps(metadata),data[4]))
  with self.assertRaisesRegex(validator.ValidationError,'source_topic_canonical_provenance_mismatch'):self.run_validation(data)
 def test_every_binding_field_is_checked(self):
  for field,value in [('topic_id','wrong'),('product_version','21.1'),('source_path','wrong.htm'),('status','deprecated'),('match_method','changed'),('updated_at','changed')]:
   with self.subTest(field=field):
    data=self.fixture();data[1].execute('UPDATE knowledge_product_document_bindings SET '+field+'=? WHERE id=?',(value,data[5]))
    with self.assertRaisesRegex(validator.ValidationError,'target_binding_projection_mismatch'):self.run_validation(data)
 def test_legacy_rows_must_be_identical(self):
  for table,field in [('knowledge_topics','metadata_json'),('knowledge_product_document_bindings','status')]:
   with self.subTest(table=table):
    data=self.fixture();identity='legacy-topic' if table=='knowledge_topics' else 'legacy-binding';data[1].execute('UPDATE '+table+' SET '+field+'=? WHERE id=?',('changed',identity))
    with self.assertRaisesRegex(validator.ValidationError,'legacy_row_changed'):self.run_validation(data)
 def test_read_only_connection_rejects_writes(self):
  with tempfile.TemporaryDirectory() as directory:
   file=pathlib.Path(directory)/'db.sqlite';db=sqlite3.connect(file);db.execute('CREATE TABLE test(id INTEGER)');db.close();ro=validator.open_read_only(file)
   with self.assertRaises(sqlite3.OperationalError):ro.execute('INSERT INTO test VALUES(1)')
   ro.close()
if __name__=='__main__':unittest.main()

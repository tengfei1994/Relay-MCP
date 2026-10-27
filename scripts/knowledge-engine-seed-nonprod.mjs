#!/usr/bin/env node
/** One-time operator tool. No production paths, plaintext provider tokens, or server startup. */
import { readFile, writeFile, mkdir, chmod, realpath, lstat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import net from 'node:net';

const allowedRoot = '/home/ftd/relay-knowledge-engine-nonprod';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(repository, 'data');
const bundlePath = join(allowedRoot, 'provider-bundle.json');
const markerPath = join(data, '.nonprod-seed-state.json');
const manifestPath = join(data, 'nonprod-seed-manifest.json');
let stage = 'isolation_guard';
let store, appDatabase;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const privateJson = async (path, value) => { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600); };
const readJson = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Invalid private input JSON'); } };
const output = (value) => console.log(JSON.stringify(value, null, 2));
const portOpen = () => new Promise((done) => { const socket=net.connect({host:'127.0.0.1',port:18300}); socket.setTimeout(1000); socket.once('connect',()=>{socket.destroy();done(true);}); socket.once('error',()=>done(false)); socket.once('timeout',()=>{socket.destroy();done(false);}); });

try {
  if (process.env.RELAY_E2E_ISOLATED !== '1' || process.platform !== 'linux' || repository !== `${allowedRoot}/relay`) throw new Error('Isolated nonproduction flag and exact directory required');
  if (await realpath(repository) !== `${allowedRoot}/relay` || (await lstat(repository)).isSymbolicLink()) throw new Error('Nonproduction directory identity mismatch');
  if (await portOpen()) throw new Error('Stop isolated Relay before seeding');
  if (existsSync(manifestPath) && !existsSync(bundlePath)) {
    const manifest = await readJson(manifestPath);
    if (manifest.status !== 'complete') throw new Error('Incomplete previous seed');
    output({alreadySeeded:true, manifestPath, documents:manifest.documents.map(x=>({id:x.id,sha256:x.sourceSha256})), probes:manifest.probes, tokenFiles:manifest.tokenFiles});
  } else {
    if (await realpath(bundlePath) !== bundlePath || (await lstat(bundlePath)).isSymbolicLink()) throw new Error('Transfer bundle must be the exact authorized regular file');
    stage = 'validate_bundle';
    const bytes = await readFile(bundlePath);
    const fingerprint = hash(bytes);
    let bundle;
    try { bundle=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid transfer bundle'); }
    bytes.fill(0);
    if (!Array.isArray(bundle.documents) || bundle.documents.length !== 5 || bundle.provider?.id !== 'qwen' || bundle.provider.kind !== 'embedding' || bundle.provider.secret_ref !== bundle.secret?.ref) throw new Error('Transfer bundle does not match the authorized five-document/provider selection');
    const key=Buffer.from(bundle.key,'base64');
    if (key.length!==32 || !['ciphertext','nonce','tag'].every(k=>typeof bundle.secret[k]==='string' && /^(?:[0-9a-f]{2})+$/i.test(bundle.secret[k])) || bundle.secret.nonce.length!==24 || bundle.secret.tag.length!==32) throw new Error('Invalid transferred encrypted credential');
    if (new Set(bundle.documents.map(x=>x.document?.id)).size!==5 || bundle.documents.some(x=>x.document?.kind!=='product_document'||x.document.id!==x.product?.id||typeof x.document.body!=='string'||!x.document.body)) throw new Error('Invalid authorized document records');
    const oldState=existsSync(markerPath)?await readJson(markerPath):null;
    if (oldState && oldState.fingerprint!==fingerprint) throw new Error('Seed input differs from the existing isolated state');
    if (!oldState && ['app.db','knowledge.db','.provider-credentials.key'].some(name=>existsSync(join(data,name)))) throw new Error('Fresh isolated databases are required');
    if (!oldState && existsSync(join(repository,'.env'))) throw new Error('Existing environment configuration is not owned by this seed');
    await mkdir(data,{recursive:true,mode:0o700}); await chmod(data,0o700);
    for(const path of [join(data,'evidence'),join(data,'state'),join(repository,'workspace/project-1'),join(repository,'workspace/project-2')]) await mkdir(path,{recursive:true,mode:0o700});
    const state=oldState??{schemaVersion:1,fingerprint,status:'started',probes:{}};
    await privateJson(markerPath,state);
    stage='private_configuration';
    const jwtSecret=existsSync(join(data,'e2e-auth.json'))?(await readJson(join(data,'e2e-auth.json'))).jwtSecret:randomBytes(32).toString('hex');
    const variables={
      NODE_ENV:'production',RELAY_E2E_ISOLATED:'1',HOST:'127.0.0.1',PORT:'18300',MCP_PORT:'18301',JWT_SECRET:jwtSecret,
      MCP_SECRET:state.mcpSecret??randomBytes(32).toString('hex'),DB_PATH:join(data,'app.db'),KNOWLEDGE_DB_PATH:join(data,'knowledge.db'),
      KNOWLEDGE_ENGINE_HOME:join(allowedRoot,'runtime/knowledge-engine'),KNOWLEDGE_ENGINE_ENABLED:'true',
      PROVIDER_SECRET_KEY_FILE:join(data,'.provider-credentials.key'),WORKSPACE_ROOT:join(repository,'workspace'),RELAY_STATE_ROOT:join(data,'state'),
      KNOWLEDGE_EVIDENCE_ROOT:join(data,'evidence'),RELAY_DEFAULT_PROJECT_ID:'1',RELAY_DEFAULT_ENVIRONMENT:'nonprod',
    };
    state.mcpSecret=variables.MCP_SECRET;
    await privateJson(markerPath,state);
    Object.assign(process.env,variables);
    await writeFile(join(repository,'.env'),Object.entries(variables).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600});
    await chmod(join(repository,'.env'),0o600);
    if(existsSync(variables.PROVIDER_SECRET_KEY_FILE)) {
      if(!(await readFile(variables.PROVIDER_SECRET_KEY_FILE)).equals(key)) throw new Error('Existing provider key does not match transferred encrypted state');
    } else await writeFile(variables.PROVIDER_SECRET_KEY_FILE,key,{flag:'wx',mode:0o600});
    await chmod(variables.PROVIDER_SECRET_KEY_FILE,0o600); key.fill(0); bundle.key='';
    stage='migrations';
    const sourceModule=(path)=>import(pathToFileURL(join(repository,'src',path)).href);
    const [{runMigrations},{createKnowledgeStore},{ProviderCredentialStore},{ProviderSetupService,createManagedProviderRegistry},{EvidenceStore},{default:Database},{default:bcrypt},{default:jwt}]=await Promise.all([
      sourceModule('server/db/index.ts'),sourceModule('knowledge/store.ts'),sourceModule('knowledge/provider-credential-store.ts'),sourceModule('knowledge/provider-setup.ts'),sourceModule('knowledge/evidence-store.ts'),import('better-sqlite3'),import('bcryptjs'),import('jsonwebtoken'),
    ]);
    runMigrations();
    appDatabase=new Database(variables.DB_PATH);
    store=createKnowledgeStore({dbPath:variables.KNOWLEDGE_DB_PATH,appDbPath:variables.DB_PATH,evidenceRoot:variables.KNOWLEDGE_EVIDENCE_ROOT});
    let auth=existsSync(join(data,'e2e-auth.json'))?await readJson(join(data,'e2e-auth.json')):{jwtSecret,admin:{username:'nonprod-admin',password:randomBytes(24).toString('hex')},foreign:{username:'nonprod-foreign',password:randomBytes(24).toString('hex')}};
    await privateJson(join(data,'e2e-auth.json'),auth);
    stage='users_projects';
    for(const [kind,id,isAdmin,projectName] of [['admin',1,1,'knowledge-engine-nonprod'],['foreign',2,0,'foreign-nonprod']]) {
      appDatabase.prepare('INSERT OR IGNORE INTO users(id,username,password_hash,is_admin) VALUES (?,?,?,?)').run(id,auth[kind].username,await bcrypt.hash(auth[kind].password,12),isAdmin);
      appDatabase.prepare('INSERT OR IGNORE INTO projects(id,user_id,name,description,workspace_path) VALUES (?,?,?,?,?)').run(id,id,projectName,'Isolated knowledge engine validation',join(repository,`workspace/project-${id}`));
      const token=jwt.sign({id,username:auth[kind].username,isAdmin:Boolean(isAdmin),defaultProject:projectName,defaultProjectId:id,defaultEnvironment:'nonprod'},jwtSecret,{expiresIn:'24h'});
      await writeFile(join(data,`e2e-${kind}.jwt`),token+'\n',{mode:0o600}); await chmod(join(data,`e2e-${kind}.jwt`),0o600);
      store.grantAcl(String(id),id,true);
    }
    const insertMatching=(table,row)=>{
      const allowed=new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
      const keys=Object.keys(row).filter(k=>allowed.has(k));
      store.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));
    };
    stage='provider_import';
    insertMatching('knowledge_provider_configs',{...bundle.provider,created_by:1,concurrency:1,timeout_ms:120000,max_retries:1,batch_size:8,quota_max_calls:200,quota_window_ms:3600000});
    insertMatching('knowledge_provider_secrets',{ref:bundle.secret.ref,ciphertext:Buffer.from(bundle.secret.ciphertext,'hex'),nonce:Buffer.from(bundle.secret.nonce,'hex'),tag:Buffer.from(bundle.secret.tag,'hex')});
    stage='documents';
    const documents=[];
    store.db.transaction(()=>{
      for(const item of bundle.documents) {
        const d=item.document,p=item.product;
        let metadata={}; try{metadata=JSON.parse(p.metadata_json||'{}');}catch{}
        if(p.revision_id && !store.db.prepare('SELECT 1 FROM knowledge_product_revisions WHERE id=?').get(p.revision_id)) {
          insertMatching('knowledge_product_revisions',{id:p.revision_id,normalized_content_sha256:metadata.normalizedContentSha256||hash(d.body),raw_sha256:p.source_sha256||d.source_sha256,title:d.title,body:d.body,sections_json:p.sections_json,parser_version:metadata.parserVersion||'authorized-nonprod-copy',created_at:p.created_at,updated_at:p.updated_at});
        }
        store.upsertDocument({id:d.id,kind:d.kind,title:d.title,body:d.body,lifecycle:d.lifecycle,projectId:'1',projectNameSnapshot:'knowledge-engine-nonprod',sampleManagerVersion:d.samplemanager_version??undefined,solution:d.solution??undefined,module:d.module??undefined,environment:'nonprod',locator:d.source_locator,commit:d.source_commit??undefined,sha256:d.source_sha256??undefined,createdAt:d.created_at,updatedAt:d.updated_at,scopeType:'environment',scopeKey:'nonprod',visibility:'project',sourceProjectId:'1'});
        insertMatching('knowledge_product_documents',p);
        const copied=store.db.prepare('SELECT id,title,body,source_sha256,source_locator,samplemanager_version FROM knowledge_documents WHERE id=?').get(d.id);
        if(copied.body!==d.body||copied.title!==d.title||copied.source_sha256!==d.source_sha256||copied.source_locator!==d.source_locator) throw new Error('Document preservation check failed');
        documents.push({id:d.id,title:d.title,sourceSha256:d.source_sha256,normalizedBodySha256:hash(d.body),bodyBytes:Buffer.byteLength(d.body),sourcePath:p.source_path,version:p.version,projectId:'1',environment:'nonprod'});
      }
    })();
    stage='memory_evidence';
    const evidence=new EvidenceStore(store,variables.KNOWLEDGE_EVIDENCE_ROOT).put({content:Buffer.from('Isolated evidence sentinel: preserve exact bytes across knowledge engine routing changes.\n'),mimeType:'text/plain',sourceKind:'test',projectId:'1',environment:'nonprod',locator:'nonprod://knowledge-engine/evidence-sentinel',retention:'standard'});
    const now=new Date().toISOString();
    const memoryId='nonprod-memory-sentinel';
    const memoryBody='# Nonproduction Memory preservation case\n\nThis authored case is a runtime isolation sentinel. It confirms that Memory and Evidence remain Relay-owned while Product and Wiki use the upstream engine.\n';
    store.upsertDocument({id:memoryId,kind:'case',title:'Nonproduction Memory preservation sentinel',body:memoryBody,lifecycle:'approved',projectId:'1',projectNameSnapshot:'knowledge-engine-nonprod',environment:'nonprod',locator:'nonprod://knowledge-engine/memory-sentinel',sha256:hash(memoryBody),createdAt:now,updatedAt:now,visibility:'project',sourceProjectId:'1'});
    store.db.prepare('UPDATE knowledge_cases SET evidence_refs_json=?,created_by=1,environment=? WHERE id=?').run(JSON.stringify([evidence.id]),'nonprod',memoryId);
    store.db.prepare('INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES (?,?,?,?)').run('case',memoryId,evidence.id,now);
    stage='provider_probes';
    const credentials=new ProviderCredentialStore(store);
    let token=await credentials.resolve(bundle.secret.ref);
    if(!token) throw new Error('Transferred provider credential could not be resolved');
    const registry=createManagedProviderRegistry(store), setup=new ProviderSetupService(store);
    if(!state.probes.qwen) {
      const report=await registry.probe('qwen',1);
      if(!report.ok) throw Object.assign(new Error('Embedding probe failed'),{code:report.errorCode});
      state.probes.qwen=report; await privateJson(markerPath,state);
    }
    for(const [id,kind] of [['qwen-wiki-nonprod','wiki_llm'],['qwen-candidate-nonprod','candidate_llm']]) {
      if(!state.probes[id]) {
        const result=await setup.configure({id,kind,provider:bundle.provider.provider,baseUrl:bundle.provider.base_url,modelId:'qwen-plus',token,actorId:1});
        state.probes[id]=result.report; await privateJson(markerPath,state);
      }
      store.db.prepare('UPDATE knowledge_provider_configs SET concurrency=1,timeout_ms=120000,max_retries=1,quota_max_calls=200,quota_window_ms=3600000 WHERE id=?').run(id);
    }
    token=undefined;
    stage='verify_and_finalize';
    if(store.canRead(2,'1')||!store.canRead(1,'1')||store.canRead(1,'2')) throw new Error('Isolated ACL fixture validation failed');
    if(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_documents WHERE kind='product_document' AND project_id='1' AND environment='nonprod'").get().n!==5) throw new Error('Isolated document count mismatch');
    const providers=registry.list().map(({id,kind,modelId,dimensions,concurrency,timeoutMs,maxRetries,quota,status})=>({id,kind,modelId,dimensions,concurrency,timeoutMs,maxRetries,quota,status}));
    const manifest={schemaVersion:1,status:'complete',completedAt:new Date().toISOString(),isolationRoot:allowedRoot,relayBaseUrl:'http://127.0.0.1:18300',adminUserId:1,adminProjectId:1,foreignUserId:2,foreignProjectId:2,environment:'nonprod',documents,memory:{id:memoryId,bodySha256:hash(memoryBody)},evidence:{id:evidence.id,sha256:evidence.sha256,sizeBytes:evidence.sizeBytes},providers,probes:state.probes,tokenFiles:{admin:join(data,'e2e-admin.jwt'),foreign:join(data,'e2e-foreign.jwt'),browserAuth:join(data,'e2e-auth.json')}};
    await privateJson(manifestPath,manifest);
    state.status='complete'; delete state.mcpSecret; await privateJson(markerPath,state);
    appDatabase.pragma('wal_checkpoint(TRUNCATE)'); store.db.pragma('wal_checkpoint(TRUNCATE)');
    if(await realpath(bundlePath)!==bundlePath) throw new Error('Refusing to remove a different transfer path');
    await unlink(bundlePath);
    output({status:'complete',manifestPath,documents:documents.map(x=>({id:x.id,sourceSha256:x.sourceSha256,bodyBytes:x.bodyBytes,version:x.version})),memory:manifest.memory,evidence:manifest.evidence,providers,probes:state.probes,tokenFiles:manifest.tokenFiles,transferBundleDeleted:true,relayStarted:false});
  }
} catch(error) {
  const code=typeof error.code==='string'&&/^[a-z0-9_]+$/i.test(error.code)?error.code:'seed_failed';
  console.error(JSON.stringify({status:'failed',stage,errorCode:code,action:stage==='isolation_guard'?'Requires RELAY_E2E_ISOLATED=1 on the exact authorized Linux nonproduction checkout':'Private state and transfer bundle retained for diagnosis; no server was started'}));
  process.exitCode=1;
} finally {
  store?.close(); appDatabase?.close();
}
"""Read-only proof of an explicitly scoped migration against frozen B chunk hashes."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import sys
from typing import NamedTuple

ROOT = pathlib.Path('/home/ftd/relay-knowledge-engine-nonprod')
DIRECTORY = ROOT / 'bulk-structured-v3/candidate-v3-b'
ENVIRONMENT = 'nonprod-full-213-v3'
PARSER_VERSION = 'html-3-engine-full213-v3-b'
MANIFEST_SHA256 = '6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95'
BUDGET_SHA256 = '1e9c5955d1d5ecf8274e8e315aca0f51cd52e239ddce5bad66dbee89b12094fc'
KB_ID = '2b412419-fe11-448e-a103-28aba1380463'
MODEL_ID = '44ac04c3-913c-4065-b6fa-de1729894b34'
MODEL_ALIAS = 'relay-embedding-920366009d062bb9'
PROVENANCE = {'knowledgeBaseId': KB_ID, 'providerId': 'qwen', 'modelId': 'qwen3.7-text-embedding', 'dimensions': 1024, 'indexVersion': 1}

class ValidationScope(NamedTuple):
    knowledge_base_id: str
    provider_id: str
    model_id: str
    index_version: int
    engine_model_id: str
    model_alias: str
    parser_version: str
    dimensions: int

LEGACY_SCOPE = ValidationScope(KB_ID, 'qwen', PROVENANCE['modelId'], 1, MODEL_ID, MODEL_ALIAS, PARSER_VERSION, 1024)

def provenance(scope):
    return {'knowledgeBaseId': scope.knowledge_base_id, 'providerId': scope.provider_id, 'modelId': scope.model_id, 'dimensions': scope.dimensions, 'indexVersion': scope.index_version}

def verify_provider_binding(app, scope, expected_status):
    require(expected_status in ['ready', 'pending_reindex'], 'unsupported_expected_provider_state')
    provider = app.execute('SELECT status,model_id,dimensions,index_version FROM knowledge_provider_configs WHERE id=?', (scope.provider_id,)).fetchone()
    require(provider is not None and provider['status'] == expected_status and provider['model_id'] == scope.model_id and provider['dimensions'] == scope.dimensions and provider['index_version'] == scope.index_version, 'relay_provider_binding_mismatch')

def migration_links(app, migration_id, operation_key, scope, manifest):
    row = app.execute('SELECT * FROM knowledge_migrations WHERE id=?', (migration_id,)).fetchone()
    require(row is not None and row['idempotency_key'] == operation_key and row['kind'] == 'product_knowledge' and row['status'] in ['created', 'staged', 'published'], 'migration_identity_mismatch')
    frozen = parsed(row['source_manifest_json'])
    require(frozen.get('parserVersion') == scope.parser_version and all(frozen.get('filters', {}).get(k) == v for k, v in {'projectId': '1', 'environment': ENVIRONMENT, 'productVersion': '21.3'}.items()), 'migration_frozen_scope_mismatch')
    documents = frozen.get('documents', [])
    expected = {m['targetLocalId']: m for m in manifest}
    require(len(documents) == len(expected) and {d.get('localDocumentId') for d in documents} == set(expected), 'migration_frozen_document_set_mismatch')
    for document in documents:
        m = expected[document['localDocumentId']]
        fields = {'projectId': m['projectId'], 'environment': m['environment'], 'productVersion': m['version'], 'sourcePath': m['sourcePath'], 'sourceSha256': m['rawSha256'], 'bodySha256': m['bodySha256']}
        require(all(document.get(k) == v for k, v in fields.items()), 'migration_frozen_source_mismatch')
        require(all((document.get(k) or None) == (m.get(k) or None) for k in ['solution', 'module', 'language']), 'migration_frozen_metadata_mismatch')
    links = {}
    for row in app.execute('SELECT * FROM knowledge_migration_documents WHERE migration_id=?', (migration_id,)):
        value = dict(row)
        require(value['local_document_id'] in expected and value['local_document_id'] not in links, 'migration_link_source_set_mismatch')
        links[value['local_document_id']] = value
    return links

class ValidationError(RuntimeError):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.details = details or {}

def require(condition, code, details=None):
    if not condition:
        raise ValidationError(code, details)

def digest(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def parsed(value):
    return json.loads(value) if value else None

def open_read_only(path):
    connection = sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('PRAGMA busy_timeout=10000')
    connection.execute('BEGIN')
    connection.execute('SELECT count(*) FROM sqlite_master').fetchone()
    return connection

def validate_mapping_identity(manifest, mapping, scope):
    expected = {'project_id': '1', 'environment': ENVIRONMENT, 'source_path': manifest['sourcePath'], 'raw_sha256': manifest['rawSha256'], 'normalized_content_sha256': manifest['normalizedSha256'], 'parser_version': scope.parser_version, 'product_version': '21.3', 'external_knowledge_base_id': scope.knowledge_base_id}
    require(all(mapping.get(key) == value for key, value in expected.items()), 'mapping_identity_mismatch')
    require(parsed(mapping['model_provenance_json']) == provenance(scope), 'mapping_model_provenance_mismatch')

def validate_indexed_document(manifest, budget, mapping, knowledge, chunks, embeddings, vector_ids, stored_file, scope=LEGACY_SCOPE):
    require(manifest['projectId'] == '1' and manifest['environment'] == ENVIRONMENT and manifest['version'] == '21.3', 'manifest_scope_mismatch')
    require(mapping['status'] in ['staged', 'published'] and mapping['upstream_parse_status'] == 'completed' and bool(mapping['upstream_verified_at']), 'mapping_not_verified')
    validate_mapping_identity(manifest, mapping, scope)
    require(budget['normalizedSha256'] == manifest['normalizedSha256'], 'budget_input_identity_mismatch')
    require(knowledge is not None and knowledge['id'] == mapping['external_document_id'] and knowledge['knowledge_base_id'] == scope.knowledge_base_id and knowledge['embedding_model_id'] == scope.engine_model_id and knowledge['parse_status'] == 'completed' and knowledge['enable_status'] == 'enabled' and knowledge['deleted_at'] is None, 'engine_knowledge_identity_mismatch')
    active_chunks = [row for row in chunks if row['deleted_at'] is None]
    excluded = [row for row in active_chunks if row['chunk_type'] in ['summary', 'question']]
    text_chunks = sorted([row for row in active_chunks if row['chunk_type'] not in ['summary', 'question']], key=lambda row: row['chunk_index'])
    require(len(text_chunks) == budget['indexableChunks'] == len(budget['indexableChunkHashes']), 'indexable_chunk_count_mismatch', {'expectedChunks': budget['indexableChunks'], 'actualChunks': len(text_chunks)})
    require(len({row['chunk_index'] for row in text_chunks}) == len(text_chunks), 'chunk_sequence_ambiguous')
    actual_hashes = [digest(row['content']) for row in text_chunks]
    if actual_hashes != budget['indexableChunkHashes']:
        first = next(i for i, (actual, expected) in enumerate(zip(actual_hashes, budget['indexableChunkHashes'])) if actual != expected)
        raise ValidationError('chunk_bytes_mismatch', {'firstDifferentOrdinal': first, 'expectedSha256': budget['indexableChunkHashes'][first], 'actualSha256': actual_hashes[first]})
    for chunk in text_chunks:
        require(chunk['knowledge_id'] == knowledge['id'] and chunk['knowledge_base_id'] == scope.knowledge_base_id and chunk['tenant_id'] == knowledge['tenant_id'] and chunk['chunk_type'] == 'text' and chunk['is_enabled'] == 1 and chunk['index_status'] == 'ready', 'chunk_identity_or_readiness_mismatch')
    chunk_ids = {row['id'] for row in text_chunks}
    mapped_ids = parsed(mapping['external_chunk_ids_json'])
    require(isinstance(mapped_ids, list) and len(mapped_ids) == len(set(mapped_ids)) and set(mapped_ids) == chunk_ids, 'mapped_chunk_ids_mismatch')
    text_embeddings = [row for row in embeddings if row['chunk_id'] in chunk_ids]
    require(len(text_embeddings) == len(text_chunks) and {row['chunk_id'] for row in text_embeddings} == chunk_ids, 'embedding_rows_mismatch')
    for embedding in text_embeddings:
        require(embedding['knowledge_id'] == knowledge['id'] and embedding['knowledge_base_id'] == scope.knowledge_base_id and embedding['source_id'] == embedding['chunk_id'] and embedding['dimension'] == scope.dimensions and embedding['is_enabled'] == 1, 'embedding_identity_mismatch')
        require(embedding['id'] in vector_ids, 'vector_row_missing')
    require(digest(stored_file) == manifest['normalizedSha256'], 'stored_file_sha_mismatch')
    return {'chunksVerified': len(text_chunks), 'embeddingsVerified': len(text_embeddings), 'vectorRowsVerified': len(text_embeddings),
            'excludedSummaryQuestionChunks': len(excluded), 'expectedChunkHashesSha256': digest(canonical(budget['indexableChunkHashes'])),
            'actualChunkHashesSha256': digest(canonical(actual_hashes)), 'storedFileVerified': True,
            'storedFileSha256': digest(stored_file), 'normalizedSha256': manifest['normalizedSha256']}

def stored_input(engine, knowledge):
    handle = knowledge.get('file_path') or ''
    require(re.fullmatch(r'resource://[A-Za-z0-9_-]{22}', handle) is not None, 'unsupported_resource_reference')
    raw = engine.execute('SELECT * FROM resources WHERE handle=?', (handle.removeprefix('resource://'),)).fetchone()
    require(raw is not None, 'resource_missing')
    resource = dict(raw)
    require(resource['provider'] == 'local' and resource['state'] == 'active' and resource['deleted_at'] is None and resource['tenant_id'] == knowledge['tenant_id'], 'resource_identity_mismatch')
    match = re.fullmatch(r'storage://([0-9a-f-]{36})/local://(.+)', resource['physical_path'])
    require(match is not None and resource['storage_backend_id'] == match.group(1), 'resource_local_storage_mismatch')
    backend = engine.execute('SELECT provider,status,deleted_at FROM storage_backends WHERE id=?', (match.group(1),)).fetchone()
    require(backend is not None and backend['provider'] == 'local' and backend['status'] == 'active' and backend['deleted_at'] is None, 'storage_backend_identity_mismatch')
    base = ROOT / 'runtime/knowledge-engine/data/files'
    file = (base / match.group(2)).resolve()
    require(file.is_relative_to(base.resolve()) and file.is_file(), 'stored_file_outside_nonproduction_store')
    content = file.read_bytes()
    require(len(content) == knowledge['file_size'], 'stored_file_size_mismatch')
    return content

def verify_active_binding(engine, scope=LEGACY_SCOPE):
    control_file = ROOT / 'runtime/knowledge-engine/control.json'
    control = json.loads(control_file.read_text())
    require(control.get('phase') == 'ready' and control.get('knowledgeBaseId') == scope.knowledge_base_id, 'active_knowledge_base_changed')
    bindings = [value for value in control.get('bindings', []) if value['kind'] == 'embedding']
    require(len(bindings) == 1, 'active_embedding_binding_ambiguous')
    binding = bindings[0]
    require({key: binding.get(key) for key in ['providerId', 'modelId', 'dimensions', 'indexVersion']} == {key: provenance(scope)[key] for key in ['providerId', 'modelId', 'dimensions', 'indexVersion']} and binding.get('engineModelId') == scope.engine_model_id and binding.get('alias') == scope.model_alias, 'active_embedding_binding_changed')
    kb = engine.execute('SELECT * FROM knowledge_bases WHERE id=?', (scope.knowledge_base_id,)).fetchone()
    require(kb is not None and kb['deleted_at'] is None and kb['embedding_model_id'] == scope.engine_model_id, 'engine_knowledge_base_changed')
    require(parsed(kb['chunking_config']) == {'chunk_size': 0, 'chunk_overlap': 0, 'separators': None}, 'engine_chunker_configuration_changed')
    strategy = parsed(kb['indexing_strategy'])
    require(strategy.get('vector_enabled') is True and strategy.get('keyword_enabled') is True and strategy.get('wiki_enabled') is False and strategy.get('graph_enabled') is False, 'engine_index_strategy_changed')
    model = engine.execute('SELECT * FROM models WHERE id=?', (scope.engine_model_id,)).fetchone()
    require(model is not None and model['deleted_at'] is None and model['status'] == 'active' and model['type'] == 'Embedding' and model['name'] == scope.model_alias and parsed(model['parameters'])['embedding_parameters']['dimension'] == scope.dimensions, 'engine_embedding_model_changed')
    return {'modelProvenance': provenance(scope), 'engineModelId': scope.engine_model_id, 'modelAlias': scope.model_alias, 'knowledgeBaseId': scope.knowledge_base_id, 'dimensions': scope.dimensions}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--require-complete', action='store_true')
    for name in ['migration-id', 'operation-key', 'expected-provider-id', 'expected-model-id', 'expected-kb-id', 'expected-engine-model-id', 'expected-model-alias', 'expected-parser-version']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--expected-index-version', required=True, type=int)
    parser.add_argument('--expected-dimensions', required=True, type=int)
    parser.add_argument('--expected-provider-status', required=True, choices=['ready', 'pending_reindex'])
    parser.add_argument('--output-directory', default=str(DIRECTORY))
    args = parser.parse_args()
    require(args.expected_index_version > 0 and args.expected_dimensions == 1024, 'unsupported_expected_binding')
    scope = ValidationScope(args.expected_kb_id, args.expected_provider_id, args.expected_model_id, args.expected_index_version, args.expected_engine_model_id, args.expected_model_alias, args.expected_parser_version, args.expected_dimensions)
    require(sys.platform == 'linux' and ROOT.resolve() == ROOT and os.environ.get('RELAY_QUALITY_ISOLATED') == '1', 'isolated_nonproduction_required')
    output_directory = pathlib.Path(args.output_directory).resolve()
    require(output_directory.is_dir() and output_directory.is_relative_to(ROOT), 'private_output_directory_required')
    manifest_path, budget_path = DIRECTORY / 'manifest.jsonl', DIRECTORY / 'native-budget.jsonl'
    raw_manifest, raw_budget = manifest_path.read_bytes(), budget_path.read_bytes()
    require(digest(raw_manifest) == MANIFEST_SHA256 and digest(raw_budget) == BUDGET_SHA256, 'frozen_evidence_hash_mismatch')
    manifest = [json.loads(line) for line in raw_manifest.decode().splitlines() if line]
    budgets_list = [json.loads(line) for line in raw_budget.decode().splitlines() if line]
    budgets = {row['bulkSourceId']: row for row in budgets_list}
    require(len(manifest) == len(budgets_list) == len(budgets) == 5372 and len({row['targetLocalId'] for row in manifest}) == 5372 and set(budgets) == {row['bulkSourceId'] for row in manifest}, 'frozen_corpus_identity_mismatch')
    app_path, engine_path = ROOT / 'relay/data/knowledge.db', ROOT / 'runtime/knowledge-engine/data/weknora.db'
    for path in [manifest_path, budget_path, app_path, engine_path]:
        require(path.is_file() and path.resolve().is_relative_to(ROOT), 'existing_nonproduction_file_required')
    # Establish the app snapshot first. A verified app mapping only references already completed engine content.
    app = open_read_only(app_path)
    engine = open_read_only(engine_path)
    try:
        binding = verify_active_binding(engine, scope)
        verify_provider_binding(app, scope, args.expected_provider_status)
        local_ids = {row[0] for row in app.execute('SELECT id FROM knowledge_documents WHERE environment=? AND project_id=?', (ENVIRONMENT, '1'))}
        require(local_ids == {row['targetLocalId'] for row in manifest}, 'target_scope_document_set_mismatch')
        links = migration_links(app, args.migration_id, args.operation_key, scope, manifest)
        evidence, pending, failed, invalid = [], [], [], []
        for m in manifest:
            safe_id = digest(m['targetLocalId'])
            link = links.get(m['targetLocalId'])
            if not link or not link['document_id']:
                pending.append({'localIdSha256': safe_id, 'reason': 'not_yet_mapped'})
                continue
            row = app.execute('SELECT * FROM knowledge_weknora_documents WHERE id=?', (link['document_id'],)).fetchone()
            if row is None:
                invalid.append({'localIdSha256': safe_id, 'error': 'linked_mapping_missing'})
                continue
            mapping = dict(row)
            try:
                require(link['status'] in ['staged', 'published', 'failed'], 'migration_link_withdrawn_or_invalid')
                require(link['external_document_id'] == mapping['external_document_id'] and link['content_sha256'] == m['normalizedSha256'] and link['parser_version'] == scope.parser_version, 'migration_mapping_identity_mismatch')
                validate_mapping_identity(m, mapping, scope)
            except ValidationError as error:
                invalid.append({'localIdSha256': safe_id, 'error': str(error), **error.details})
                continue
            if mapping['status'] == 'failed' or link['status'] == 'failed':
                failed.append({'localIdSha256': safe_id, 'failureCode': mapping['failure_code'] or link['failure_code'] or 'unspecified'})
                continue
            if not mapping['upstream_verified_at'] or mapping['upstream_parse_status'] != 'completed':
                pending.append({'localIdSha256': safe_id, 'reason': 'upstream_not_verified'})
                continue
            try:
                knowledge_row = engine.execute('SELECT * FROM knowledges WHERE id=?', (mapping['external_document_id'],)).fetchone()
                require(knowledge_row is not None, 'engine_knowledge_missing')
                knowledge = dict(knowledge_row)
                chunks = [dict(row) for row in engine.execute('SELECT * FROM chunks WHERE knowledge_id=? ORDER BY chunk_index', (knowledge['id'],))]
                embeddings = [dict(row) for row in engine.execute('SELECT id,source_id,chunk_id,knowledge_id,knowledge_base_id,dimension,is_enabled FROM lite_embeddings WHERE knowledge_id=?', (knowledge['id'],))]
                vector_ids = {row[0] for row in engine.execute('SELECT v.rowid FROM vec_embeddings_1024_rowids v JOIN lite_embeddings e ON e.id=v.rowid WHERE e.knowledge_id=?', (knowledge['id'],))}
                result = validate_indexed_document(m, budgets[m['bulkSourceId']], mapping, knowledge, chunks, embeddings, vector_ids, stored_input(engine, knowledge), scope=scope)
                evidence.append({'localIdSha256': safe_id, 'externalIdSha256': digest(knowledge['id']), **result})
            except ValidationError as error:
                invalid.append({'localIdSha256': safe_id, 'error': str(error), **error.details})
        verify_active_binding(engine, scope)
    finally:
        app.close()
        engine.close()
    complete = len(evidence) == 5372 and not pending and not failed and not invalid
    status = 'failed' if invalid else ('passed' if complete else 'partial')
    report = {'status': status, 'complete': complete, 'requireComplete': args.require_complete, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'environment': ENVIRONMENT, 'expectedDocuments': 5372, 'verifiedDocuments': len(evidence), 'pendingDocuments': len(pending), 'failedDocuments': len(failed), 'invalidDocuments': len(invalid),
              'migrationId': args.migration_id, 'operationKey': args.operation_key, 'expectedScope': {**scope._asdict(), 'provider_status': args.expected_provider_status}, 'expectedScopeSha256': digest(canonical({**scope._asdict(), 'provider_status': args.expected_provider_status})), 'selectedMigrationLinks': len(links),
              'verifiedChunks': sum(row['chunksVerified'] for row in evidence), 'verifiedVectorRows': sum(row['vectorRowsVerified'] for row in evidence), 'verifiedStoredFiles': len(evidence),
              'excludedSummaryQuestionChunks': sum(row['excludedSummaryQuestionChunks'] for row in evidence),
              'manifestSha256': MANIFEST_SHA256, 'nativeBudgetSha256': BUDGET_SHA256, 'scriptSha256': digest(pathlib.Path(__file__).read_bytes()),
              'binding': binding, 'paths': {'appDatabase': str(app_path), 'engineDatabase': str(engine_path), 'manifest': str(manifest_path), 'nativeBudget': str(budget_path)},
              'snapshotConsistency': 'ordered_app_then_engine_read_transactions_while_ingestion_may_continue',
              'vectorProof': 'matching_lite_embedding_row_and_vec0_shadow_row_presence_not_recomputed_model_output',
              'modelCalls': 0, 'databaseMutations': 0, 'verified': evidence, 'pending': pending, 'failed': failed, 'invalid': invalid}
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = output_directory / ('index-content-validation-' + timestamp + '.json')
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(output), 'reportSha256': digest(output.read_bytes()), **{key: report[key] for key in ['status', 'complete', 'expectedDocuments', 'verifiedDocuments', 'pendingDocuments', 'failedDocuments', 'invalidDocuments', 'verifiedChunks', 'verifiedStoredFiles', 'modelCalls', 'databaseMutations']}, 'invalidCodes': sorted({row['error'] for row in invalid})}))
    if invalid or (args.require_complete and not complete):
        sys.exit(1)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error) if isinstance(error, ValidationError) else 'validation_failed_no_private_diagnostics'}), file=sys.stderr)
        sys.exit(1)

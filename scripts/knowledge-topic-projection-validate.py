"""Independent, read-only acceptance topic projection proof. No HTTP/model calls."""
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path('/home/ftd/relay-knowledge-engine-nonprod')
DIRECTORY = ROOT / 'bulk-structured-v3/candidate-v3-b'
ENVIRONMENT = 'nonprod-full-213-v3'
MANIFEST_SHA256 = '6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95'

class ValidationError(RuntimeError):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.details = details or {}

def require(condition, code):
    if not condition:
        raise ValidationError(code)

def digest(value):
    return hashlib.sha256(value.encode('utf-8') if isinstance(value, str) else value).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def open_read_only(path):
    connection = sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('PRAGMA busy_timeout=10000')
    return connection

def row_by_id(db, table, identity, code):
    row = db.execute('SELECT * FROM ' + table + ' WHERE id=?', (identity,)).fetchone()
    require(row is not None, code)
    return dict(row)

def rows_by_document(db, table, identity):
    return [dict(row) for row in db.execute('SELECT * FROM ' + table + ' WHERE document_id=? ORDER BY id', (identity,))]

def compare_legacy(target, backup, table):
    previous = [dict(row) for row in backup.execute('SELECT * FROM ' + table + ' ORDER BY id')]
    current = []
    changed = []
    columns = {}
    for row in previous:
        actual_row = target.execute('SELECT * FROM ' + table + ' WHERE id=?', (row['id'],)).fetchone()
        actual = dict(actual_row) if actual_row is not None else None
        fields = ['missing_row'] if actual is None else sorted(key for key in set(row) | set(actual) if row.get(key) != actual.get(key))
        if fields:
            changed.append({'idSha256': digest(row['id']), 'columns': fields})
            for field in fields:
                columns[field] = columns.get(field, 0) + 1
        current.append(actual)
    return {'rows': len(previous), 'columns': [column[1] for column in backup.execute('PRAGMA table_info(' + table + ')')],
            'backupSha256': digest(canonical(previous)), 'targetRowsSha256': digest(canonical(current)),
            'comparison': 'all_columns_exact', 'changedRows': len(changed), 'changedColumns': columns,
            'changes': changed}

def validate_projection(source, target, backup, manifest, manifest_sha256, expected_count=5372):
    require(len(manifest) == expected_count, 'manifest_count_mismatch')
    require(len({m['bulkSourceId'] for m in manifest}) == expected_count and len({m['targetLocalId'] for m in manifest}) == expected_count, 'manifest_duplicate_identity')
    verified_topics = set()
    verified_bindings = 0
    unbound_documents = 0
    for m in manifest:
        require(m['environment'] == ENVIRONMENT and m['projectId'] == '1' and m['version'] == '21.3' and m['sourceParserVersion'] == 'html-3', 'manifest_scope_mismatch')
        source_doc = row_by_id(source, 'knowledge_documents', m['bulkSourceId'], 'source_document_missing')
        source_product = row_by_id(source, 'knowledge_product_documents', m['bulkSourceId'], 'source_product_missing')
        require(digest(source_doc['body']) == m['bodySha256'] and source_product['source_sha256'] == m['rawSha256'] and source_product['source_path'] == m['sourcePath'], 'source_document_identity_mismatch')
        require(digest(source_product['metadata_json']) == m['sourceMetadataSha256'] and digest(source_product['sections_json']) == m['sectionsSha256'], 'source_structure_mismatch')
        source_metadata = json.loads(source_product['metadata_json'])
        require(source_metadata.get('parserVersion') == 'html-3', 'source_parser_mismatch')
        actual_doc = row_by_id(target, 'knowledge_documents', m['targetLocalId'], 'target_document_missing')
        actual_product = row_by_id(target, 'knowledge_product_documents', m['targetLocalId'], 'target_product_missing')
        require(actual_doc['body'] == source_doc['body'] and actual_doc['kind'] == source_doc['kind'] and actual_doc['project_id'] == '1' and actual_doc['environment'] == ENVIRONMENT and actual_doc['samplemanager_version'] == '21.3', 'target_document_identity_mismatch')
        for field in ['source_path', 'source_sha256', 'sections_json', 'version']:
            require(actual_product[field] == source_product[field], 'target_product_identity_mismatch')
        metadata = json.loads(actual_product['metadata_json'])
        acceptance = metadata.pop('engineAcceptance', None)
        require(metadata == source_metadata and isinstance(acceptance, dict), 'target_metadata_projection_mismatch')
        for key, value in {'corpus': 'full-213-v3', 'manifestSha256': manifest_sha256, 'bodySha256': m['bodySha256'], 'normalizedSha256': m['normalizedSha256'], 'bulkSourceId': m['bulkSourceId']}.items():
            require(acceptance.get(key) == value, 'target_acceptance_identity_mismatch')
        require(isinstance(acceptance.get('embeddingRequests'), int) and acceptance['embeddingRequests'] > 0, 'target_acceptance_budget_missing')
        if 'preview' in m:
            require(acceptance['embeddingRequests'] == m['preview']['embeddingBatches'], 'target_acceptance_budget_mismatch')
        bindings = rows_by_document(source, 'knowledge_product_document_bindings', m['bulkSourceId'])
        require(bindings == sorted(m['topicBindings'], key=lambda row: row['id']), 'source_manifest_binding_mismatch')
        expected_bindings = []
        expected_projection = []
        for binding in bindings:
            source_topic = row_by_id(source, 'knowledge_topics', binding['topic_id'], 'source_topic_missing')
            target_topic_id = 'topic-full213-' + digest(ENVIRONMENT + '|' + source_topic['id'])[:32]
            expected_projection.append({'sourceTopicId': source_topic['id'], 'targetTopicId': target_topic_id})
            actual_topic = row_by_id(target, 'knowledge_topics', target_topic_id, 'target_topic_projection_mismatch')
            topic_metadata = json.loads(actual_topic['metadata_json'])
            provenance = topic_metadata.pop('acceptanceSourceTopic', None)
            require(provenance == {'id': source_topic['id'], 'canonicalKey': source_topic['canonical_key'], 'environment': ENVIRONMENT}, 'source_topic_canonical_provenance_mismatch')
            expected_topic = {**source_topic, 'id': target_topic_id, 'canonical_key': 'acceptance:' + ENVIRONMENT + ':' + source_topic['canonical_key']}
            require(topic_metadata == json.loads(source_topic['metadata_json'] or '{}'), 'target_topic_metadata_mismatch')
            require({k: v for k, v in actual_topic.items() if k != 'metadata_json'} == {k: v for k, v in expected_topic.items() if k != 'metadata_json'}, 'target_topic_projection_mismatch')
            verified_topics.add(target_topic_id)
            expected_bindings.append({**binding, 'id': 'binding-full213-' + digest(binding['id'] + '|' + m['targetLocalId'])[:32], 'topic_id': target_topic_id, 'document_id': m['targetLocalId']})
        require(acceptance.get('topicProjection') == expected_projection, 'document_topic_projection_mismatch')
        require(rows_by_document(target, 'knowledge_product_document_bindings', m['targetLocalId']) == sorted(expected_bindings, key=lambda row: row['id']), 'target_binding_projection_mismatch')
        verified_bindings += len(bindings)
        unbound_documents += int(not bindings)
    target_ids = {row[0] for row in target.execute('SELECT id FROM knowledge_documents WHERE environment=?', (ENVIRONMENT,))}
    require(target_ids == {m['targetLocalId'] for m in manifest}, 'target_scope_document_set_mismatch')
    actual_topics = {row[0] for row in target.execute('SELECT id FROM knowledge_topics WHERE substr(canonical_key,1,?)=?', (len('acceptance:' + ENVIRONMENT + ':'), 'acceptance:' + ENVIRONMENT + ':'))}
    require(actual_topics == verified_topics, 'target_scope_topic_set_mismatch')
    legacy_topics = compare_legacy(target, backup, 'knowledge_topics')
    legacy_bindings = compare_legacy(target, backup, 'knowledge_product_document_bindings')
    require(not target.execute('PRAGMA foreign_key_check').fetchall(), 'target_foreign_key_violation')
    if legacy_topics['changedRows'] or legacy_bindings['changedRows']:
        raise ValidationError('legacy_row_changed', {'documentsVerified': expected_count, 'topicBindingsVerified': verified_bindings, 'distinctTopicsVerified': len(verified_topics), 'documentsWithoutBinding': unbound_documents, 'legacyTopics': legacy_topics, 'legacyBindings': legacy_bindings, 'newScopeProjectionStatus': 'passed', 'foreignKeyViolations': 0})
    return {'status': 'passed', 'documentsVerified': expected_count, 'topicBindingsVerified': verified_bindings,
            'distinctTopicsVerified': len(verified_topics), 'documentsWithoutBinding': unbound_documents,
            'legacyTopics': legacy_topics, 'legacyBindings': legacy_bindings,
            'documentProjectionFields': ['sourceTopicId', 'targetTopicId'],
            'canonicalProvenanceSource': 'knowledge_topics.metadata_json.acceptanceSourceTopic',
            'bindingComparison': 'every_source_binding_column_with_only_id_topic_id_document_id_projected',
            'foreignKeyViolations': 0, 'modelCalls': 0, 'databaseMutations': 0}

def main():
    require(sys.platform == 'linux' and ROOT.resolve() == ROOT and os.environ.get('RELAY_QUALITY_ISOLATED') == '1', 'isolated_nonproduction_required')
    paths = {'sourceDatabase': DIRECTORY / 'knowledge.db', 'targetDatabase': ROOT / 'relay/data/knowledge.db',
             'preseedBackup': ROOT / 'runtime/backups/full-seed-20261025T143217.db', 'manifest': DIRECTORY / 'manifest.jsonl'}
    for path in paths.values():
        require(path.is_file() and path.resolve().is_relative_to(ROOT), 'existing_nonproduction_file_required')
    output = DIRECTORY / 'topic-projection-validation-v3-b.json'
    require(not output.exists(), 'report_already_exists')
    raw = paths['manifest'].read_bytes()
    require(digest(raw) == MANIFEST_SHA256, 'manifest_hash_mismatch')
    manifest = [json.loads(line) for line in raw.decode().splitlines() if line]
    before = {name: digest(paths[name].read_bytes()) for name in ['sourceDatabase', 'preseedBackup']}
    connections = [open_read_only(paths[name]) for name in ['sourceDatabase', 'targetDatabase', 'preseedBackup']]
    try:
        for db in connections:
            db.execute('BEGIN')
        try:
            report = validate_projection(*connections, manifest, MANIFEST_SHA256)
        except ValidationError as error:
            report = {'status': 'failed', 'error': str(error), 'modelCalls': 0, 'databaseMutations': 0, **error.details}
    finally:
        for db in connections:
            db.close()
    require(before == {name: digest(paths[name].read_bytes()) for name in before}, 'immutable_evidence_file_changed')
    report.update({'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'environment': ENVIRONMENT,
                   'manifestSha256': MANIFEST_SHA256, 'scriptSha256': digest(pathlib.Path(__file__).read_bytes()),
                   'sourceDatabaseSha256': before['sourceDatabase'], 'preseedBackupSha256': before['preseedBackup'],
                   'paths': {name: str(path) for name, path in paths.items()}, 'readTransactionSnapshots': True,
                   'liveDatabaseMayHaveConcurrentIngestion': True})
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(output), 'reportSha256': digest(output.read_bytes()), **{k: report[k] for k in ['status', 'error', 'documentsVerified', 'topicBindingsVerified', 'distinctTopicsVerified', 'documentsWithoutBinding', 'modelCalls', 'databaseMutations'] if k in report}, 'legacy': {key: {field: value for field, value in report[key].items() if field != 'changes'} for key in ['legacyTopics', 'legacyBindings'] if key in report}}))
    if report['status'] != 'passed':
        sys.exit(1)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error) if isinstance(error, ValidationError) else 'validation_failed_no_private_diagnostics'}), file=sys.stderr)
        sys.exit(1)

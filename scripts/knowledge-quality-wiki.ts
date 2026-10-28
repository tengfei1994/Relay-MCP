/**
 * Read-only Wiki provenance audit. No HTTP list call: list would adopt pages.
 * Reference-integrity violations are distinct from human-review signals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Row, type Source, argumentsFor, codeBlocks, countBy, isolatedPath, loadSources,
  nullable, openReadOnly, parseReferences, requireQuality,
  safeFailure, savePrivate, sha, text, sameOrGlobal,
} from "./knowledge-quality-common.js";

export interface Mapping {
  id: string; externalId: string; knowledgeBaseId: string; status: string; verifiedAt: string | null;
  projectId: string | null; environment: string | null; version: string | null; topicId: string | null;
  solution: string | null; module: string | null; rawSha256: string; normalizedSha256: string;
  chunks: string[]; malformedChunks: boolean; localSources: Source[];
}
export interface Chunk { id: string; documentId: string; knowledgeBaseId: string; enabled: boolean; ready: boolean; deleted: boolean; }
export interface AuditInput {
  knowledgeBaseId: string; pages: Row[]; controls: Row[]; mappings: Mapping[]; chunks: Chunk[];
}
export function auditWiki(input: AuditInput) {
  const byExternal = new Map<string, Mapping[]>(), byId = new Map(input.mappings.map(mapping => [mapping.id, mapping]));
  for (const mapping of input.mappings) byExternal.set(mapping.externalId, [...(byExternal.get(mapping.externalId) ?? []), mapping]);
  const prefix = "engine-wiki:" + sha(input.knowledgeBaseId).slice(0, 16) + ":";
  const controls = new Map(input.controls.filter(control => text(control.id).startsWith(prefix)).map(control =>
    [nullable(control.external_slug) ?? "relay-" + text(control.id).slice(prefix.length), control]));
  const chunks = new Map(input.chunks.map(chunk => [chunk.id, chunk]));
  const pages = input.pages.map(page => {
    const flags = new Set<string>(), review = new Set<string>(), information = new Set<string>();
    const control = controls.get(text(page.slug)), remoteRefs = parseReferences(page.source_refs);
    const localRefs = parseReferences(control?.source_refs_json), chunkRefs = parseReferences(page.chunk_refs);
    if (remoteRefs.malformed || localRefs.malformed) flags.add("malformed_source_references");
    if (chunkRefs.malformed) flags.add("malformed_chunk_references");
    if (remoteRefs.values.length > 100) flags.add("source_reference_limit_exceeded");
    if (!remoteRefs.values.length) information.add("upstream_source_references_empty");
    const selected = new Map<string, Mapping>(), missing = new Set<string>();
    for (const ref of remoteRefs.values) {
      const externalId = ref.split("|", 1)[0], candidates = byExternal.get(externalId) ?? [];
      if (candidates.length === 0) { flags.add("unmapped_source_reference"); missing.add(externalId); continue; }
      if (candidates.length > 1) flags.add("ambiguous_external_mapping");
      for (const mapping of candidates) selected.set(mapping.id, mapping);
    }
    for (const ref of localRefs.values) {
      const mapping = byId.get(ref);
      if (!mapping) { flags.add("unmapped_control_source_reference"); missing.add(ref); }
      else selected.set(mapping.id, mapping);
    }
    if (!remoteRefs.values.length && !localRefs.values.length) flags.add("no_source_references");
    let validSources = 0;
    const mappingDetails = [...selected.values()].map(mapping => {
      const sourceFlags: string[] = [];
      if (mapping.status !== "published") sourceFlags.push("source_not_published");
      if (!mapping.verifiedAt) sourceFlags.push("source_not_verified");
      if (mapping.knowledgeBaseId !== input.knowledgeBaseId) sourceFlags.push("source_wrong_knowledge_base");
      if (!mapping.projectId && mapping.environment) sourceFlags.push("source_invalid_scope");
      if (mapping.malformedChunks || mapping.chunks.length === 0) sourceFlags.push("source_chunk_proof_missing_or_malformed");
      const local = mapping.localSources;
      if (local.length === 0) information.add("source_bytes_not_available_for_content_check");
      if (local.length && (!/^[0-9a-f]{64}$/.test(mapping.rawSha256) || local.some(source => source.sourceSha256 !== mapping.rawSha256)))
        sourceFlags.push("source_raw_hash_mismatch");
      if (local.some(source => source.projectId !== mapping.projectId || source.environment !== mapping.environment || source.version !== mapping.version))
        sourceFlags.push("source_mapping_metadata_mismatch");
      for (const flag of sourceFlags) flags.add(flag);
      if (sourceFlags.length === 0) validSources++;
      return { mappingId: mapping.id, externalDocumentId: mapping.externalId, localSourceIds: local.map(source => source.id),
        rawSha256: mapping.rawSha256, normalizedSha256: mapping.normalizedSha256, version: mapping.version,
        status: mapping.status, verified: Boolean(mapping.verifiedAt), flags: sourceFlags,
        sourceBodyHashes: local.map(source => source.bodySha256) };
    });
    const selectedRows = [...selected.values()];
    const scopes = new Set(selectedRows.filter(mapping => mapping.projectId || mapping.environment)
      .map(mapping => JSON.stringify([mapping.projectId, mapping.environment])));
    if (scopes.size > 1) flags.add("mixed_project_or_environment_sources");
    if (control) {
      const scope = { projectId: nullable(control.project_id), environment: nullable(control.environment) };
      if (selectedRows.some(mapping => !sameOrGlobal(mapping, scope))) flags.add("source_outside_control_scope");
      for (const [column, key] of [["product_version", "version"], ["topic_id", "topicId"], ["solution", "solution"], ["module", "module"]] as const) {
        if (nullable(control[column]) && selectedRows.some(mapping => mapping[key] !== nullable(control[column])))
          flags.add("source_outside_control_" + key);
      }
      if (control.status === "published" && Number(control.current_revision) !== Number(page.version))
        flags.add("published_revision_differs_from_engine");
      else if (Number(control.current_revision) !== Number(page.version)) information.add("draft_revision_differs_from_engine");
    } else information.add("not_adopted_into_relay");
    const knownChunks = new Map<string, Set<string>>();
    for (const mapping of selectedRows) for (const chunkId of mapping.chunks) {
      const owners = knownChunks.get(chunkId) ?? new Set<string>(); owners.add(mapping.externalId); knownChunks.set(chunkId, owners);
    }
    const chunkObservations: Array<{ chunkId: string; category: string }> = [];
    for (const chunkId of chunkRefs.values) {
      const owners = knownChunks.get(chunkId), chunk = chunks.get(chunkId);
      const ownerMappings = chunk ? byExternal.get(chunk.documentId) ?? [] : [];
      const retiredOwner = ownerMappings.length > 0 && ownerMappings.every(mapping => mapping.status === "deprecated");
      let category = "current_mapping_verified_chunk";
      if (!chunk) category = "physical_chunk_missing";
      else if (retiredOwner) category = chunk.deleted ? "retired_source_deleted_chunk" : "retired_source_retained_chunk";
      else if (!ownerMappings.length) category = "unmapped_upstream_source_chunk";
      else if (!owners) category = selectedRows.some(mapping => mapping.externalId === chunk.documentId)
        ? "cited_current_source_chunk_without_mapping_proof" : "chunk_owner_not_cited";
      else if (!owners.has(chunk.documentId)) category = "chunk_owner_mismatch";
      else if (chunk.deleted || !chunk.enabled || !chunk.ready) category = "current_source_chunk_unavailable";
      chunkObservations.push({ chunkId, category });
      if (!owners) flags.add("chunk_not_in_source_mapping");
      if (!chunk || chunk.deleted || !chunk.enabled || !chunk.ready || chunk.knowledgeBaseId !== input.knowledgeBaseId)
        flags.add("chunk_missing_disabled_or_not_ready");
      if (chunk && owners && !owners.has(chunk.documentId)) flags.add("chunk_document_mismatch");
    }
    if (chunkRefs.values.length === 0) information.add("no_chunk_level_references");
    const versions = [...new Set(selectedRows.map(mapping => mapping.version).filter((value): value is string => Boolean(value)))].sort();
    if (versions.length > 1) review.add("mixed_version_sources_need_explicit_comparison_review");
    const body = text(page.content);
    const unbackedVersions = [...new Set([...body.matchAll(/\b(2[0-9]\.[0-9]{1,2})\b/g)].map(match => match[1]))].filter(value => !versions.includes(value));
    if (unbackedVersions.length) review.add("version_literal_not_in_cited_source_metadata");
    const localSources = [...new Map(selectedRows.flatMap(mapping => mapping.localSources).map(source => [source.id, source])).values()];
    const allBytesAvailable = selectedRows.length > 0 && missing.size === 0 && selectedRows.every(mapping => mapping.localSources.length > 0);
    const code = codeBlocks(body).map(block => ({
      sha256: block.sha256, bytes: Buffer.byteLength(block.content),
      exactExcerptInCitedLocalBody: localSources.some(source => source.body.replace(/\r\n/g, "\n").includes(block.content)),
    }));
    if (allBytesAvailable && code.some(block => !block.exactExcerptInCitedLocalBody)) review.add("code_block_not_exact_cited_source_excerpt");
    const identifiers = [...new Set([...body.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map(match => match[1]))];
    const absentIdentifiers = identifiers.filter(identifier => !localSources.some(source => source.body.includes(identifier) || source.title.includes(identifier)));
    if (allBytesAvailable && absentIdentifiers.length) review.add("identifier_not_literal_in_cited_sources");
    return {
      enginePageId: text(page.id), slugSha256: sha(text(page.slug)), contentSha256: sha(body), contentBytes: Buffer.byteLength(body),
      revision: Number(page.version), localPageId: control ? text(control.id) : null, localStatus: control ? text(control.status) : "unadopted",
      lastEditSource: ["auto", "manual", "system", "llm", "user"].includes(text(page.last_edit_source)) ? text(page.last_edit_source) : "other_or_absent",
      referenceCounts: { remote: remoteRefs.values.length, local: localRefs.values.length, resolvedDistinctSources: selected.size,
        validPublishedVerifiedDistinctSources: validSources, missingDistinctSources: missing.size, chunkReferences: chunkRefs.values.length },
      chunkObservations, mappings: mappingDetails, missingSourceIdHashes: [...missing].sort().map(sha), chunkIds: chunkRefs.values,
      integrityFlags: [...flags].sort(), reviewSignals: [...review].sort(), information: [...information].sort(),
      literalChecks: { completeCitedSourceBytesAvailable: allBytesAvailable, codeBlocks: code,
        identifierCount: identifiers.length, absentIdentifierCount: allBytesAvailable ? absentIdentifiers.length : null,
        absentIdentifierHashes: allBytesAvailable ? absentIdentifiers.slice(0, 100).sort().map(sha) : [],
        versionLiteralWithoutCitedVersionCount: unbackedVersions.length },
      factualAccuracy: "not_evaluated", unsupportedFactualClaimCount: null,
      claimLevelCitationCoverage: "not_evaluated_no_claim_annotations",
    };
  });
  const population = (selected: typeof pages) => ({ pages: selected.length, passingIntegrity: selected.filter(page => !page.integrityFlags.length).length, integrityFlags: countBy(selected.flatMap(page => page.integrityFlags)), reviewSignals: countBy(selected.flatMap(page => page.reviewSignals)), chunkCategories: countBy(selected.flatMap(page => page.chunkObservations.map(item => item.category))) });
  const withReferences = pages.filter(page => page.referenceCounts.remote + page.referenceCounts.local > 0);
  const valid = pages.filter(page => page.integrityFlags.length === 0);
  const allSourceCount = pages.reduce((sum, page) => sum + page.referenceCounts.resolvedDistinctSources + page.referenceCounts.missingDistinctSources, 0);
  const validSourceCount = pages.reduce((sum, page) => sum + page.referenceCounts.validPublishedVerifiedDistinctSources, 0);
  return { schemaVersion: 1, kind: "wiki_reference_integrity_not_factual_review", knowledgeBaseId: input.knowledgeBaseId,
    summary: { populations: { currentAdoptedReviewOrPublished: population(pages.filter(page => ["draft", "published"].includes(page.localStatus))), publishedControlRows: population(pages.filter(page => page.localStatus === "published")), unadoptedOrDeprecatedInventory: population(pages.filter(page => ["unadopted", "deprecated"].includes(page.localStatus))) }, pages: pages.length, byLocalStatus: countBy(pages.map(page => page.localStatus)), pagesWithAnyReference: withReferences.length,
      pagesPassingAllIntegrityChecks: valid.length, pagesWithIntegrityFlags: pages.length - valid.length,
      integrityFlags: countBy(pages.flatMap(page => page.integrityFlags)), reviewSignals: countBy(pages.flatMap(page => page.reviewSignals)),
      information: countBy(pages.flatMap(page => page.information)), pagesWithReviewSignals: pages.filter(page => page.reviewSignals.length > 0).length,
      sourceReferenceCoverage: { validPublishedVerifiedReferences: validSourceCount, allResolvedOrMissingReferences: allSourceCount,
        ratio: allSourceCount ? validSourceCount / allSourceCount : null, unit: "distinct_source_per_page_not_claims" },
      factualAccuracy: "not_evaluated", unsupportedFactualClaimCount: null, modelCalls: 0, retrievalCalls: 0, credentialReads: 0 },
    pages };
}
function selfTestSource(): Source {
  const body = "TABLE_NAME(1)";
  return { id: "local-a", title: "TABLE_NAME", body, bodySha256: sha(body), sourceSha256: sha("raw"),
    sourcePath: "21.1/a", version: "21.1", solution: null, module: null, language: "en", projectId: "p1", environment: "nonprod",
    lifecycle: "published", parserVersion: "test", sourceFormat: "test", citationSha256: sha("citation") };
}
export function selfTest(): void {
  const source = selfTestSource(), mapping: Mapping = { id: "map-a", externalId: "up-a", knowledgeBaseId: "kb",
    status: "published", verifiedAt: "2026-10-25T00:00:00Z", projectId: "p1", environment: "nonprod",
    version: "21.1", topicId: null, solution: null, module: null, rawSha256: source.sourceSha256,
    normalizedSha256: source.bodySha256, chunks: ["chunk-a"], malformedChunks: false, localSources: [source] };
  const ticks = String.fromCharCode(96).repeat(3);
  const page = { id: "page-a", slug: "a", content: ticks + "vgl\nTABLE_NAME(1)\n" + ticks,
    source_refs: JSON.stringify(["up-a|Title ignored"]), chunk_refs: JSON.stringify(["chunk-a"]), version: 1 };
  const chunk: Chunk = { id: "chunk-a", documentId: "up-a", knowledgeBaseId: "kb", ready: true, enabled: true, deleted: false };
  const input: AuditInput = { knowledgeBaseId: "kb", pages: [page], controls: [], mappings: [mapping], chunks: [chunk] };
  const audit = (changes: Partial<AuditInput>) => auditWiki({ ...input, ...changes }).pages[0];
  assert.equal(audit({}).integrityFlags.length, 0);
  assert.equal(audit({ pages: [{ ...page, source_refs: Buffer.from(page.source_refs), chunk_refs: Buffer.from(page.chunk_refs) }] }).integrityFlags.length, 0, "SQLite JSON BLOBs are parsed, not treated as malformed references");
  assert.equal(audit({}).literalChecks.codeBlocks[0].exactExcerptInCitedLocalBody, true);
  assert(audit({ mappings: [] }).integrityFlags.includes("unmapped_source_reference"));
  assert(audit({ mappings: [{ ...mapping, status: "deprecated" }] }).integrityFlags.includes("source_not_published"));
  assert.equal(audit({ mappings: [{ ...mapping, status: "deprecated" }] }).chunkObservations[0].category, "retired_source_retained_chunk");
  assert.equal(audit({ mappings: [] }).chunkObservations[0].category, "unmapped_upstream_source_chunk");
  assert.equal(audit({ chunks: [] }).chunkObservations[0].category, "physical_chunk_missing");
  assert(audit({ mappings: [{ ...mapping, verifiedAt: null }] }).integrityFlags.includes("source_not_verified"));
  assert(audit({ mappings: [{ ...mapping, rawSha256: sha("wrong") }] }).integrityFlags.includes("source_raw_hash_mismatch"));
  assert(audit({ chunks: [{ ...chunk, documentId: "foreign" }] }).integrityFlags.includes("chunk_document_mismatch"));
  assert(audit({ chunks: [{ ...chunk, ready: false }] }).integrityFlags.includes("chunk_missing_disabled_or_not_ready"));
  assert(audit({ pages: [{ ...page, source_refs: null, chunk_refs: null }] }).integrityFlags.includes("no_source_references"));
  assert(audit({ pages: [{ ...page, source_refs: "{}" }] }).integrityFlags.includes("malformed_source_references"));
  const second = { ...mapping, id: "map-b", externalId: "up-b", projectId: "p2", localSources: [] };
  assert(audit({ mappings: [mapping, second], pages: [{ ...page, source_refs: JSON.stringify(["up-a", "up-b"]) }] })
    .integrityFlags.includes("mixed_project_or_environment_sources"));
  const global = { ...second, projectId: null, environment: null };
  assert(!audit({ mappings: [mapping, global], pages: [{ ...page, source_refs: JSON.stringify(["up-a", "up-b"]) }] })
    .integrityFlags.includes("mixed_project_or_environment_sources"));
  const changedCode = audit({ pages: [{ ...page, content: ticks + "vgl\nNEW_FUNCTION(1)\n" + ticks }] });
  assert(changedCode.reviewSignals.includes("code_block_not_exact_cited_source_excerpt"));
  assert.equal(changedCode.integrityFlags.length, 0, "generated code is review evidence, not an automatic fact failure");
  assert.equal(changedCode.unsupportedFactualClaimCount, null);
  const control = { id: "engine-wiki:" + sha("kb").slice(0, 16) + ":a", external_slug: "a", status: "published",
    source_refs_json: JSON.stringify(["map-a"]), current_revision: 2, project_id: "p1", environment: "nonprod" };
  assert(audit({ controls: [control] }).integrityFlags.includes("published_revision_differs_from_engine"));
  assert(audit({ controls: [{ ...control, current_revision: 1, product_version: "21.3" }] }).integrityFlags.includes("source_outside_control_version"));
  assert(audit({ controls: [{ ...control, current_revision: 1, project_id: "p2" }] }).integrityFlags.includes("source_outside_control_scope"));
  process.stdout.write(JSON.stringify({ status: "passed", selfTest: "knowledge-quality-wiki", modelCalls: 0 }) + "\n");
}
function main(): void {
  if (process.argv.slice(2).join(" ") === "--self-test") { selfTest(); return; }
  const args = argumentsFor(["--db", "--engine-db", "--knowledge-base-id", "--report"]);
  const relayPath = isolatedPath(args.get("--db")), enginePath = isolatedPath(args.get("--engine-db")), output = isolatedPath(args.get("--report"), true);
  const knowledgeBaseId = args.get("--knowledge-base-id") ?? "";
  requireQuality(/^[a-zA-Z0-9-]{1,100}$/.test(knowledgeBaseId), "invalid_knowledge_base_id");
  const relay = openReadOnly(relayPath), engine = openReadOnly(enginePath), startedAt = new Date().toISOString();
  let result: ReturnType<typeof auditWiki>;
  try {
    relay.exec("BEGIN"); engine.exec("BEGIN");
    const sources = loadSources(relay), sourceById = new Map(sources.map(source => [source.id, source]));
    const links = relay.prepare("SELECT document_id,local_document_id FROM knowledge_migration_documents WHERE document_id IS NOT NULL").all() as Row[];
    const mappingRows = relay.prepare("SELECT * FROM knowledge_weknora_documents").all() as Row[];
    const mappings: Mapping[] = mappingRows.map(row => {
      const refs = parseReferences(row.external_chunk_ids_json), id = text(row.id);
      const linked = [...new Set(links.filter(link => link.document_id === id).map(link => text(link.local_document_id)))];
      // Unlinked direct uploads are not silently assigned to a similarly named local document.
      const localSources = linked.map(localId => sourceById.get(localId)).filter((source): source is Source => Boolean(source));
      return { id, externalId: text(row.external_document_id), knowledgeBaseId: text(row.external_knowledge_base_id),
        status: text(row.status), verifiedAt: nullable(row.upstream_verified_at), projectId: nullable(row.project_id), environment: nullable(row.environment),
        version: nullable(row.product_version), topicId: nullable(row.topic_id), solution: nullable(row.solution), module: nullable(row.module),
        rawSha256: text(row.raw_sha256), normalizedSha256: text(row.normalized_content_sha256), chunks: refs.values,
        malformedChunks: refs.malformed, localSources };
    });
    const pages = engine.prepare("SELECT id,slug,content,source_refs,chunk_refs,version,last_edit_source FROM wiki_pages WHERE knowledge_base_id=? AND deleted_at IS NULL ORDER BY id").all(knowledgeBaseId) as Row[];
    const controls = relay.prepare("SELECT id,external_slug,status,project_id,environment,product_version,topic_id,solution,module,source_refs_json,current_revision FROM knowledge_wiki_pages").all() as Row[];
    const chunks = (engine.prepare("SELECT id,knowledge_id,knowledge_base_id,is_enabled,index_status,deleted_at FROM chunks WHERE knowledge_base_id=?").all(knowledgeBaseId) as Row[]).map(row => ({
      id: text(row.id), documentId: text(row.knowledge_id), knowledgeBaseId: text(row.knowledge_base_id),
      enabled: Number(row.is_enabled) === 1, ready: row.index_status === "ready", deleted: row.deleted_at != null,
    }));
    result = auditWiki({ knowledgeBaseId, pages, controls, mappings, chunks });
    relay.exec("COMMIT"); engine.exec("COMMIT");
  } finally { relay.close(); engine.close(); }
  const report = { ...result, startedAt, completedAt: new Date().toISOString(),
    snapshotConsistency: "independent_read_transactions_cross_database_atomicity_not_claimed",
    status: result.summary.pagesWithIntegrityFlags ? "completed_with_reference_integrity_findings" : "completed_reference_checks_only",
    scope: "upstream_current_kb_inventory_includes_hidden_and_retired_test_pages_not_only_user_visible_pages" };
  const saved = savePrivate(output, report);
  process.stdout.write(JSON.stringify({ status: report.status, report: saved, summary: report.summary }) + "\n");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { main(); } catch (error) { safeFailure(error); }
}

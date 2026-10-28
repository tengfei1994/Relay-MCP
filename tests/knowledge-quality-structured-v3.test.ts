import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { budgetSummary, validateFrozenRows, verifySourceIdentity, targetIdentity, SOURCE_PREFIX, TARGET_ENVIRONMENT, previewRequest, verifyPreviewCalibration, candidateLayout, validatePreparationIdentity } from "../scripts/knowledge-quality-structured-v3.ts";

const row = (suffix: string) => ({ bulkSourceId: "source-" + suffix, targetLocalId: "old-" + suffix, sourcePath: SOURCE_PREFIX + suffix + ".htm", innerPath: suffix + ".htm", rawSha256: "a".repeat(64), version: "21.3", projectId: "1", environment: "nonprod-full-213" });

test("structured-v3 preserves the exact frozen raw source allowlist", () => {
  const original = [row("b"), row("a")];
  assert.equal(validateFrozenRows(original, 2).length, 2);
  assert.throws(() => validateFrozenRows([row("a"), row("a")], 2), /duplicate_source_path/);
  assert.throws(() => validateFrozenRows([{ ...row("a"), innerPath: "../a.htm" }], 1), /unsafe_inner_path/);
  assert.throws(() => validateFrozenRows([{ ...row("a"), sourcePath: "other/a.htm" }], 1), /source_layout_changed/);
  assert.throws(() => validateFrozenRows([{ ...row("a"), rawSha256: "" }], 1), /invalid_raw_hash/);
  assert.throws(() => validateFrozenRows(original, 5372), /source_count_mismatch/);
  verifySourceIdentity(original, original.map(source => ({ ...source, sourceParserVersion: "html-3", environment: TARGET_ENVIRONMENT })), 2);
  assert.throws(() => verifySourceIdentity(original, original.map(source => ({ ...source, sourceParserVersion: "html-3", environment: TARGET_ENVIRONMENT, rawSha256: "b".repeat(64) })), 2), /raw_identity_changed/);
});

test("structured target identity includes raw bytes, parsed bytes and parser version", () => {
  const source = row("a");
  const id = targetIdentity(source.sourcePath, source.rawSha256, "b".repeat(64));
  assert.match(id, /^product-document-full213-v3-/);
  assert.equal(id, targetIdentity(source.sourcePath, source.rawSha256, "b".repeat(64)));
  assert.notEqual(id, targetIdentity(source.sourcePath, source.rawSha256, "c".repeat(64)));
});

test("budget counts only indexable chunks in batches of five and retains all prior calls", () => {
  const result = budgetSummary([{ chunkCount: 9, indexableChunks: 8, embeddingBatches: 2 }, { chunkCount: 6, indexableChunks: 6, embeddingBatches: 2 }], 2719);
  assert.equal(result.rawPreviewChunks, 15);
  assert.equal(result.indexableChunks, 14);
  assert.equal(result.logicalCallsNoRetry, 4);
  assert.equal(result.priorDurableCalls, 2719);
  assert.equal(result.cumulativeCallsNoRetry, 2723);
  assert.equal(result.remainingAuthorizedCalls, 9281);
  assert.equal(result.worstCaseCallsWithOneRetry, 2727);
  assert.equal(result.modelCallsPerformed, 0);
  assert.equal(result.requiresAdditionalAuthorization, false);
  assert.throws(() => budgetSummary([], 0), /prior_ledger_count_below_frozen_floor/);
  assert.throws(() => budgetSummary([{ chunkCount: 9, indexableChunks: 8, embeddingBatches: 1 }], 2719), /embedding_batch_count_mismatch/);
});

test("budget refuses to assume the 12000 cap resets for structured-v3", () => {
  const result = budgetSummary([{ chunkCount: 50000, indexableChunks: 50000, embeddingBatches: 10000 }], 2719);
  assert.equal(result.authorizedCallCap, 12000);
  assert.equal(result.cumulativeCallsNoRetry, 12719);
  assert.equal(result.requiresAdditionalAuthorization, true);
  assert.equal(result.deficitCallsNoRetry, 719);
});


test("HTTP calibration uses the actual preview envelope and rejects truncation or changed chunk bytes", () => {
  assert.deepEqual(previewRequest("sample"), { text: "sample", chunking_config: { chunk_size: 0, chunk_overlap: 0, separators: null, enable_parent_child: false } });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const expected = { chunkCount: 2, indexableChunks: 1, embeddingBatches: 1, rawChunkHashes: [hash("\u0085"), hash("body")], indexableChunkHashes: [hash("body")] };
  const response = { success: true, data: { stats: { count: 2 }, chunks: [{ content: "\u0085" }, { content: "body" }] } };
  assert.equal(verifyPreviewCalibration(expected, response).indexableChunks, 1);
  assert.throws(() => verifyPreviewCalibration(expected, { ...response, data: { ...response.data, stats: { count: 2, truncated_to: 2 } } }), /preview_truncated/);
  assert.throws(() => verifyPreviewCalibration(expected, { ...response, data: { ...response.data, chunks: [{ content: " " }, { content: "body" }] } }), /preview_chunk_bytes_differ/);
});


test("candidate directories reject escape and cannot select the preserved candidate a", () => {
  for (const candidate of ["v3-a", "v3-b/../a", "../v3-b", "v3-b\\..", "/tmp/v3-b", "V3-B", "v3-bb", "v3-1", "", "v3-b "]) {
    assert.throws(() => candidateLayout(candidate), /invalid_candidate/);
  }
  assert.equal(candidateLayout("v3-b").directory, "/home/ftd/relay-knowledge-engine-nonprod/bulk-structured-v3/candidate-v3-b");
  assert.equal(candidateLayout("v3-z").candidate, "v3-z");
});

test("candidates share only unchanged raw preparation paths and isolate every output/runtime", () => {
  const original = candidateLayout(), b = candidateLayout("v3-b"), c = candidateLayout("v3-c");
  assert.equal(original.directory, "/home/ftd/relay-knowledge-engine-nonprod/bulk-structured-v3");
  for (const layout of [b, c]) {
    assert.equal(layout.inputs, original.inputs);
    assert.equal(layout.preparation, original.preparation);
    assert.equal(layout.plan, original.plan);
    assert.equal(layout.sharedInputsReadOnly, true);
    assert.equal(layout.codeRoot, layout.directory + "/parser-runtime");
  }
  for (const name of ["knowledge.db", "freeze.json", "manifest.jsonl", "budget-report.json"]) {
    assert.equal(new Set([original, b, c].map(layout => layout.directory + "/" + name)).size, 3);
  }
  assert.equal(new Set([original.codeRoot, b.codeRoot, c.codeRoot]).size, 3);
});

test("reused preparation remains pinned to the original archive and 5372 raw identities", () => {
  const preparation = Object.freeze({ sourceCount: 5372, rawBytes: 237579395, archiveSha256: "256b2a52562f321f2788205605436e5e00272060ad76c20263c637672c4b7342", sourceManifestSha256: "712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009", status: "raw_sources_prepared_no_parser_execution", targetProjectId: "1", targetEnvironment: "nonprod-full-213-v3" });
  const before = JSON.stringify(preparation);
  validatePreparationIdentity(preparation);
  assert.equal(JSON.stringify(preparation), before);
  assert.throws(() => validatePreparationIdentity({ ...preparation, sourceCount: 5371 }), /shared_preparation_identity_changed/);
  assert.throws(() => validatePreparationIdentity({ ...preparation, archiveSha256: "a".repeat(64) }), /shared_preparation_identity_changed/);
  assert.throws(() => validatePreparationIdentity({ ...preparation, sourceManifestSha256: "b".repeat(64) }), /shared_preparation_identity_changed/);
});


test("candidate prepare is rejected before any host or filesystem access", () => {
  const driver = fileURLToPath(new URL("../scripts/knowledge-quality-structured-v3.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", driver, "--phase", "prepare", "--candidate", "v3-b"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { status: "failed", code: "candidate_preparation_is_read_only" });
});

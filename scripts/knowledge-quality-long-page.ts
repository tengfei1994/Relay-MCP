/** Native CPU-only budget for the frozen page rejected by the preview HTTP size cap. */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeProductMarkup } from "../src/knowledge/weknora-markdown.js";
import { isolatedPath, openReadOnly, record, requireQuality, safeFailure, savePrivate, sha, text, NONPROD_ROOT } from "./knowledge-quality-common.js";

const goSource = `package main
import (
  "crypto/sha256"
  "encoding/hex"
  "encoding/json"
  "os"
  "unicode/utf8"
  "github.com/Tencent/WeKnora/internal/infrastructure/chunker"
  "github.com/Tencent/WeKnora/internal/infrastructure/docparser"
)
func hash(s string) string { h:=sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func main() {
  var input map[string]string
  if json.NewDecoder(os.Stdin).Decode(&input)!=nil { os.Exit(2) }
  normalized:=docparser.NormalizeHTMLTables(chunker.NormalizeLineEndings(input["content"]))
  cfg:=chunker.NormalizeSplitterConfig(chunker.SplitterConfig{})
  chunks,diag:=chunker.SplitWithDiagnostics(normalized,cfg)
  hashes:=make([]string,0,len(chunks)); count:=0; tokens:=0; min:=0; max:=0
  language:=chunker.DetectLanguage(normalized)
  for _,chunk:=range chunks {
    hashes=append(hashes,hash(chunk.Content))
    n:=utf8.RuneCountInString(chunk.Content)
    if min==0 || n<min { min=n };if n>max { max=n }
    embedded:=chunk.EmbeddingContent()
    if embedded!="" { count++;tokens+=chunker.ApproxTokenCount(embedded,language) }
  }
  result:=map[string]interface{}{
    "chunkCount":len(chunks),"nonemptyEmbeddingChunks":count,"embeddingBatches":(count+4)/5,
    "batchEmbedSize":5,"approxTokens":tokens,"chunkingInputSha256":hash(normalized),
    "chunkingInputChars":utf8.RuneCountInString(normalized),"chunkingInputBytes":len(normalized),
    "chunkHashes":hashes,"minimumChunkChars":min,"maximumChunkChars":max,
    "selectedTier":diag.SelectedTier,"rejectedTierCount":len(diag.Rejected),
    "config":map[string]interface{}{"chunkSize":cfg.ChunkSize,"chunkOverlap":cfg.ChunkOverlap,
      "separators":cfg.Separators,"strategy":cfg.Strategy,"tokenLimit":cfg.TokenLimit,
      "languages":cfg.Languages,"enableParentChild":false},
  }
  if json.NewEncoder(os.Stdout).Encode(result)!=nil { os.Exit(3) }
}
`;
function main(): void {
  requireQuality(process.argv.length === 2, "no_arguments_supported_pinned_nonproduction_probe");
  const manifestPath = isolatedPath(NONPROD_ROOT + "/runtime/full-213/manifest.jsonl");
  const output = isolatedPath(NONPROD_ROOT + "/runtime/full-213/long-page-budget.json", true);
  const manifestBytes = fs.readFileSync(manifestPath, "utf8");
  requireQuality(sha(manifestBytes) === "712d0e78e9928123c402b748a3e966ef99eaf30121a7ff4ac76be3fe0ab30009", "frozen_manifest_changed");
  const rows = manifestBytes.trim().split(/\r?\n/).map(line => record(JSON.parse(line)));
  const overLimit = rows.filter(row => Number(row.normalizedChars) > 65536);
  requireQuality(overLimit.length === 1, "expected_exactly_one_long_page");
  const entry = overLimit[0], db = openReadOnly(isolatedPath(NONPROD_ROOT + "/bulk/knowledge.db"));
  let body = "";
  try { body = text(record(db.prepare("SELECT body FROM knowledge_documents WHERE id=?").get(entry.bulkSourceId)).body); }
  finally { db.close(); }
  requireQuality(sha(body) === entry.bodySha256, "body_hash_mismatch");
  const normalized = normalizeProductMarkup(body);
  requireQuality(sha(normalized) === entry.normalizedSha256 && [...normalized].length === entry.normalizedChars, "normalized_source_mismatch");
  const engine = NONPROD_ROOT + "/runtime/knowledge-engine";
  const sourceRoot = isolatedPath(engine + "/build-log-safety-v1/regression-source");
  const helperDir = sourceRoot + "/cmd/relay-quality-long-page";
  if (!fs.existsSync(helperDir)) fs.mkdirSync(helperDir, { mode: 0o700 });
  const helper = helperDir + "/main.go";
  if (fs.existsSync(helper)) requireQuality(sha(fs.readFileSync(helper, "utf8")) === sha(goSource), "helper_source_changed");
  else fs.writeFileSync(helper, goSource, { mode: 0o600, flag: "wx" });
  const go = isolatedPath(engine + "/build/toolchain/go/bin/go");
  const cache = isolatedPath(engine + "/build/cache/go-build"), gopath = isolatedPath(engine + "/build/cache/gopath");
  const startedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify({ stage: "native_chunker_cpu_only", sourceCount: 1, modelCalls: 0 }) + "\n");
  const result = spawnSync(go, ["run", "-mod=readonly", "./cmd/relay-quality-long-page"], {
    cwd: sourceRoot, input: JSON.stringify({ content: normalized }), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 240000,
    env: { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOPATH: gopath, GOCACHE: cache,
      GOMAXPROCS: "2", GOMEMLIMIT: "2GiB", LOG_LEVEL: "warn", LLM_DEBUG_LOG: "false", WEKNORA_LLM_STREAM_RAW_DUMP: "false" },
  });
  if (result.status !== 0) {
    process.stderr.write(JSON.stringify({ stage: "native_chunker_failed", exitCode: result.status, stderrBytes: Buffer.byteLength(result.stderr ?? ""), stderrSha256: sha(result.stderr ?? "") }) + "\n");
    requireQuality(false, "native_chunker_failed");
  }
  const native = record(JSON.parse(result.stdout));
  requireQuality(Number(native.chunkCount) > 0 && Number(native.embeddingBatches) > 0, "native_budget_empty");
  const sourceFiles = ["internal/infrastructure/chunker/strategy.go", "internal/infrastructure/chunker/splitter.go", "internal/infrastructure/docparser/html_table_normalizer.go"];
  const report = { schemaVersion: 1, status: "computed_native_cpu_only_not_embedding_execution", startedAt, completedAt: new Date().toISOString(),
    method: "NormalizeLineEndings -> NormalizeHTMLTables -> NormalizeSplitterConfig({}) -> SplitWithDiagnostics",
    nativeSourceCommit: "3e22822c1d2397be730c458c7539d0eb8c113a24", sourceManifestSha256: sha(manifestBytes),
    helperSha256: sha(goSource), nativeSourceFiles: sourceFiles.map(path => ({ path, sha256: sha(fs.readFileSync(sourceRoot + "/" + path, "utf8")) })),
    bulkSourceId: entry.bulkSourceId, targetLocalId: entry.targetLocalId, bodySha256: entry.bodySha256,
    normalizedSha256: entry.normalizedSha256, normalizedChars: entry.normalizedChars, ...native,
    logicalCallsNoRetry: native.embeddingBatches, modelCalls: 0, retrievalCalls: 0, credentialReads: 0,
    exclusions: ["retries", "Wiki_generation", "query_embedding", "model_billing_tokenizer_exactness"] };
  requireQuality(sha(fs.readFileSync(manifestPath, "utf8")) === report.sourceManifestSha256, "manifest_changed_during_probe");
  const saved = savePrivate(output, report);
  process.stdout.write(JSON.stringify({ status: report.status, report: saved, normalizedChars: report.normalizedChars,
    chunkCount: native.chunkCount, embeddingBatches: native.embeddingBatches, approxTokens: native.approxTokens, modelCalls: 0 }) + "\n");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { main(); } catch (error) { safeFailure(error); }
}

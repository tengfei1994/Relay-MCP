#!/usr/bin/env bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD_ROOT="${1:?Specify a dedicated build directory}"
mkdir -p "$BUILD_ROOT"
BUILD_ROOT="$(cd "$BUILD_ROOT" && pwd)"
case "$BUILD_ROOT" in /|"$HOME") echo 'Refusing an unsafe build root' >&2; exit 1;; esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'Build requires Linux amd64' >&2; exit 1; }
[ ! -d "$BUILD_ROOT/bundle" ] || { echo 'Bundle already exists; use a fresh build root for immutable artifacts' >&2; exit 1; }
for tool in curl tar gcc g++ make python3 node pkg-config git; do command -v "$tool" >/dev/null || { echo "Required build tool missing: $tool" >&2; exit 1; }; done
pkg-config --exists sqlite3 || { echo 'SQLite development headers are required on the build host' >&2; exit 1; }
python3 "$SCRIPT_DIR/apply-patches.py" --verify-assets
mapfile -t PIN < <(python3 - "$SCRIPT_DIR/upstream-lock.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
for k in ['version','sourceCommit','sourceArchiveSha256','goVersion','goArchiveSha256']:
 print(x[k])
PY
)
VERSION="${PIN[0]}" COMMIT="${PIN[1]}" SOURCE_SHA="${PIN[2]}" GO_VERSION="${PIN[3]}" GO_SHA="${PIN[4]}"
mkdir -p "$BUILD_ROOT/downloads" "$BUILD_ROOT/toolchain" "$BUILD_ROOT/cache"
GO_ARCHIVE="$BUILD_ROOT/downloads/$GO_VERSION.linux-amd64.tar.gz"
if [ ! -f "$GO_ARCHIVE" ]; then curl --fail --silent --show-error --location --connect-timeout 15 --max-time 600 --retry 3 --retry-all-errors --output "$GO_ARCHIVE.partial" "https://go.dev/dl/$GO_VERSION.linux-amd64.tar.gz"; mv "$GO_ARCHIVE.partial" "$GO_ARCHIVE"; fi
printf '%s  %s\n' "$GO_SHA" "$GO_ARCHIVE" | sha256sum --check --status || { echo 'Go archive checksum mismatch' >&2; exit 1; }
if [ ! -x "$BUILD_ROOT/toolchain/go/bin/go" ]; then tar -xzf "$GO_ARCHIVE" -C "$BUILD_ROOT/toolchain"; fi
export PATH="$BUILD_ROOT/toolchain/go/bin:$PATH"
[ "$(go version | awk '{print $3}')" = "$GO_VERSION" ] || { echo 'Go toolchain version mismatch' >&2; exit 1; }
ARCHIVE="$BUILD_ROOT/downloads/weknora-$COMMIT.tar.gz"
if [ ! -f "$ARCHIVE" ]; then
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 600 --retry 3 --retry-all-errors --output "$ARCHIVE.partial" "https://codeload.github.com/Tencent/WeKnora/tar.gz/$COMMIT"
  mv "$ARCHIVE.partial" "$ARCHIVE"
fi
printf '%s  %s\n' "$SOURCE_SHA" "$ARCHIVE" | sha256sum --check --status || { echo 'Upstream source archive checksum mismatch' >&2; exit 1; }
# Always extract fresh verified source. A stale or locally edited checkout cannot
# silently influence the artifact; failed trees remain available for diagnosis.
SOURCE="$(mktemp -d "$BUILD_ROOT/source-$COMMIT.XXXXXX")"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$SOURCE"
python3 "$SCRIPT_DIR/apply-patches.py" "$SOURCE"
CACHE_ROOT="$(cd "$BUILD_ROOT/cache" && pwd -P)"
export GOPATH="$CACHE_ROOT/gopath" GOCACHE="$CACHE_ROOT/go-build" GOTOOLCHAIN=local
export CGO_ENABLED=1 CGO_CFLAGS='-Wno-deprecated-declarations' GOMAXPROCS=2 GOMEMLIMIT=4GiB
cd "$SOURCE"
printf 'Building WeKnora %s (%s) with reviewed model-log policy\n' "$VERSION" "$COMMIT"
go mod download
TEST_LOG="$BUILD_ROOT/model-log-tests.log"
if ! go test -p 2 ./internal/models/api/... >"$TEST_LOG" 2>&1; then
  echo "Upstream model protocol/privacy regression tests failed; inspect private build log: $TEST_LOG" >&2
  exit 1
fi
printf 'Upstream model protocol/privacy regression tests passed\n'
CONTENT_TEST_LOG="$BUILD_ROOT/linked-image-tests.log"
if ! go test -p 2 ./internal/infrastructure/docparser >"$CONTENT_TEST_LOG" 2>&1; then
  echo "Upstream linked-image/content regression tests failed; inspect private build log: $CONTENT_TEST_LOG" >&2
  exit 1
fi
printf 'Upstream linked-image/content regression tests passed\n'
RETRY_TEST_LOG="$BUILD_ROOT/document-retry-tests.log"
RETRY_OPTIONS_PROOF="$BUILD_ROOT/managed-document-retry-options.json"
if ! RELAY_RETRY_OPTIONS_PROOF="$RETRY_OPTIONS_PROOF" go test -p 2 ./internal/application/service -run 'TestRelayManagedDocument|TestDocumentProcessTaskOptions' -count=1 >"$RETRY_TEST_LOG" 2>&1; then
  echo "Managed document task-option regression failed; inspect private build log: $RETRY_TEST_LOG" >&2
  exit 1
fi
if ! RELAY_RETRY_OPTIONS_PROOF="$RETRY_OPTIONS_PROOF" go test -p 2 ./internal/router -run 'TestRelayManagedDocumentSingleQueueAttempt' -count=1 >>"$RETRY_TEST_LOG" 2>&1; then
  echo "Managed single-attempt queue regression failed; inspect private build log: $RETRY_TEST_LOG" >&2
  exit 1
fi
printf 'Managed document single-attempt queue regressions passed\n'
RRF_TEST_LOG="$BUILD_ROOT/keyword-first-rrf-tests.log"
if ! go test -p 2 ./internal/application/service -run 'TestRelayKeywordFirstRRF|TestFuseOrDeduplicate|TestBestRanks|TestRescaleUnboundedScores' -count=1 >"$RRF_TEST_LOG" 2>&1; then
  echo "Keyword-first RRF regressions failed; inspect private build log: $RRF_TEST_LOG" >&2
  exit 1
fi
printf 'Keyword-first RRF defaults and explicit-setting regressions passed\n'
GROUNDING_TEST_LOG="$BUILD_ROOT/wiki-retrieval-tests.log"
if ! go test -p 2 -tags sqlite_fts5 ./internal/application/service ./internal/application/service/chat_pipeline ./internal/application/repository/retriever/sqlite ./internal/types ./internal/container -count=1 >"$GROUNDING_TEST_LOG" 2>&1; then
  echo "Wiki grounding and source-aware retrieval regressions failed; inspect private build log: $GROUNDING_TEST_LOG" >&2
  exit 1
fi
printf 'Wiki provenance, XML retrieval, source-boundary and parameterized SQL regression suites passed\n'
LDFLAGS="-w -s -X github.com/Tencent/WeKnora/internal/handler.Version=$VERSION -X github.com/Tencent/WeKnora/internal/handler.Edition=lite -X github.com/Tencent/WeKnora/internal/handler.CommitID=$COMMIT -X github.com/Tencent/WeKnora/internal/handler.GoVersion=$GO_VERSION -X google.golang.org/protobuf/reflect/protoregistry.conflictPolicy=warn"
go build -p 2 -tags sqlite_fts5 -ldflags "$LDFLAGS" -o "$BUILD_ROOT/WeKnora-lite" ./cmd/server
BUNDLE="$BUILD_ROOT/bundle"
mkdir -p "$BUNDLE/migrations" "$BUNDLE/relay-patches"
cp "$BUILD_ROOT/WeKnora-lite" "$BUNDLE/WeKnora-lite"
cp -r config "$BUNDLE/config"
JIEBA_MODULE="$(go list -m -f '{{.Dir}}' github.com/yanyiwu/gojieba)"
cp -r "$JIEBA_MODULE/deps/cppjieba/dict" "$BUNDLE/dict"
cp -r migrations/sqlite "$BUNDLE/migrations/sqlite"
cp "$SCRIPT_DIR/upstream-lock.json" "$BUNDLE/relay-upstream-lock.json"
cp "$SCRIPT_DIR/patches/"* "$BUNDLE/relay-patches/"
bash scripts/copy-licenses.sh "$BUNDLE"
TOOL_ARCHIVE_ARGS=()
if [ -n "${RELAY_7ZIP_ARCHIVE:-}" ]; then TOOL_ARCHIVE_ARGS=(--archive "$RELAY_7ZIP_ARCHIVE"); fi
node "$SCRIPT_DIR/7zip-install.mjs" "$BUNDLE/tools/7zip" "${TOOL_ARCHIVE_ARGS[@]}"
python3 - "$BUNDLE" "$SCRIPT_DIR/upstream-lock.json" "$TEST_LOG" "$CONTENT_TEST_LOG" "$RETRY_TEST_LOG" "$RETRY_OPTIONS_PROOF" "$RRF_TEST_LOG" "$GROUNDING_TEST_LOG" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); lock=json.loads(pathlib.Path(sys.argv[2]).read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
patches=[{'id':p['id'],'sha256':p['sha256']} for p in lock['patches']]
proof={'schemaVersion':1,'status':'passed','securityPolicy':lock['securityPolicy'],'binarySha256':sha(root/'WeKnora-lite'),
       'testLogSha256':sha(pathlib.Path(sys.argv[3])),'tests':['TestRelayRequestLogOmitsPrivatePayloads','TestRelayModelErrorsOmitPrivateResponseAndURL'],
       'suite':'go test -p 2 ./internal/models/api/...','relayPatches':patches}
(root/'relay-log-safety-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
content_proof={'schemaVersion':1,'status':'passed','policy':'relay-linked-image-hrefs-v1','binarySha256':sha(root/'WeKnora-lite'),
       'testLogSha256':sha(pathlib.Path(sys.argv[4])),'tests':['TestRelayLinkedImageUploadPipelinePreservesStructure','TestRelayLinkedImageInlineBytesRetainOuterHref','TestRelayLinkedImageDataURIRetainsOuterHref'],
       'suite':'go test -p 2 ./internal/infrastructure/docparser','relayPatches':patches}
(root/'relay-content-preservation-proof.json').write_text(json.dumps(content_proof,indent=2)+'\n')
retry_options=json.loads(pathlib.Path(sys.argv[6]).read_text())
if not retry_options.get('managedRetryOptions') or retry_options['managedRetryOptions'][-1] != 0:
 raise RuntimeError('Managed retry-options proof is not zero retries')
retry_proof={'schemaVersion':1,'status':'passed','policy':'relay-managed-document-no-auto-retry-v1','binarySha256':sha(root/'WeKnora-lite'),
       'testLogSha256':sha(pathlib.Path(sys.argv[5])),'actualServiceOptionsSha256':sha(pathlib.Path(sys.argv[6])),
       'tests':['TestRelayManagedDocumentTaskRetryOptions','TestRelayManagedDocumentRetryLeavesOtherPoliciesUnchanged','TestRelayManagedDocumentSingleQueueAttempt'],
       'managedEnvironment':{'RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY':'true'},'queueAttemptsOnRetryableFailure':1,
       'scope':'documentProcessTaskOptions only; provider retry policy unchanged','relayPatches':patches}
(root/'relay-document-retry-proof.json').write_text(json.dumps(retry_proof,indent=2)+'\n')
rrf_proof={'schemaVersion':1,'status':'passed','policy':'relay-keyword-first-rrf-defaults-v1','productContract':'Relay #53 technical keyword priority',
       'binarySha256':sha(root/'WeKnora-lite'),'testLogSha256':sha(pathlib.Path(sys.argv[7])),
       'tests':['TestRelayKeywordFirstRRFDefaults','TestRelayKeywordFirstRRFVectorStillContributes','TestRelayKeywordFirstRRFExplicitSettingsPreserved'],
       'suite':'go test -p 2 ./internal/application/service -run TestRelayKeywordFirstRRF|TestFuseOrDeduplicate|TestBestRanks|TestRescaleUnboundedScores -count=1',
       'defaultWeights':{'vector':0.3,'keyword':0.7},'explicitPositiveWeightsPreserved':True,
       'partialExplicitLegacyFallbackPreserved':True,'rrfKUnchanged':True,
       'fusionMathUnchanged':True,'tenantConfigMutations':0,'modelCalls':0,'relayPatches':patches}
(root/'relay-keyword-first-rrf-proof.json').write_text(json.dumps(rrf_proof,indent=2)+'\n')
grounding_proof={'schemaVersion':1,'status':'passed','policy':'relay-wiki-grounding-source-aware-retrieval-v1',
       'binarySha256':sha(root/'WeKnora-lite'),'testLogSha256':sha(pathlib.Path(sys.argv[8])),
       'suite':'go test -p 2 -tags sqlite_fts5 ./internal/application/service ./internal/application/service/chat_pipeline ./internal/application/repository/retriever/sqlite ./internal/types ./internal/container -count=1',
       'modelCalls':0,'relayPatches':patches}
(root/'relay-wiki-retrieval-proof.json').write_text(json.dumps(grounding_proof,indent=2)+'\n')
files={str(p.relative_to(root)).replace('\\','/'):sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
version=max(int(p.name.split('_')[0]) for p in (root/'migrations/sqlite').glob('*.up.sql'))
manifest={'schemaVersion':1,'version':lock['version'],'sourceCommit':lock['sourceCommit'],'sourceArchiveSha256':lock['sourceArchiveSha256'],
          'goVersion':lock['goVersion'],'platform':'linux-amd64','migrationVersion':version,'securityPolicy':lock['securityPolicy'],
          'relayPatches':patches,'files':files}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
ldd "$BUNDLE/WeKnora-lite"
sha256sum "$BUNDLE/WeKnora-lite" "$BUNDLE/manifest.json"
printf 'Verified bundle ready: %s\n' "$BUNDLE"

#!/usr/bin/env bash
set -euo pipefail
# Only the coordinator may choose http after publication and complete index proof.
# Default plan performs no HTTP requests and does not read the bearer token file.
mode="${1:-plan}"
case "$mode" in plan|http) ;; *) echo 'mode must be plan or http' >&2; exit 2;; esac
if [[ "$mode" == http && "${RELAY_QUALITY_ALLOW_MODEL_CALLS:-}" != 1 ]]; then
  echo 'explicit RELAY_QUALITY_ALLOW_MODEL_CALLS=1 is required for http' >&2
  exit 2
fi
root=/home/ftd/relay-knowledge-engine-nonprod
fixture="$root/bulk-structured-v3/candidate-v3-b"
runner="$root/runtime/full-213-v4-flash/quality-runner/knowledge-quality-retrieval.js"
report="$root/runtime/full-213-v4-flash/retrieval-${mode}-$(date -u +%Y%m%dT%H%M%S%NZ).json"
export RELAY_QUALITY_ISOLATED=1
node "$runner" \
  --mode "$mode" --endpoint product \
  --db "$root/relay/data/knowledge.db" --source-db "$fixture/knowledge.db" \
  --frozen-jsonl "$fixture/manifest.jsonl" \
  --manifest-sha256 6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95 \
  --fixture "$fixture/quality-fixture-private-v3-b.json" \
  --fixture-sha256 63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271 \
  --expected-case-count 55 \
  --migration-id migration-d09f8da0-9f7c-4501-b3d4-1ff8ada653f5 \
  --operation-key full-213-v4-flash-6e151fcae563 \
  --knowledge-base-id c5c3bc14-c3e6-4b93-8147-87a3bfa0e29a \
  --expected-provider-id qwen \
  --expected-provider-status "${RELAY_QUALITY_EXPECT_PROVIDER_STATUS:-pending_reindex}" \
  --expected-model-id qwen3.7-text-embedding-flash --expected-index-version 2 --expected-dimensions 1024 \
  --expected-engine-model-id 019fe3eb-5e8d-4996-918a-5cdfd88f00a7 \
  --expected-model-alias relay-embedding-a7a84cbe6533cab8 \
  --expected-parser-version html-3-engine-full213-v4-flash \
  --base-url http://127.0.0.1:18300 --token-file "$root/relay/data/e2e-admin.jwt" \
  --max-requests 55 --report "$report"

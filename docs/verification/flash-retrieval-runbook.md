# Frozen Flash retrieval check

The runner retains the B source manifest and its 55-case source-occurrence fixture. It does not change queries, labels, Recall@10/MRR/nDCG calculations, or acceptance thresholds. Source-occurrence scores are not semantic precision or factual accuracy.

The corpus proof requires migration `migration-d09f8da0-9f7c-4501-b3d4-1ff8ada653f5`, operation key `full-213-v4-flash-6e151fcae563`, KB `c5c3bc14-c3e6-4b93-8147-87a3bfa0e29a`, provider `qwen`, model `qwen3.7-text-embedding-flash`, index version 2, 1024 dimensions, engine model `019fe3eb-5e8d-4996-918a-5cdfd88f00a7`, alias `relay-embedding-a7a84cbe6533cab8`, and parser `html-3-engine-full213-v4-flash`. The same environment/local IDs belonging to earlier migrations cannot satisfy this proof.

Readiness additionally requires the selected migration and all frozen corpus mappings to be published and verified, the active Product route to reference this migration, the migration source manifest to match the frozen bodies and scope, and the current provider/control binding to match. Model provenance must match the expected values, not merely agree across documents. These gates run before any HTTP request and again before and after every individual request. Binding changes stop the run. Other current-model sources can remain unjudged hits without contributing to frozen-corpus coverage.

The fixed manifest hash is `6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95`; the B fixture hash is `63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271`. The wrapper pins both and requires exactly 55 cases.

The private standalone runner is installed under `/home/ftd/relay-knowledge-engine-nonprod/runtime/full-213-v4-flash/quality-runner/`. This installation does not deploy or restart Relay. The default command is a read-only plan with zero HTTP/model calls and no bearer-token-file read:

```bash
bash /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213-v4-flash/quality-runner/run-flash-retrieval-quality.sh plan
```

Only the coordinator executes the online command after full index-content proof and formal publication/activation have completed:

```bash
RELAY_QUALITY_ALLOW_MODEL_CALLS=1 \
bash /home/ftd/relay-knowledge-engine-nonprod/runtime/full-213-v4-flash/quality-runner/run-flash-retrieval-quality.sh http
```

The wrapper explicitly expects provider status `pending_reindex`, its state when frozen. If the formal reindex lifecycle has subsequently changed it to `ready`, add `RELAY_QUALITY_EXPECT_PROVIDER_STATUS=ready` to the invocation. This selects an exact state check; it does not modify provider configuration. Disabled or degraded providers never pass. The wrapper itself neither publishes nor activates anything.

Online mode is limited to 55 HTTP requests through the existing loopback Relay endpoint and existing private admin token file. This is not a promise of 55 billable upstream calls; registry policy and durable admission remain authoritative. A failure stops the run without automatic extra requests. Output files are new private JSON artifacts; fixture content and previous reports are never overwritten. Resume requires identical fixture, manifest, expected scope and binding fingerprint.

Four regressions exercise real SQLite joins with old/new migrations sharing local IDs (including unrelated migrations in the same new KB), wrong model/provider/index/parser/content identities, publication/routing/control/config changes, and changed frozen source metadata. The existing scoring self-test remains unchanged.

Preparation verification: four regressions, the existing scoring self-test, strict TypeScript checking and Bash syntax checking passed. The real zero-call plan retained all 55 cases as `not_ready`, with zero attempted cases and zero HTTP requests. Its private report is `runtime/full-213-v4-flash/retrieval-plan-20261025T160724165558326Z.json`, SHA-256 `bf57a6042522e4eba14abcf9fdb92b32d47c0806c0831388b8bcb1b72afa54ba`. No online score or retrieval-quality pass is claimed.

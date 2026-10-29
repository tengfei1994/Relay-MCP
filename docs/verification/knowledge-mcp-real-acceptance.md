# Bounded real MCP/privacy acceptance driver

`scripts/knowledge-mcp-real-acceptance.ts` completed a bounded real nonproduction run after the controlled privacy deployment. Its helper regressions use only synthetic local SQLite/text. The real result below does not close #53, claim semantic retrieval quality or exercise an upstream fault matrix.

## Safety and scope

- Linux only; cwd must resolve exactly to `/home/ftd/relay-knowledge-engine-nonprod/relay`; `RELAY_E2E_ISOLATED=1` required. All database, control, credential, report and log paths must resolve inside that nonproduction root. Symlink escape is rejected.
- Defaults to `--mode plan`, opening SQLite read-only/query-only and writing a new mode0600 metadata report. No HTTP or MCP calls occur in plan mode.
- `--mode run` additionally requires `RELAY_MCP_ACCEPTANCE_EXECUTE=1`. The coordinator supplies that flag only after deploying the new privacy code. Existing reports are never overwritten.
- Never changes provider settings, engine profile, source documents, publication, migration status or history. API reads/searches produce normal telemetry and may populate deterministic local vector caches; the driver itself opens SQLite read-only.
- Dynamically selects current-KB published/verified migration mappings for the token's project and `nonprod`/`nonprod-chm-acceptance` environments. No document IDs are hardcoded. The default expected count is seven (the approved five plus two corrected CHM pages); drift fails rather than selecting an arbitrary seven. A changed approved set needs an explicit `--expected-source-count` and environment choice.
- Freezes IDs, chunk allowlists, source hashes, parser/version/scope/model metadata and a KB digest. It preserves and rechecks the exact freeze and private engine-control fingerprint after running. Reports contain no title, body, query, prompt, response, credential or raw KB ID.

## What run mode checks

1. Actual HTTP health and MCP tools/list/connect with existing private admin/foreign JWT files.
2. Positive HTTP local Case search using `kinds=case` and a dynamic confirmed Memory title term plus unique sentinel. Product retrieval is excluded; deterministic local providers remain available. The response must still carry its query, a retrievalRunId and the selected Memory result.
3. Actual MCP `knowledge_search` with a dynamically absent Product version, proving a usable response with no engine Product results; plus `knowledge_source_search` with explicit missing-baseline/snapshot rejection (not a successful source-code lookup). These exercise the real MCP Product search handler/audit path without a remote embedding search.
4. Unknown-route and malformed-JSON HTTP requests with synthetic URL/header/body sentinels. The latter catches Fastify errors that otherwise duplicate truncated body text into log messages.
5. Every frozen real source is read through formal HTTP routes, with correct source hash/version/citations and foreign actor/environment denial. Sources in the token's default environment are also read through actual MCP; CHM's other environment is not impersonated by modifying JWT claims.
6. Up to three actual staged/failed/deprecated mappings are denied through HTTP and MCP. At least one such fixture is required; the driver does not manufacture publication states.
7. New retrieval rows contain tagged query digests, schema-versioned metadata and result-ID/score/scope allowlists. New Knowledge audit rows correlate by retrievalRunId and query hash. New MCP audit records must contain the expected metadata hash for both retrieval tools.
8. New HTTP/MCP log windows and audit rows exclude raw/JSON-escaped/URL-encoded sentinels, the two supplied JWTs, the private engine API key (if present) and bounded returned Memory-summary markers. Only byte counts and SHA-256 digests are retained. The first `--log` must be the active HTTP request log and must grow; later logs may have a zero-byte window. A rotated/truncated file, oversized window or missing audit fails instead of being called clean.
9. Persisted provider-admission count must remain unchanged. A running ingest job blocks the check; any concurrent provider calls make the zero-model attribution fail. No counter is reset. This verifies counted managed calls, not external account billing.

The scan is bounded to known tokens/sentinels/returned Memory markers and new telemetry windows. It is not a credential inventory, whole-disk leak scan or historical-data cleanup. It does not prove Product semantic recall, positive Solution scope, bilingual/path conflict quality or real upstream 401/429 issuance. Those remain separate #53 cases. Any future fault proxy must be isolated and explicitly reported as injected faults.

## Plan after uploading the new script

From the approved remote checkout (no execute flag):

```sh
RELAY_E2E_ISOLATED=1 node --import tsx scripts/knowledge-mcp-real-acceptance.ts \
  --mode plan --run-id mcp53-plan-NEW
```

Inspect only safe report metadata/counts. Do not print credential/control files. The defaults use `data/e2e-admin.jwt`, `data/e2e-foreign.jwt`, `data/knowledge.db`, and the managed runtime's `control.json`.

## Execute only after the coordinator's deployment signal

```sh
RELAY_E2E_ISOLATED=1 RELAY_MCP_ACCEPTANCE_EXECUTE=1 \
  node --import tsx scripts/knowledge-mcp-real-acceptance.ts \
  --mode run --run-id mcp53-real-NEW \
  --log /home/ftd/relay-knowledge-engine-nonprod/runtime/relay-web.log \
  --log /home/ftd/relay-knowledge-engine-nonprod/runtime/relay-mcp.log \
  --mcp-audit /home/ftd/relay-knowledge-engine-nonprod/relay/data/state/audit.jsonl
```

Every path can be supplied explicitly; all remain subject to the same root guard. `--source-environment` and `--log` are repeatable. A failed run leaves a new private report with only a safe failure code and completed metadata checks. Preflight errors emit only `acceptance_preflight_failed`.

## Local validation

```sh
npx tsx --test tests/knowledge-mcp-real-acceptance.test.ts
npx tsc --noEmit --strict --skipLibCheck --esModuleInterop --target ES2022 \
  --module ESNext --moduleResolution bundler --noUnusedLocals --noUnusedParameters \
  scripts/knowledge-mcp-real-acceptance.ts
```

Helper tests cover escaped-secret detection, strict retrieval envelope/identity validation, and current-KB/published mapping selection without body/title output. They do not substitute for the pending real deployment run.


The first authorized real run, `mcp53-real-1792938436538`, passed the HTTP local and MCP empty-Product-scope queries, then exposed a driver assumption: source search requires `baselineId` or `projectSnapshotId`. The failed report is retained. The driver now treats this extra unscoped call as an explicit validation-denial/audit test, without inventing or seeding a source baseline. The main MCP search still verifies original query preservation.


## Real zero-model result — 2026-10-25 14:29 UTC

Deployment bundle SHA-256: `bb5208b7cfa4f68df85c066d4e8b78adda8b1bbf3510b579c3ff3e0f2d70e497`. Before execution, the remote acceptance script and four privacy build files (`retriever.js`, `request-log.js`, `retrieval-audit.js`, MCP `index.js`) matched the local built hashes. After correcting the driver's missing source scope assumption, only the script was re-uploaded; application code/services were not changed.

Private report: `/home/ftd/relay-knowledge-engine-nonprod/runtime/mcp53-real-1792938566563.json`.

- Report SHA-256: `f877af17fef7cca8a9d6051fcadd0298e16258b3861e5a68145bc5d61cbb9233`.
- Status: `passed_zero_model_privacy_and_scope`; **13 grouped checks passed**, 14:29:30.796Z–14:29:32.041Z.
- Source freeze: **7** published/verified mappings (five `nonprod`, two `nonprod-chm-acceptance`), SHA-256 `087e57bd78c216224722217c1a1c4df21d5f779e1ef9b4de9c29a282a61537a3`, unchanged from plan and after execution.
- Actual HTTP local search returned three results including the expected verified Case. Actual MCP empty-Product-scope search returned a usable empty result with its original query and retrieval ID. The extra unscoped source-search call received its exact required-scope denial.
- Seven actual HTTP Product reads retained expected source/version/citation identity; all seven rejected the foreign actor and foreign environment. Five in the token's default environment also passed real MCP read/foreign-actor checks. The two CHM reads used their correct HTTP environment rather than altered token claims.
- Three dynamically selected **failed** mappings were denied through HTTP and MCP. This subset did **not** independently exercise staged or deprecated read denial; earlier separate evidence and future targeted checks must remain distinguished.
- Two new retrieval rows and two Knowledge search audits held hash/length/metadata and preserved correlation. MCP audit recorded 15 tool calls and the expected hashed retrieval arguments.
- Incremental scan: HTTP log **11,171 bytes**, MCP stdout **0 bytes**, MCP tool audit **5,078 bytes**; no known private query/header/body/token or bounded returned-Memory marker matched. The 404/malformed-JSON paths ran inside that window. A zero-byte MCP stdout window is not presented as log coverage; the actual nonempty MCP audit is verified separately.
- Provider admission count **2,719 → 2,719**; active engine control fingerprint and source freeze unchanged. The bulk profile, quota, publication and source content were not modified. The coordinator was notified that the full migration could resume immediately; no further HTTP/MCP requests were sent by this task after the report.

The failure report `mcp53-real-1792938436538.json` remains preserved. Its two completed local search checks are not discarded or relabelled as a complete pass. Historical telemetry/logs remain unchanged; this success applies only to the specified fresh window and known marker set. Bilingual/object/path/conflict semantic cases and isolated HTTP fault-injection matrix remain separate work before closing #53.

Executed corrected driver SHA-256: `2e956ae4e3f1880798b411563823c616864ab74dad298acfc83c32db4cde20ec`.


The isolated real-socket fault matrix subsequently passed on 2026-10-25: see [the injected-fault packet](knowledge-mcp-fault-acceptance.md). It adds default timeout, 429, 401, invalid JSON, forged-reference rejection and fixture-restart recovery evidence without changing the deployed services or counting synthetic behavior as cloud/model success. Semantic quality cases remain separate.

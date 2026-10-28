# Managed engine model-log safety acceptance

Verified on 2026-10-25 in the isolated nonproduction deployment. The patched engine completed a real model call through Relay's managed gateway. The scanned new log bytes and selected audit/span/model fields contained zero matches for the approved credentials or test input/output markers. Historical prompt-bearing logs remain restricted and preserved; they are not declared clean.

This document contains only IDs, hashes, paths, status, counts and timings. No prompt, model completion, private document content, raw credential or hidden reasoning is reproduced. Production was not changed.

## Scope and artifacts

All report paths below are under `/home/ftd/relay-knowledge-engine-nonprod/runtime/` on the nonproduction host:

| Evidence | Artifact |
| --- | --- |
| Initial read-only scan | `sensitive-boundary-scan-3f3ab10e-6a10-4a79-a2c4-2a73b6ae0cbc.json` |
| Historical log classification | `sensitive-boundary-scan-classified-42bc8d83-2b91-4b93-bd61-acbfcdc6a872.json` |
| WARN mitigation offset | `log-safety-mitigation-offset.json` |
| Source build and final bundle verification | `model-log-safety-build-report.json` |
| Installed-binary real model call and incremental scan | `model-log-safety-live-4c83822d-b57d-4fbf-9a36-997da46b03b7.json` |
| Actual Candidate output/review/audit and later log scan | `candidate-sensitive-scan-83d3fd6f-912b-443b-aaeb-5e2581862219.json` |
| Deployed asynchronous Candidate acceptance | `candidate-async-live-20261025.json` |
| Asynchronous Candidate and final incremental privacy scan | `candidate-async-sensitive-scan-3cab605e-672c-4114-9530-7c387abc0e8e.json` |
| Real CHM ingest/search/code-integrity acceptance | `chm-live-20261025b.json` |
| Post-CHM incremental log/audit/span privacy scan | `chm-sensitive-scan-b0026deb-335b-4a32-ab09-dfe8b8a46139.json` |

The scanner resolved three approved Provider Registry references (`qwen`, `qwen-wiki-nonprod`, `qwen-candidate-nonprod`) through `ProviderCredentialStore` in memory. These references resolved to one distinct credential value at the initial scan. It never persisted or printed that value. Authorized secret stores (`.env`, private engine/control configuration, encryption keys, encrypted credential storage and auth files/tables) were excluded from leak claims.

## Observed failure and remediation

The initial scan covered 15 files, three SQLite databases and 103 tables containing 707 rows. Exact credential matches were zero. The structured prompt/reasoning scan of selected metadata fields found zero matching cells. Provider audit inspection covered five probe/configuration/test rows with safe metadata keys; this did not prove that upstream inference logging was safe.

The old engine log contained 142 model-request headers. The classifier parsed 60 complete request JSON objects, including 60 user and 10 system messages with 262392 message-content bytes. The remaining 82 request blocks were incomplete or interleaved and were not counted as parsed JSON. No reasoning payload was identified in this classification. The failure was pinned upstream `internal/models/api/endpoint.go` writing complete request JSON at INFO. Image compaction did not redact message text.

The immediate managed-runtime mitigation forced WARN and disabled both debug and raw-stream dumps. The subsequent source patch changed request logging to numeric/boolean statistics and made model HTTP, transport and protocol-error strings omit response bodies. Typed private error bodies remain in memory where required for multimodal capability classification. The launcher restricts log permissions and rejects unproven engine bundles at install and startup.

Original log records were not rewritten or deleted. The existing engine log was restricted to mode 0600. Historical copies and backups still require private retention and a separately authorized disposal/redaction decision.

## Build identity and regression evidence

| Field | Verified value |
| --- | --- |
| Upstream version | WeKnora Lite v0.8.3 |
| Upstream commit | `3e22822c1d2397be730c458c7539d0eb8c113a24` |
| Source archive SHA-256 | `91e13c59134db179ca305dfb1dce2ee6fed752e1334ff0ab662255474e012568` |
| Security policy | `relay-model-metadata-only-v1` |
| Patch ID | `0001-model-log-metadata-only` |
| Patch SHA-256 | `03fc298647d86e901581d926b6afe712140a7be443619d7b0694679a2a83c2e5` |
| Compiled binary SHA-256 | `83abda70c42774784bf2f05c17e8428356f83cf3aa6dd0778b43647e4f5a3c75` |
| Final bundle manifest SHA-256 | `c6d845af20787a4796d29ba88adcf98d52d35cbad52269295cd45c544bbdcbf8` |
| Verified bundle files | 120 |
| Active release | `v0.8.3-c6d845af20787a47` |

Two new regressions failed against the pristine upstream source: private request logging and HTTP error-body disclosure. After the patch, all 16 upstream model API packages passed `go test -p 2 ./internal/models/api/...`. Focused Relay runtime/deployment/log-safety checks passed 26/26; the final runtime/startup subset passed 19/19 after the startup guard and executable-permission changes. Source and focused-test typechecks and Node/Bash syntax checks passed.

The real Lite compilation produced the binary and initial manifest before the build shell encountered a trailing Windows CR command and exited nonzero. The script was corrected to LF and syntax-checked. The final assembly reused the identical verified compiled binary and proof, verified all 115 original files, added the pinned 7-Zip tool and license files, and verified the new 120-file manifest successfully. The final manifest records this repack and its parent manifest; this is not presented as a clean exit of the original build invocation. The later live report confirms the installed executable, superseding the build report's earlier `awaiting_parent_install` state.

The bundle contains 7-Zip 26.05 Linux amd64. Its archive SHA-256 is `22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e`; the `7zz` executable SHA-256 is `d32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886`. The tool installer, reuse check, managed resolver, executable status, CHM-format support and license presence were separately exercised. A subsequent read-only check resolved the executable from the active `v0.8.3-c6d845af20787a47` release without an extractor override, confirmed its pinned hash and mode 0700, and confirmed CHM-format support. Full archive import counts and the executable used for each import belong to the separate Product ingestion report.

## Actual installed-binary call

Run `4c83822d-b57d-4fbf-9a36-997da46b03b7` started at `2026-10-25T10:12:02.518Z` and finished at `2026-10-25T10:12:05.410Z`. The probe verified PID 896083's executable hash and the active manifest/proof before calling the private upstream model-debug endpoint. The registered upstream model used Relay's managed gateway and the actual configured remote qwen-plus provider, without a stub server.

| Measurement | Result |
| --- | --- |
| Provider ID | `qwen-wiki-nonprod` |
| Upstream model ID | `91061649-3d10-4f97-b9bc-8377d5efac93` |
| Calls / status | 1 / passed |
| Call latency | 1256 ms |
| Response bytes | 51 |
| Input SHA-256 | `cbd90706b3d1621d4652f9263e8c5d4d0fcbeda1feb8eae914efa0c20a6d4e0f` |
| System-input SHA-256 | `2cd027d51c45202a5e7e6dc4c6064e7e716b2cca388e4bff5165d9d43049450c` |
| Response SHA-256 | `69bbd6c2ac7576eee6b1e0b14d70eb30688ad56a2129908a946796e8be9cd8ab` |
| Process policy | `LOG_LEVEL=warn`, `LLM_DEBUG_LOG=false`, `WEKNORA_LLM_STREAM_RAW_DUMP=false` |

The probe scanned only bytes appended after its recorded log offsets:

| Log relative to runtime | Offset → end bytes | New bytes | Credential / body-marker / message-shape matches |
| --- | --- | --- | --- |
| `knowledge-engine/logs/engine.log` | 7370436 → 7370436 | 0 | 0 / 0 / 0 |
| `relay-web.log` | 185287 → 185727 | 440 | 0 / 0 / 0 |
| `relay-mcp.log` | 132 → 132 | 0 | 0 / 0 / 0 |
| `relay-server.log` | 51384 → 51384 | 0 | 0 / 0 / 0 |

The engine emitted no new log bytes at WARN. This validates the deployed suppression setting during a real call; the separate Go regressions validate safe request formatting at INFO. It does not claim that an INFO record was emitted by this live run.

The post-call scan inspected these database columns. Every listed column had zero exact credential and body-marker matches; row counts are per column and must not be summed as distinct records:

| Database | Table and columns | Rows per column |
| --- | --- | --- |
| Relay | `knowledge_audit.details_json` | 163 |
| Relay | `knowledge_provider_configs.base_url`, `model_id` | 3 |
| Upstream | `audit_logs.details` | 42 |
| Upstream | `knowledge_processing_spans.input`, `output`, `metadata`, `error_message`, `error_detail` | 232 |
| Upstream | `models.parameters` | 2 |

## Actual Candidate output and review scan

After the real `memory-live-20261025c` acceptance run and browser scope review, a read-only scan at `2026-10-25T10:21:35.568Z`–`10:21:35.599Z` inspected these existing Candidate records:

| Record role | Candidate ID |
| --- | --- |
| Reviewed real-model Candidate | `insight-d8a535ad5485b0ee04598b40718de661` |
| Pending real-model Candidate | `insight-9e88fa65bdb324e1644d8d945f7a2bae` |
| Browser scope-reviewed legacy Candidate | `insight-78e35171480d35c98533d8d4f4479c6a` |

The snapshot contained two accepted records and one draft. It scanned all non-null fields of the three Candidate rows, six linked review rows and 15 related audit rows: 230 fields total. This includes statement, whyProposed, unknowns, reuseBoundary, structured fact/behavior/reuse sections, review snapshots/reasons and related audit details. The report records field names, byte counts and SHA-256, never their values.

There were zero approved exact-credential matches and zero detected raw-prompt, messages/system-role, hidden-reasoning or credential-shaped strings. The same scan examined 42472 bytes appended after the installed-binary probe baseline: engine log 3910 bytes, Web log 38529 bytes, MCP log 33 bytes and server log zero bytes. All four logs had zero matches; no file had rotated below its baseline. Known historical engine prompt records precede that baseline and remain classified separately.

This closes the output/audit scan evidence gap for these three named records. It does not prove asynchronous queue operation or scan Candidates generated after this snapshot. New asynchronous acceptance records require an incremental scan.

## Deployed asynchronous Candidate and incremental scan

The final application build passed 563/563 tests and the standard build before deployment. The separate `candidate-async-live-20261025.json` acceptance record identifies a real managed Candidate generated by the deployed queue while the Product engine was stopped. The privacy scan did not stop or restart a service and made no model call.

| Record | Verified metadata |
| --- | --- |
| Job | `insight-job-4ee46f41054aeb548deaf617c145ecb9` |
| Candidate | `insight-64ab3d358baa52a07ce872a5e11ed6e6` |
| Job state / attempts | `done` / 1 |
| Generated by | `managed-candidate-llm:qwen-candidate-nonprod/qwen-plus` |
| Privacy scan start / finish | `2026-10-25T11:06:56.608Z` / `2026-10-25T11:06:56.671Z` |
| Previous scan baseline | `2026-10-25T10:21:35.599Z` |

The read-only scan checked the one job row, one Candidate row, no review rows, and the union of related and newly written audit rows: 140 audit rows, of which 138 were newer than the baseline and four were related to the job/Candidate/Session. Those counts overlap; they must not be added together. It inspected 1136 non-null fields in total and recorded only field names, byte lengths and hashes. Three approved provider references again resolved to one distinct in-memory credential value.

All exact credential matches and raw-prompt, messages/system-role, hidden-reasoning and credential-shape matches were zero. The log scan also used three raw or JSON-escaped long-text markers derived in memory from the Candidate output and available context fields; marker matches were zero. It exported neither those markers nor the actual input/output.

| Log relative to runtime | Offset → end bytes | New bytes | Credential / shape / body-marker matches |
| --- | --- | --- | --- |
| `knowledge-engine/logs/engine.log` | 7374346 → 7438671 | 64325 | 0 / 0 / 0 |
| `relay-web.log` | 224256 → 434065 | 209809 | 0 / 0 / 0 |
| `relay-mcp.log` | 165 → 198 | 33 | 0 / 0 / 0 |
| `relay-server.log` | 51384 → 51384 | 0 | 0 / 0 / 0 |

Total new log bytes were 274167; none of the four files had rotated below its baseline. Earlier prompt-bearing engine records remain preserved and excluded from this incremental result. CHM revalidation was allowed to continue during the scan; later writes require another snapshot. This result covers the named asynchronous job and the observed audit/log interval, not every future job.

## Real CHM post-run privacy scan

The CHM driver finished at `2026-10-25T11:13:14.823Z` with all five milestones passed and result `passed_real_chm_engine_ingest_search_code_integrity_idempotency`. The follow-up privacy scan ran at `2026-10-25T11:17:29.637Z`–`11:17:29.708Z`, continuing from the asynchronous Candidate baseline at `11:06:56.671Z`. It was read-only, made no model calls and did not alter services or business records.

The scanner first verified the two actual local source-body hashes against the completed CHM report, then derived overlapping long-text windows in memory. Original, JSON-escaped and whitespace-normalized representations produced 213 distinct markers. Only marker counts and a manifest of their hashes were saved; no source text or marker value was exported.

| Source document ID | Verified body SHA-256 | Marker count |
| --- | --- | --- |
| `product-document-236409a33328e596afd36a6f81aadb61` | `5ce047bbfd2221abc69c42a34181f6e54847c58bdb57bb3b3999308def8e0d99` | 115 |
| `product-document-bf98083a4bf0a7526a83e6fa2d1d6fb3` | `c7472a3244ce0e016d27163d4817dd280063f25aca75b92877dc52ad6e185c89` | 98 |

The three approved provider references again resolved to one distinct credential value in memory. Exact credential, actual-source-marker and sensitive-structure matches were all zero in these newly scanned log bytes:

| Log relative to runtime | Offset → end bytes | New bytes | Credential / source-marker / shape matches |
| --- | --- | --- | --- |
| `knowledge-engine/logs/engine.log` | 7438671 → 7467369 | 28698 | 0 / 0 / 0 |
| `relay-web.log` | 434065 → 545313 | 111248 | 0 / 0 / 0 |
| `relay-mcp.log` | 198 → 198 | 0 | 0 / 0 / 0 |
| `relay-server.log` | 51384 → 51384 | 0 | 0 / 0 / 0 |

Total new log bytes were 139946. The database scan selected records created or updated since the baseline, conservatively including records whose relevant timestamps could not be parsed. It inspected 333 non-null cells across seven Relay audit rows, three upstream audit rows and 28 upstream processing-span rows; no model metadata row was selected. Fields included audit details and processing-span input, output, metadata, error code/message/detail, plus safe identity/status fields. Credential, source-marker and prompt/completion/messages/system-role/hidden-reasoning shape matches were all zero.

Intended source-document and Wiki-body storage was outside the leak scan. Earlier prompt-bearing engine log bytes remain separately classified and preserved. The result does not cover writes after `11:17:29.708Z`, a later deployment, all possible source transformations or every future provider response.

## Reproduction and limits

The bounded live probe is `scripts/knowledge-engine/log-safety-live.mjs`. It requires `RELAY_LOG_SAFETY_ISOLATED=1`, verifies the isolated filesystem/runtime identity, reads private configuration locally and writes a metadata-only JSON report. Run it only in the authorized nonproduction environment with the configured remote-call budget. The probe makes one actual model call; it is not an offline test.

The evidence covers the named snapshot, approved exact credential value, selected fields and synthetic input/output markers. It does not establish safety for every possible encoding, future output, unscanned logger or full frontend build generated later. Legitimate Knowledge/Wiki document bodies are not classified as leaked prompts merely because they contain ordinary text.

This is model transport/log and named Candidate output/audit evidence. The later deployed asynchronous acceptance record adds actual queue-consumption evidence during a Product-engine outage. Capture, outbox, dead-letter and retry interactions remain the subject of the separate Worker acceptance checks; the privacy scan itself does not exercise them. Compiler/provider timeout, cancellation, concurrency, quota, output-token and retry limits must be assessed at their actual request boundary, with process-local limits distinguished from global spending controls.

The separate `tests/candidate-provider-policy.test.ts` verification passed 9/9 and strict TypeScript checking. Four shared-policy/queued-credential regressions also failed with business assertions against an isolated copy of the older registry, then passed with the current implementation. These tests cover in-process cancellation, queue deadlines, concurrency/quota sharing, rotation/disable and output bounds; they do not substitute for a deployed asynchronous-worker coexistence run or establish a cross-process quota.

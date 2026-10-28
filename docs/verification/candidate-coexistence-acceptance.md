# Candidate fault and Capture coexistence acceptance — 2026-10-26

This packet adds isolated composition evidence for #47. It uses real loopback HTTP, the managed provider registry and encrypted credential resolver, two actual Candidate dispatchers, real local Node subprocess Jobs, immutable events, the real outbox and Capture worker. It does not call a cloud model or read/write an active service database, configuration or migration. No issue was closed by this packet.

The retained metadata-only report is `runtime/candidate-coexistence-20261026a.json` (SHA-256 `814d69680720bdf5fa0265af6fdd04be0413fe994a1c5131720fef1a57e29780`). The run was 2026-10-25 17:00:21–17:00:29 UTC, or October 26 in Asia/Shanghai. Driver SHA-256: `301d371c55b7010e49bd1d25a2f64feb18c0f003a42a42c2b6420759d8711e24`. The report records individual source hashes, identity/count evidence and limitations; it contains no request or response bodies.

## Observed outcomes

| Fault / recovery | Provider HTTP attempts | Queue attempts | Result | Job + Capture progress while Candidate remained pending |
| --- | ---: | ---: | --- | ---: |
| Real 3-second transport timeout | 1 | 1 | `deterministic-fallback-v1`, `timeout`, draft | 311 ms |
| HTTP 429 | 1 | 1 | `deterministic-fallback-v1`, `rate_limited`, draft | 509 ms |
| Valid OpenAI envelope with invalid content JSON | 1 | 1 | `deterministic-fallback-v1`, `invalid_output`, draft | 260 ms |
| HTTP 429 followed by valid typed JSON | 2 | 1 | Managed synthetic provider provenance, draft | 281 ms |

Each scenario ran a successful local subprocess and a controlled exit-17 subprocess through the actual Job store. Before releasing the held provider response, or before timeout expired, their four start/terminal events were correlated to the correct Session, an Observation and failure Candidate were captured, and Evidence was visible in the Session summary. These are single-run progress measurements, not latency SLOs or remote SSH performance measurements.

All four requests were asynchronously enqueued over actual HTTP. Two real dispatchers shared queue ownership. Duplicate enqueue and subsequent synchronous compile returned the same job/Insight without another provider request. There were four draft Insights, four queue jobs, five loopback provider requests and four durable logical admissions. No Case, Pattern or Playbook was promoted. Missing and foreign Evidence were rejected through HTTP before any provider request.

During the pending timeout, one outbox event encountered a simulated project-resolver outage, retained its retry state, then recovered exactly once after the resolver became available. A separate unresolvable event exhausted five failed attempts, produced one dead-letter record and remained in the immutable event table. Further consumption did not duplicate the dead letter. Capture retry/backoff used a second connection with a controlled clock; the provider timeout and provider retry used real time.

The final corpus of this synthetic run contained 18 immutable events, 33 Evidence objects, four Observations and five Capture Candidates. The replay API matched 17 non-poison events and reset their consumer state; its `queued: 0` means the outbox rows already existed, not that no replay was requested. Re-running Capture left the Evidence/Candidate/Observation ID sets and the complete immutable event-row hash unchanged.

## Privacy fixes found by acceptance

Two linked leaks were reproduced before fixing them:

1. Candidate context retained nested `reasoning`, `hiddenReasoning` and related private reasoning fields in queued JSON and synchronous provider input. The shared input redactor now omits those keys before persistence, idempotency hashing and provider input. Legal statement, hypothesis, Evidence references and provenance fields remain available. Three regressions first failed and then passed, including equivalent sanitized-input replay producing only one model call.
2. MCP's outer `tool_called` audit ran before that redactor and stored raw Candidate context. The compile tool now has a dedicated metadata projection: context, provider identity and Evidence references become SHA-256/length metadata; Evidence count, canonical Session ID and boolean async/retry flags remain. Unknown fields are omitted. The execution handler still receives its original input. Two regressions first failed and then passed; the HTTP regression starts the real MCP entry point and checks both accepted and rejected calls in the actual `audit.jsonl`.

The fixes do not rewrite historical stored data. Live deployment and its incremental privacy scan are separate acceptance steps.

The retained loopback run scanned all 81 SQLite tables (239,814 serialized bytes), 50 temporary files (5,651,127 bytes), 195 Knowledge audit rows and 34,882 HTTP log bytes. Exact synthetic credential, hidden-context, context-secret and provider-error-body matches were zero. Outgoing provider prompts also had zero sensitive-marker matches. The legitimate Evidence-body marker was permitted in its intended Evidence store and prompt, but absent from telemetry. The real MCP outer-audit regression separately verifies that legitimate context text is not copied into telemetry either.

## Boundaries and policy

The fault providers each use a distinct synthetic registry identity, 3,000 ms per-attempt timeout, concurrency one and a quota of 20 logical calls/hour. Timeout/429/invalid-JSON scenarios configure zero transport retries; recovery configures one retry. The compiler has its existing 30,000 ms overall request deadline and 4,096 maximum output-token request. Durable admission counts one logical invocation; the HTTP retry shares that admission, so five HTTP requests correctly correspond to four admissions. This is not an account-level billing cap. Queue retries have the existing five-attempt ceiling for thrown compiler errors; handled provider failures persist fallback immediately and complete after one queue attempt. Ambiguous abandoned provider calls continue to require explicit retry, as covered by the existing worker regressions.

This packet proves composition with local Jobs. The separately assigned live operational packet supplies remote Job/Deployment/restart behavior. Earlier actual-provider, explicit Review/promotion and verified Case reuse evidence remains in `runtime/memory-live-20261025c.json` and `runtime/candidate-async-live-20261025.json`, described in [managed-engine-progress.md](managed-engine-progress.md). Synthetic output here is not a replacement for that real-model evidence. The MCP catalog is unchanged; this patch adds no tool or feature.

## Reproduction and checks

From the repository root, choose a new report path; existing reports are never overwritten:

```powershell
node --import tsx scripts/knowledge-candidate-coexistence-acceptance.ts --report runtime/candidate-coexistence-new-run.json
node --import tsx --test tests/candidate-coexistence-acceptance.test.ts tests/candidate-context-privacy.test.ts tests/candidate-tool-audit.test.ts
```

The final combined Candidate/provider/actual-MCP-audit/Capture/outbox/Job regression run passed **63/63** tests. The separate existing audit compatibility group passed **15/15** tests. Strict TypeScript checking of the new driver and tests plus the server declaration context passed. Root owns the final full-suite/build checkpoint and deployment scan; this document does not substitute these focused results for those checks.

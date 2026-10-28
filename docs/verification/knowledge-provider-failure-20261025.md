# v3 embedding failure diagnosis and admission correction — 2026-10-25

## Confirmed observation

The approved nonproduction `nonprod-full-213-v3` snapshot contained 17 mapped `parse_failed` records and 340 staged mappings when first inspected. Every failed upstream record had `parse_status=failed`, `summary_status=none`, zero pending subtasks, and the same 68-character sanitized error fingerprint: `c87de17c8f2fa8c396a87d52557fe30f97580803e5d7b5dda6cead684ae05d88`. That error carries HTTP 503; it does not retain the provider's underlying response. These are a point-in-time snapshot, not a replacement for the coordinator's final stopped-job counters.

Read-only correlation against `knowledge_audit` after 14:29 UTC and the Web request log found:

- **32** `qwen` embedding `unauthorized` audit events, starting `2026-10-25T14:37:42.549Z`.
- **546** subsequent `provider_circuit_open` events.
- **578** corresponding HTTP 503 responses from `/internal/knowledge-engine/v1/embeddings`. Initial authorization failures took roughly 87–350 ms; open-circuit refusals generally took 3–5 ms.
- No quota, timeout, dimension or parsing-length category among these invoke errors. The persisted embedding provider remained configured `ready`, with 15,000 calls/day and 3,959 admissions. A configuration-ready flag is not proof that a model currently accepts requests.

Source tracing establishes that `unauthorized` is produced by an actual provider HTTP **401 or 403**, while missing/decryption-failed managed credentials produce a different classification. The historical audit retained only `request` and `errorCode`, so it cannot recover the exact status or provider error code. The Relay gateway represented nonquota provider exceptions as 503, and WeKnora retained a sanitized 503 summary. This is why the outer `parse_failed` label was insufficient to locate the original failure.

## Two explicitly authorized diagnostic operations

No corpus document was retried. No body, token, plaintext credential digest or raw model response was emitted.

1. One read-only `GET /models` using the nonproduction credential helper returned **HTTP 200**, 243 ms. In-memory comparison confirmed embedding and Wiki used the same token and same base URL; only booleans were emitted. The key file remained mode 0600. This operation made no model invocation.
2. One minimal `ProviderRegistry.resolveCandidateProvider('qwen').probe()` ran at `2026-10-25T14:58:35.434Z–14:58:35.727Z`. It returned `unauthorized`, **actual HTTP 403**. Existing safe diagnostics contained no recognized provider error code or reason. The ledger moved **3,959 → 3,960**; there was exactly one logical probe and no corpus replay.

The successful discovery call and same-key Wiki activity do not support a claim that the key is globally expired. The fixed minimal embedding probe failing with 403 shows that the failure is not specific to the failed documents' content. It does not distinguish embedding-model permission, billing/service entitlement, or another provider-side policy. No such cause is asserted without additional evidence.

## Why the failures continued

Before the correction, `ProviderRegistry` reserved a durable admission before `ProviderPolicy` tested its circuit. Thus every local open-circuit refusal consumed another logical admission despite making no provider HTTP request. At least the observed 546 circuit refusals followed that path; they are not 546 confirmed cloud requests. Their historical entries are retained.

The gateway converted those exceptions to 503; WeKnora retried and eventually marked the document failed. The migration loop continued to the next document because an upstream authorization failure was flattened to a per-document parse failure. The coordinator owns the separate migration-capacity gate: a fresh provider-wide authorization block should yield unstarted documents instead of converting every next source into a parse failure. Existing evidence does not justify automatically classifying this unknown 403 as a permanent bad key or a document-content rejection.

## Local correction, not yet deployed by this task

- The durable admission now occurs inside the policy's actual operation callback, after circuit and concurrency admission, before transport. A per-invocation flag keeps retries within one durable admission.
- Calls that waited for a concurrency slot recheck the circuit before their callback. If the preceding call opened it, queued calls send no HTTP and create no new durable admission. Half-open reservations belong to an individual invocation; only that owner releases the reservation. Quota rejection and cancellation always release owned reservations, while an unrelated cancelled waiter cannot release another invocation's reservation.
- Managed providers use the SQLite quota authority rather than an additional process-local quota gate. The standalone `ProviderPolicy` quota behavior remains available.
- Durable quota denial does not count as an upstream failure or open its circuit. This preserves HTTP 429 and safe retry metadata across repeated denials and normal expiry.
- `knowledge.provider.invoke_error` adds exact `httpStatus` and only the existing allowlisted provider `upstreamErrorCode`/fixed `reason`. Raw message, response, request body, request ID and credentials are not copied into audit. Unknown codes are omitted.
- Historical admission/audit rows are not rewritten or refunded. This task did not restart, deploy, resume migration or change remote configuration/quotas.

Seven new behaviors were observed RED→GREEN: circuit refusal without a new admission, cancellation while waiting for concurrency, safe 401/403 diagnostic persistence, repeated durable-quota refusal followed by expiry recovery, genuinely queued calls rejecting after the preceding call opens the circuit, half-open cleanup after a standalone quota refusal, and ownership-safe cleanup when an unrelated old waiter is cancelled. The existing retry test still proves two physical requests consume one logical admission. The final focused provider/runtime/diagnostics/setup/gateway/Candidate-policy group passed **66/66**, and `npx tsc --noEmit` passed. Standalone quota semantics remain covered by their existing tests. The provider-admission documentation now describes the actual post-gate, pre-transport timing.

The coordinator must deploy after its normal integration checks. A successful code test does not resolve the external embedding 403; automatic corpus work must remain governed by the separate provider-capacity decision.

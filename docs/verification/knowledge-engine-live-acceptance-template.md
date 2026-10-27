# Managed knowledge engine live acceptance record

Status: **NOT RUN — template only**. A unit-test pass, a provider probe, and a successful manual Wiki edit are not evidence of a generated Wiki or an integrated Product migration.

This record accompanies `scripts/knowledge-engine-e2e.ts`. The driver performs real requests against an already running, isolated Relay instance. It does not start mock servers, create artificial Product content, create manual Wiki pages, provision credentials, or update issues. It stops on the first failed or unmet milestone and preserves the database and engine state for diagnosis. A passing report is named `passed_bounded_http`, not full acceptance.

## Run identity and source evidence

| Field | Observed value / artifact |
| --- | --- |
| Operator and UTC run time | Pending |
| Repository commit | Pending |
| Relay isolated origin and state directory | Pending |
| Engine version / artifact digest | Pending |
| Genuine SampleManager fixture manifest | Pending: product versions, original document IDs, source path or locator, source SHA-256, local normalized body SHA-256, provenance of the source copy |
| Project / foreign project IDs | Pending: distinct isolated projects |
| Admin reviewer / foreign actor identities | Pending: IDs only; no tokens |
| Embedding binding | Pending: provider ID, model ID, dimensions, index version |
| Wiki chat binding | Pending: provider ID and model ID |
| JSON driver report | Pending |
| Provider call and engine synthesis audit export | Pending: counts, IDs, timing, errors, model binding; no prompts, full responses, or credentials |

Use a fresh isolated database and engine knowledge base with `relay_local` selected. Seed one to five genuine SampleManager Product documents for one project with `environment=nonprod`, source hashes, versions, and source paths. The driver requests a maximum of five; it does not infer authenticity from a filename or successful parsing. Attach the source-copy manifest separately.

Seed at least one nonempty Relay Memory document (`case`, `pattern`, `playbook`, `candidate`, or `fact`) and one nonempty Evidence object at most 1 MiB in the same project. Their actual content is hashed before and after migration; bytes and full text are never written to the report. Run against otherwise idle state so unrelated edits do not invalidate the preservation comparison. The admin bearer must own the project in the application database and have the corresponding Knowledge read/review ACL. The foreign bearer, if supplied, must have no access to the source project.

The model registry and managed engine runtime must already be configured. The Wiki model must support real generation. The driver deliberately reports an unmet milestone when no real Wiki model or no source-verified generated page is available.

## Configuration

Required environment variables:

| Variable | Meaning |
| --- | --- |
| `RELAY_E2E_ISOLATED=1` | Operator attests this is disposable isolated nonproduction state. It does not itself prove isolation. |
| `RELAY_E2E_TOKEN_FILE` | File containing only the admin/reviewer bearer token. Keep outside the repository. |
| `RELAY_E2E_PROJECT_ID` | Project owning the seeded Product, Memory, and Evidence fixtures. |
| `RELAY_E2E_FOREIGN_PROJECT_ID` | Distinct project used for scope-denial checks. |

Optional variables:

| Variable | Default / purpose |
| --- | --- |
| `RELAY_E2E_BASE_URL` | `http://127.0.0.1:18300`; origin only, no credentials, path, or query. |
| `RELAY_E2E_FOREIGN_TOKEN_FILE` | Enables real foreign-actor Product/Wiki denial checks. Absence remains an explicit coverage gap. |
| `RELAY_E2E_MEMORY_IDS`, `RELAY_E2E_EVIDENCE_IDS` | Comma-separated sentinel IDs; otherwise discover up to five matching records. Empty fixture sets fail preflight. |
| `RELAY_E2E_FIXTURE_MANIFEST` | Optional local file whose SHA-256 is recorded; attach the credential-free manifest separately for source-authenticity review. |
| `RELAY_E2E_EMBEDDING_PROVIDER_ID`, `RELAY_E2E_WIKI_PROVIDER_ID`, `RELAY_E2E_RERANK_PROVIDER_ID` | Existing registry provider IDs passed to managed initialization. |
| `RELAY_E2E_PRODUCT_VERSION` | Optional fixture version filter. |
| `RELAY_E2E_QUERY` | `SampleManager`; choose an actual question or term known to be answered by the bounded samples. Query text is omitted from the report. |
| `RELAY_E2E_WIKI_WAIT_MS` | `180000`; maximum 900000. Missing generated pages at the deadline are unmet. |
| `RELAY_E2E_REQUEST_TIMEOUT_MS` | `300000`; maximum 900000, allowing real parsing/generation time. |
| `RELAY_E2E_RUN_ID` | Generated timestamp/random ID. Reusing it preserves migration idempotency; the driver is not a resume tool. |
| `RELAY_E2E_REPORT` | `docs/verification/knowledge-engine-<runId>.json`. |
| `RELAY_E2E_COMMIT` | Commit ID to correlate code and report. |

After the operator has prepared and authorized the isolated runtime and fixtures:

```sh
npx tsx scripts/knowledge-engine-e2e.ts
```

Do not put bearer tokens or model API keys in the command line. The driver reads the bearer file in memory and never copies that file, sends credentials to an origin other than the configured Relay origin, follows redirects, or writes full request/response content. The report contains selected identifiers, hashes, metadata counts, status codes, and timings. Treat it as an internal operational artifact because IDs and model names can still disclose system structure.

Static verification, which does not execute the driver:

```sh
npx tsc --noEmit --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck scripts/knowledge-engine-e2e.ts
```

## Observed acceptance results

Fill with the actual JSON report and supplementary artifacts. Keep untouched rows **Not run**.

| Milestone | Required observation | Result / evidence |
| --- | --- | --- |
| Baseline preservation | Local provider; nonempty Memory and Evidence; actual Evidence bytes match stored digest; project counts captured. | Not run |
| Managed initialization | Engine reachable and ready; real Wiki model ready; registered embedding/model identity recorded. | Not run |
| Genuine bounded migration | 1–5 original documents; exact project/nonprod scope; source and body hashes; parser `real-sample-acceptance`; all staged with no failures. | Not run |
| Stage visibility and idempotency | Staged sources absent from explicit engine retrieval; provider remains local; repeating the exact request retains migration/document IDs and hashes. | Not run |
| Publication | All parsed upstream documents completed; verified timestamp and real chunk IDs; current embedding binding equals document provenance; provider becomes WeKnora. | Not run |
| Product search and read | Current and legacy Product search/read endpoints return engine content under old local IDs, with source hashes and only verified chunk citations. | Not run |
| Knowledge search HTTP | `/api/knowledge/search` returns verified Product hits without Product-provider degradation. This does not prove the MCP transport. | Not run |
| Generated Wiki | Discovery returns an upstream adopted page with only current published fixture citations in the exact project/nonprod scope; driver manual-create count is zero. | Not run |
| Wiki lifecycle | Real remote body edit creates draft revision; publish; remote history includes original and edit; diff contains marker; remote revert restores original body hash as a new draft revision. | Not run |
| Scope denial | Foreign project and environment cannot retrieve target Product; foreign environment cannot get Wiki; out-of-scope Wiki lists exclude it. | Not run |
| Foreign actor ACL | Separate bearer denied Product and Wiki. Required supplementary gap if bearer was omitted. | Not run |
| Rollback | Provider returns to local; old local Product bodies retain original hashes; Memory/Evidence record and content hashes and counts unchanged. No deletion requests. | Not run |

Generated-page discovery alone does not establish who created the upstream page. Attach the engine synthesis job and Relay managed-provider call audit identifying the actual Wiki LLM invocation for this run. Confirm no external/manual author created the page. The adopted-ID format and the driver's zero manual-create requests prevent the driver from quietly substituting a local/manual Wiki example, but are not a substitute for synthesis provenance.

On failure, retain the report's `state` identifiers and first milestone `code`. Do not classify later milestones as failures or passes: they were not run. Do not delete the partially staged documents, migration, or Wiki revision before diagnosis. A failure after provider cutover can leave WeKnora selected; use a reviewed explicit rollback after capturing evidence. The driver never performs automatic cleanup after failure.

A successful bounded run rolls the Product provider back to local. The exercised generated Wiki page remains remotely present and its restored revision is a draft, requiring review before publication. These are expected acceptance outcomes.

## Remaining release evidence

This bounded report does not close full acceptance by itself. Attach or retain unmet status for:

- Genuine fixture origin and source-copy hashes reviewed independently.
- Managed-provider call counts, model identity, actual embedding dimensions and actual Wiki generation call/synthesis job; no prompt or source-content exports.
- Real direct MCP `knowledge_search` and Product tool transport/authentication.
- Foreign-actor ACL when no separate token was supplied, plus publication visibility from a read-only actor.
- Frontend generated-Wiki discovery/review and Product citation navigation in a real browser.
- Engine/model outage behavior, restart/recovery, idempotent resume, and explicit rollback after a partial failure.
- Representative multi-version retrieval questions, citation correctness, and quality thresholds across the full intended corpus.
- Production deployment/rollback proof under the user's approved rollout scope.

Issue or PR acceptance decision: **Pending**. Link each claimed requirement to a real artifact; leave unexecuted or unmet requirements open.

# Relay MCP Remote Deployment Command Guide

This guide defines the reusable Relay MCP execution pattern for remote deployment work. It is intentionally project-neutral.

## 1. Resolve and pin the target

Call `relay_route_check` once with the intended `project`, `environment`, and preferably `serverId`. Keep the resolved values unchanged for every later call.

When starting a SampleManager deployment, `samplemanager_deployment_start` records a target snapshot containing the project server link, server, connection mode, instance root, and configured database. Operations that reuse the `deploymentId` must match that snapshot.

Use `relay_project_server_links_list` only when the target is unknown or the configured links have changed.

## 2. Run one bounded read-only preflight

Use `samplemanager_instance_preflight` to combine exact path, file, XML, FormsBin, service, process, and recent-error checks in one remote PowerShell invocation.

Pass only exact file paths and form identities. The result is bounded JSON and does not return full XML, assembly metadata, or complete logs. Use `read_remote_file`, `samplemanager_inspect_assembly_type`, or `fetch_logs` for a focused follow-up.

For Workflow work, use the same read-only phase with a bounded target:

```text
samplemanager_workflow_export
-> samplemanager_workflow_validate
-> samplemanager_workflow_compare (when a baseline is available)
```

`samplemanager_workflow_export` discovers the target instance's actual Workflow table columns, resolves a Workflow name to its ID when possible, and stores the complete bounded response as a query artifact. The validator reports topology, unresolved links, cycles, unreachable nodes, and static node-contract gaps. SQL cannot prove assembly registration or a successful runtime callback; use `samplemanager_inspect_assembly_type`, `samplemanager_inspect_deployment_runtime`, logs, or the dedicated Playwright tools for those claims.

After a file or assembly change, use `samplemanager_inspect_deployment_runtime` with exact `filePaths` and `assemblyPaths` plus the same `deploymentId`. It returns disk SHA-256/version, service and process state, loaded-module evidence where Windows permits module inspection, and error lines filtered by their log timestamps. It is read-only and does not restart the instance.

## 3. Separate read and write phases

Use this order:

```text
relay_route_check
-> samplemanager_instance_preflight
-> review the requested change scope
-> samplemanager_deployment_start
-> upload_workspace_file
-> mutation/deploy/cache/restart tools
-> job_wait
-> samplemanager_instance_preflight
-> fetch_logs with a bounded time window
-> samplemanager_deployment_finish
```

Do not mix a service restart, cache deletion, or business-data mutation into a read-only preflight script.

## 4. Transfer files by hash

Stage local files in the Relay project workspace, then call `upload_workspace_file` with the pinned target and optional `deploymentId`.

The tool now:

- calculates the workspace SHA-256;
- skips an identical remote target;
- uploads to a temporary path;
- verifies the temporary SHA-256;
- atomically replaces the target;
- verifies the final SHA-256;
- records upload evidence in the deployment when supplied.

Use `create_workspace_upload` for large files entering the Relay workspace. Do not embed DLL, ZIP, XML, or localized resource bytes in PowerShell strings.

## 5. Track long operations as jobs

Build, package import, file upload, cache cleanup, instance restart, and other long or side-effecting operations should run with `async=true`.

Call `job_wait` with a 30-90 second wait window. Do not repeatedly call `job_status` while the phase is unchanged. A wait timeout is only a wait deadline; a job with execution state `Unknown` must be verified before retrying.

## 6. Require repeatable mutations

Every mutation should report `changed`, `skipped`, or `failed`, plus target, previous evidence, resulting evidence, and backup details where applicable.

File operations compare SHA-256 before replacement. SQL change sets use idempotency keys. After transport or execution timeout, query the job and deployment records and perform a read-only target check before any retry.

## 7. Collect bounded logs and evidence

Use `fetch_logs` with `since`, `until`, or `deploymentId` and a small `lines` value. Do not scan an entire log tree by default.

The final deployment record should retain:

- target project, environment, server link, server, instance, and database;
- source and target file hashes;
- backup paths;
- job IDs and phase results;
- cache cleanup and restart results;
- verification and bounded log evidence;
- final status and rollback guidance.

## 8. Integrated Knowledge operations

Work Sessions use `knowledge_work_session_open`, `knowledge_work_session_update`, and `knowledge_work_session_close` with an idempotency key and a user-visible IntentEnvelope. Job, Deployment, diagnostics, Evidence, and retrieval calls can carry `workSessionId` plus `intentStep`, `objectiveRef`, and `acceptanceCriterionRef`; Relay validates the actor, project, environment, and session lifecycle before correlating the event.

Managed Embedding, Rerank, Wiki LLM, and Candidate LLM settings can be configured at **Knowledge → Integrated control plane → Providers**. Enter the gateway Base URL and API token, click **Fetch models**, select the purpose and model, then **Test and save**. A root URL automatically uses `/v1`; an explicit API path is preserved. The gateway must expose an OpenAI-compatible `GET /models` endpoint. Empty or failed discovery keeps saving disabled; model IDs are not guessed. Saving makes a small probe request and detects embedding dimensions from its response.

If setup fails, the error identifies the operation (`GET /models`, `POST /embeddings`, `POST /rerank`, or `POST /chat/completions`) and includes a Relay request ID. Match that ID to the server's `provider_setup_failed` log event. Its diagnostics contain the upstream HTTP status when a response was received, a bounded upstream request ID when safe, and response format (`json`, `html`, or `other`). A network failure or timeout before any response has no upstream status. The response and logs exclude raw upstream bodies, credentials, and user-supplied URLs. **Test and save** rechecks the model list before probing: a model-discovery failure does not call the model and may have no usage record at the gateway. These diagnostics identify the failed step; they do not by themselves prove which upstream component caused a 502.

Tokens entered in this form are encrypted with AES-256-GCM in `knowledge_provider_secrets`. The separate 32-byte key defaults to `.provider-credentials.key` beside `knowledge.db`; set `PROVIDER_SECRET_KEY_FILE` to override its location. Web and MCP must use the same database and key file. The key is created on first credential save with owner-only permissions on Unix. Back up the original key separately and restore it with the database; do not regenerate it or include it in Git. A missing key with existing credentials fails closed.

The browser receives only `tokenConfigured`, never the token or ciphertext. **Replace token** tests the replacement first; **Clear token** removes the stored credential and disables that provider. Changing an embedding model or its dimensions retains the existing reindex requirement. Existing `env://NAME` references and the legacy reference-only API/MCP configuration remain supported. Use `knowledge_provider_config_list` to inspect state and pending reindex work. Provider probes report only status, latency, HTTP status, numeric usage, and an error class.

Product Knowledge remains on `relay_local` until an administrator stages a local migration, validates it, and explicitly publishes it to WeKnora. `knowledge_migration_from_local`, `knowledge_migration_publish`, and `knowledge_migration_rollback` preserve local data, Evidence, and long-term memory; rollback restores Relay routing without deleting upstream documents. Cleanup is currently dry-run only.

Candidate Insights always remain drafts until a reviewer confirms, edits, rejects, or promotes them with a reason. Provider timeout, rate limiting, malformed output, or unavailable configuration produces a deterministic Evidence-backed fallback instead of blocking Job, Deployment, Evidence, or outbox processing. Wiki pages are Relay-native, revisioned, source-referenced, ACL-scoped, and audited.

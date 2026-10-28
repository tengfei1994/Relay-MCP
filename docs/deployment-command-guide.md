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

Managed Embedding, Rerank, Wiki LLM, and Candidate LLM settings use backend secret references such as `env://NAME`; raw tokens are rejected. Use `knowledge_provider_config_list` to inspect state and pending reindex work. Provider probes report only status, latency, HTTP status, numeric usage, and an error class.

Product Knowledge remains on `relay_local` until an administrator stages a local migration, validates it, and explicitly publishes it to WeKnora. `knowledge_migration_from_local`, `knowledge_migration_publish`, and `knowledge_migration_rollback` preserve local data, Evidence, and long-term memory; rollback restores Relay routing without deleting upstream documents. Cleanup is currently dry-run only.

Candidate Insights always remain drafts until a reviewer confirms, edits, rejects, or promotes them with a reason. Their only kinds are `fact`, `decision`, `case`, and `pattern`. Promotion creates a typed Confirmed Memory with Evidence, scope, source, confirmer, confirmation time and audit metadata; it never writes a new legacy Case/Pattern/Playbook lifecycle row. Candidate Insights never enter the default Confirmed Context Pack. Provider timeout, rate limiting, malformed output, or unavailable configuration produces a deterministic Evidence-backed fallback instead of blocking Job, Deployment, Evidence, or outbox processing. Wiki pages are Relay-native, revisioned, source-referenced, ACL-scoped, and audited.

# Relay MCP Remote Deployment Command Guide

This guide defines the reusable Relay MCP execution pattern for remote deployment work. It is intentionally project-neutral.

## 1. Resolve and pin the target

Call `relay_route_check` once with the intended `project`, `environment`, and preferably `serverId`. Keep the resolved values unchanged for every later call.

When starting a SampleManager deployment, `samplemanager_deployment_start` records a target snapshot containing the project server link, server, connection mode, instance root, and configured database. Operations that reuse the `deploymentId` must match that snapshot.

Use `relay_project_server_links_list` only when the target is unknown or the configured links have changed.

## 2. Run one bounded read-only preflight

Use `samplemanager_instance_preflight` to combine exact path, file, XML, FormsBin, service, process, and recent-error checks in one remote PowerShell invocation.

Pass only exact file paths and form identities. The result is bounded JSON and does not return full XML, assembly metadata, or complete logs. Use `read_remote_file`, `samplemanager_inspect_assembly_type`, or `fetch_logs` for a focused follow-up.

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

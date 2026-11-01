# Wiki generation progress and controls

## Intent

Show real Wiki generation progress in the Knowledge Wiki page and provide durable pause/resume controls for individual Wiki generation jobs. Manual and automatic jobs remain distinguishable and independently controllable.

## Current behavior

- `knowledge_ingest_jobs` already persists Wiki generation payloads with `topicGroupIds`, `cursor`, and the latest `{ processed, total, generated, failures }` result.
- The worker processes five topic groups per dispatch and requeues the job between batches.
- The UI currently shows only aggregate counts from `knowledge_wiki_generation_state`; it does not render job progress or control a job.
- Manual generation is identified only indirectly by the `manual-*` trigger id. Automatic generation is used by imports and bootstrap/retry flows.

## Chosen approach

Use a durable per-job control state in `knowledge_ingest_jobs`.

- Add `trigger_kind` with `manual` or `automatic`.
- Add `control_state` with `active`, `pause_requested`, or `paused`.
- Keep the existing execution lifecycle (`queued`, `running`, `succeeded`, `failed`) separate from control state.
- Add pause/resume timestamps and actor ids for auditability.
- Existing rows default to `automatic`; legacy `manual-*` trigger ids are migrated to `manual`.

Pause behavior is cooperative. A pause request made while a five-topic batch is running lets the current topic call finish, then the worker persists `paused` before releasing the job. A queued job can be paused immediately and will not be claimed. Resume changes the job back to `queued` and schedules it. Completed and failed jobs cannot be paused or resumed.

The control API is admin-only and limited to `wiki_generation` jobs:

- `POST /api/knowledge/ingest-jobs/:id/control` with `{ "action": "pause" }` or `{ "action": "resume" }`.
- The response returns the normalized job, control state, trigger kind, and progress.

The existing Wiki generation status endpoint will expose normalized job summaries with:

- `processed`, `total`, `percent`;
- `generated`, `failures`;
- `status`, `controlState`, `triggerKind`;
- `updatedAt`, `startedAt`, `finishedAt`.

## UI behavior

- Poll generation status while any Wiki generation job is queued, running, or pause-requested; stop polling when no active job remains.
- Show a progress bar using `processed / total`, plus generated and failed counts.
- Show each active/recent job with an `Automatic` or `Manual` badge.
- Show `Pause` for active jobs and `Resume` for paused jobs.
- Pausing an automatic job affects only that job; future automatic jobs remain allowed. This first version does not introduce a global pause switch and does not pause Product document imports.
- Refresh the directory after a manual generation request and after a job reaches a terminal state.

## Worker safety

- The dispatcher claims only queued jobs whose control state is `active`.
- The Wiki worker checks control state before each topic and before requeueing the next batch.
- Pause/resume updates use the job id and current control state so duplicate clicks are rejected with a clear conflict response.
- Ownership checks remain in force; a pause request cannot cause another worker to process the same batch.

## Tests

Add tests for:

1. Manual and automatic enqueue paths persist the correct trigger kind.
2. A queued job paused before claim is not executed.
3. A running job pauses at the next batch boundary and preserves its cursor.
4. Resume requeues the job without resetting progress.
5. Terminal jobs reject pause/resume and non-admin callers are rejected.
6. The status endpoint returns an accurate percentage and control state.
7. The UI renders progress and the correct pause/resume action for both trigger kinds.

## Non-goals

- Killing an active model call or worker process.
- Pausing Product document imports or unrelated ingest jobs.
- Adding a global pause-all policy in this change.

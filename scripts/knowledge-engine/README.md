# Relay-managed knowledge engine

The upstream WeKnora Lite API is an internal Relay component. It binds only to `127.0.0.1:18190`; Relay remains the UI, authentication and model-credential boundary. The release is pinned to v0.8.3 / `3e22822c1d2397be730c458c7539d0eb8c113a24`.

## Build and install

Build once on a Linux amd64 worker with GCC/G++, make, Python 3, pkg-config and SQLite development headers. Allow at least 8 GB RAM and 15 GB working disk space. The script downloads a checksum-pinned Go 1.26.10 toolchain into its private build directory; no sudo, Docker, Redis or PostgreSQL is used.

```bash
bash scripts/knowledge-engine/build.sh /path/to/dedicated/build
KNOWLEDGE_ENGINE_BUNDLE=/path/to/dedicated/build/bundle bash deploy.sh
```

The existing Relay deployment consumes the verified bundle; production servers do not compile the engine. A failed checksum or incomplete bundle never changes the active release. To upgrade, stop the engine, back up, then install a newly reviewed pinned release. Upstream upgrades require updating the source lock and validating migration compatibility. Reviewed Relay patches are tracked independently by exact source and patch hashes.

For an isolated nonproduction instance:

```bash
export KNOWLEDGE_ENGINE_HOME=/path/to/nonproduction/runtime/knowledge-engine
node scripts/knowledge-engine.mjs install --bundle /path/to/build/bundle --port 18190 --gateway-url http://127.0.0.1:18300/internal/knowledge-engine/v1
node scripts/knowledge-engine.mjs start
node scripts/knowledge-engine.mjs status
node scripts/knowledge-engine.mjs restart
node scripts/knowledge-engine.mjs stop
```

`install` without `--bundle` builds locally on a Linux worker. `run` stays in the foreground for PM2. `status` reports safe metadata only; `wait` additionally fails unless HTTP health and all SQLite migrations are ready. Readiness checks the pinned migration version, dirty flag and required application tables because upstream can continue after a migration warning.

## Deployment lifecycle and backups

Use the unified entry point for a PM2 deployment so stopping the engine also stops its supervisor:

```bash
bash deploy.sh engine-status
bash deploy.sh engine-stop
bash deploy.sh engine-start
bash deploy.sh engine-backup
bash deploy.sh engine-restore /path/to/backup
```

Backup requires a stopped engine, copies original files and private bootstrap state, and uses SQLite's backup API. Restore requires an installed compatible release with an empty data directory and preserves the destination's listener/gateway URLs. Existing data is never overwritten. Keep the snapshot private: it contains the engine encryption key and Relay's internal scoped credential. Backup the Relay database separately at the same maintenance boundary to preserve Relay-owned mappings/publication state.

`KNOWLEDGE_ENGINE_HOME` defaults to `<repository>/runtime/knowledge-engine`. Its `engine.json`, `control.json`, `data/`, `logs/`, `run/` and `backups/` are private runtime state. Only Relay's bootstrap code writes `control.json`. Install/reinstall preserves credentials. `KNOWLEDGE_ENGINE_ENABLED=false` omits the PM2 component for an explicit rollback or development-only deployment.

The minimal bundle supports normalized Markdown/text/JSON/CSV with upstream's in-process parser. Relay converts Office/PDF inputs before ingestion; the optional upstream Python Docreader and frontend are not bundled. Tasks and streams are process-local in Lite, so keep one engine process per data directory.
## Model logging security policy

The managed build keeps the upstream v0.8.3 commit and source archive checksum,
then applies the reviewed patches in `upstream-lock.json`. The patch, every target
file before and after patching, and the regression tests have pinned SHA-256
hashes. Every build extracts fresh source from the verified archive, applies the
patch with exact preimage checks, and runs the upstream model API protocol suite.
A stale, partial, modified, or unpatched tree cannot produce an accepted bundle.

The patched request logger records only byte/message counts and stream state.
It never logs request URLs, free-form model names, prompts, responses or reasoning.
Provider HTTP/error responses remain available only as typed in-memory values
for retries and capability handling; their public error strings omit private
bodies and transport URLs. Dedicated LLM and raw-stream dumps are disabled.
The runtime always supplies `LOG_LEVEL=warn`, `LLM_DEBUG_LOG=false` and
`WEKNORA_LLM_STREAM_RAW_DUMP=false` through an environment allowlist.

The bundle manifest records `sourceArchiveSha256`, `securityPolicy` and
`relayPatches`; `relay-upstream-lock.json` and `relay-log-safety-proof.json`
bind the verified tests to the produced binary. Install and process startup
reject artifacts without that exact policy and proof. The unified build also
installs the separately checksum-pinned 7-Zip extraction tool and records all its
binary/license hashes; installation preserves its private executable permission.

An existing unsafe release can temporarily run under the warning-level launcher
while its replacement is built. Deploy the final launcher together with the
verified patched bundle: the final startup check rejects an older unpatched
release. Previously written logs are retained for investigation, protected with
mode 0600; lowering log verbosity does not erase earlier prompt records. Capture
a byte offset after restart and scan only new log data when validating the fix.

The second pinned patch preserves the outer hyperlink around Markdown images
through inline, data-URI and remote-image resolution. Image storage still rewrites
only the inner image URL. The build runs the upstream docparser suite and records
`relay-content-preservation-proof.json` alongside the existing model-log proof.
This avoids deleting original-image destinations from normalized Product content
between chunk preview and upload indexing. Rebuild into a fresh bundle; installing
it does not reparse previously indexed documents or authorize model calls.

The separate third patch recognizes
`RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY=true`. Relay's launcher always sets it.
Only `documentProcessTaskOptions` is affected: the managed zero-retry option is
appended after caller options, so file uploads and explicit reparses execute one
queue attempt. A failure requires another explicit operation. Upstream processes
without this flag keep their original retry policy; postprocess/Wiki tasks and
Relay Provider retry settings are unchanged. The build feeds the service's actual
option sequence into the real Lite executor and records the single-attempt proof
in `relay-document-retry-proof.json`.

Durable provider admissions count logical invocations that reach the transport
boundary, including failures. Every upstream queue/SDK re-invocation admitted
through the gateway receives a new durable admission. Retries inside one Relay
Provider invocation share its admission (the acceptance configuration permits one
Provider retry). Circuit/queue rejections before transport are not admissions.
Consequently the ledger is not a count of physical HTTP attempts or billed tokens.

The fourth pinned patch aligns unset RRF weights with Relay #53's technical
keyword priority: vector 0.3 / keyword 0.7 when neither weight is positive.
Any explicit positive tenant weight retains the legacy fallback for a missing
counterpart, preserving partial configurations' effective ratios. The RRF
smoothing constant and all other retrieval settings remain intact.
Fusion math and source aggregation are unchanged. The build runs behavioral
fusion regressions and records `relay-keyword-first-rrf-proof.json`; the five-case
causal probe is diagnostic evidence, not a pass of the frozen 55-case evaluation.
This patch does not write tenant configuration or re-embed existing documents.

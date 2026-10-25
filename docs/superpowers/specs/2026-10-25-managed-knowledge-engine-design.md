# Relay-managed Knowledge Engine Design (2026-10-25)

User direction: complete true WeKnora integration and replacement, reuse Relay models and deployment, no separately operated WeKnora; reopen any issues without acceptance evidence and close only after real E2E.

## Scope and decisions
- Keep Relay as the only UI/MCP/auth boundary. Work Sessions, memory, Evidence, ACL, version bindings, publication and audit stay Relay-owned.
- Replace Product document body/chunk/index/search and Wiki backend with real Tencent/WeKnora v0.8.3, pinned to its release commit. Use upstream Lite mode as an internal supervised process (Go, SQLite vector/FTS, in-process tasks). No second web frontend, PG/Redis stack or user-managed WeKnora credentials. This is an implementation choice under the approved integration boundary.
- Alternatives considered: external separately administered WeKnora contradicts the request; copying/reimplementing its capabilities creates a fork and does not prove upstream integration; a bundled internal Lite engine reuses the upstream code and keeps Relay the operational unit.
- Relay installer owns versioned binary/config/migrations, private data/log/PID dirs, health/start/stop/backup. Build on separate nonproduction Linux host; production reads only until integration is verified.
- Existing ProviderSetupService/ProviderCredentialStore and ProviderRegistry remain authoritative. An authenticated internal OpenAI-compatible model gateway resolves current Relay provider configuration on each request. Upstream receives only a scoped internal credential, never the user's model key.
- Bootstrap a private upstream tenant/key and knowledge base idempotently. Persist engine connection/bootstrap state privately, automatic initialization from the Relay provider selection. New model index versions create a new binding; never mix dimensions or silently acknowledge a pending reindex.
- Route existing knowledge_search/get and Product Web search/read through the selected Product backend. Memory remains local. During explicit migration only, local Product data remains readable; after publish no silent fallback to old Product FTS.
- Relay publication/scope filters are enforced before request and on returned document IDs. Include project/environment/version/solution/module/language; hydrate source locator/hash from Relay mappings when upstream omits metadata.
- Keep upstream parse/index state separate from Relay staged/published lifecycle. Publish only successfully parsed documents, store real chunk IDs, make retry idempotent and failure reports bounded.
- Wiki pages/revisions/search use upstream Wiki APIs; Relay enforces ACL, source refs and published/deprecated visibility, retains immutable audit. Preserve old local pages for explicit migration; do not present SQLite CRUD as upstream Wiki.
- Real E2E uses actual Lite process and configured remote embedding/LLM with a bounded fixture initially, then available representative SampleManager data. Mock tests remain unit tests, never release proof.

## Acceptance
1. One Relay deployment entry point installs/starts/stops/health-checks engine, restart preserves data, backup restores a nonproduction instance.
2. Actual upstream parsing -> embedding via Relay gateway -> index -> published search -> source read works; recorded provider/model/dimension and real chunk IDs.
3. Token rotation/disable enforced at gateway; scope and authentication failures cannot broaden search, expose credentials or trigger local fallback.
4. Actual Wiki create/search/read/edit/diff/rollback/source navigation passes through Relay API/UI.
5. Existing MCP/API contracts work across switch/rollback; evidence/memory unchanged, staged/deprecated/foreign environment excluded.
6. Full tests/build, real E2E logs, IDs, request metrics and sensitive-field scan recorded. Bulk document/quality claims require their own measured reports.
7. Reopened issues remain open for missing evidence, unsupported upstream operations, external model limitations or unverified scale.

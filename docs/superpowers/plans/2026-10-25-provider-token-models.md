# Provider token and model selection implementation plan

**Goal:** Let administrators enter a Base URL and token, fetch models, select one, and test/save a provider without manually managing secret references or embedding dimensions.

**Architecture:** Backend-only model discovery and probes; AES-256-GCM encrypted credentials in the knowledge database with a separate persistent key file. Existing environment references remain compatible. Web and MCP share the same resolver.

**Tech Stack:** TypeScript, Fastify, SQLite, Node crypto, React.

**Spec:** User-approved flow in this conversation. Implement directly, create PR, merge main and deploy through SSH host RelayMCP.

## Constraints and review focus
- Keep plaintext tokens out of DTOs, logs, audit, local storage and SQLite.
- Verify unauthorized callers cannot discover models or change credentials.
- Bound upstream requests; reject URL credentials/query strings and redirects.
- Failures must not overwrite working configuration; changed inputs invalidate model selection.
- Preserve credentials across restarts and sharing between Web/MCP; detect missing or corrupt keys.

## Tasks
- [x] Add failing HTTP/storage tests for discovery, safe errors, authorization, encrypted persistence, rotation/clear and dimension detection.
- [x] Implement encrypted resolver, discovery calls and transactional provider setup API; run targeted tests.
- [x] Replace manual model/secret-reference fields with token and fetched model selection; verify a real browser flow against a local fixture gateway.
- [x] Run full tests, standard build, review diff, document setup and verification.
- [ ] Commit and push isolated branch, create/attach PR, merge verified head, deploy main and verify production health and rendered UI.

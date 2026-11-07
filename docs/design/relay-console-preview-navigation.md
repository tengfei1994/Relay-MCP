# Relay console preview navigation

The console previews use separate static pages for each navigation category. The overview files contain only status, orientation and links to the deeper surfaces.

## User

- `relay-website-user-preview-v1.html` — workspace overview and project scope
- `relay-website-user-projects-preview-v1.html` — projects, files and server/instance links
- `relay-website-user-activity-preview-v1.html` — run and Memory activity
- `relay-website-user-servers-preview-v1.html` — remote hosts, SSH/Agent setup and tests
- `relay-website-user-instances-preview-v1.html` — SampleManager discovery, import and instance maintenance
- `relay-website-user-tools-preview-v1.html` — tool catalog, access/execution metadata and inspectors
- `relay-website-user-knowledge-preview-v1.html` — Knowledge landing and lifecycle entry points
- `relay-website-user-knowledge-integrated-preview-v1.html` — Work Sessions, providers, engine and reindex jobs
- `relay-website-user-knowledge-wiki-preview-v1.html` — generated Wiki pages and citation lifecycle
- `relay-website-user-knowledge-product-docs-preview-v1.html` — Product docs, topics, search and versions
- `relay-website-user-knowledge-solutions-preview-v1.html` — source-backed reusable Solutions
- `relay-website-user-memory-preview-v1.html` — Memory workspace, confirmed records and submissions
- `relay-website-user-knowledge-sessions-preview-v1.html` — captured Work Sessions
- `relay-website-user-knowledge-evidence-preview-v1.html` — immutable Evidence and safe preview
- `relay-website-user-knowledge-observations-preview-v1.html` — runtime Observations
- `relay-website-user-knowledge-candidates-preview-v1.html` — Candidate Insights lifecycle
- `relay-website-user-knowledge-cases-preview-v1.html` — structured Cases
- `relay-website-user-knowledge-patterns-preview-v1.html` — repeatable Patterns
- `relay-website-user-knowledge-playbooks-preview-v1.html` — project Playbooks
- `relay-website-user-knowledge-operations-preview-v1.html` — operations overview
- `relay-website-user-knowledge-operations-capture-preview-v1.html` — capture health and replay
- `relay-website-user-knowledge-operations-ingest-preview-v1.html` — ingest runs and diagnostics
- `relay-website-user-knowledge-operations-index-preview-v1.html` — index/provider status and reindex jobs
- `relay-website-user-tokens-preview-v1.html` — combined MCP and Relay Agent token management
- `relay-website-user-mcp-tokens-preview-v1.html` — focused MCP client credential view
- `relay-website-user-agent-tokens-preview-v1.html` — focused Relay Agent credential view
- `relay-website-user-account-preview-v1.html` — profile and password management

## Administrator

- `relay-website-admin-preview-v1.html` — control-plane overview
- `relay-website-admin-requests-preview-v1.html` — access request decisions
- `relay-website-admin-users-preview-v1.html` — accounts, admin status, Knowledge permission and passwords
- `relay-website-admin-knowledge-preview-v1.html` — Candidate Insight, Product classification, Memory scope and provider/Wiki review
- `relay-website-admin-audit-preview-v1.html` — administrator audit trail

The shared `relay-console-navigation.js` keeps the top bar aligned with `frontend/src/components/shell/navigation.ts`: Projects, Servers, Instances, Tools, Knowledge, Tokens and admin-only Users. The desktop side rail is contextual only; it shows Knowledge, Memory, Operations, token or administrator subnavigation instead of repeating the primary routes. On mobile, the collapsed rail temporarily exposes the primary routes so navigation remains reachable.

All page links are ordinary relative links, so the prototype can be opened directly from the filesystem or served as static files.

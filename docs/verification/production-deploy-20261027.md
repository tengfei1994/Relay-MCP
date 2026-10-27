# Production deployment and rollback checkpoint — 2026-10-27

The verified `main` merge `f32b48573de4c2d482baa44eb2ca4019f9ac2d23` was prepared for the documented `/home/ftd/MCP` production checkout. Before restart, the checkout, application databases, `.env`, source archive and built assets were backed up under:

```text
/home/ftd/relay-deploy-backups/20261027T150807Z-main-f32b485-pre
```

The application dependencies and build completed on the host. The managed Knowledge engine was explicitly kept disabled because no production engine bundle was installed. Web/MCP restart then failed closed during KnowledgeStore startup against the existing database. The observed errors were a foreign-key failure during legacy topic backfill and SQLite rejecting a pre-existing double-quoted `knowledge_documents` CHECK literal while reparsing a later migration.

The deployment was rolled back without publication or model calls: the checkout returned to `b25ee02cfc0b82cfb54b044a035390c097e8781e`, the application databases and `.env` were restored from the pre-deploy backup, and the old source was rebuilt before PM2 restart. Post-rollback Web health returned `200` with `ok:true`, the homepage returned `200`, and Web/MCP remained online.

The follow-up compatibility repair rebuilds only the legacy `knowledge_documents` table when that malformed schema is detected, preserving rows, indexes and triggers before later migrations run. Its regression and the full application suite pass locally; the repair must be merged and re-deployed as a separate, verified change before production is moved beyond `b25ee02`.

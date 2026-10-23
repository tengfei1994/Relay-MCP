import type { KnowledgeStore } from "./store.js";

/**
 * Automatable release gates for the integrated Knowledge control plane
 * (#49/#56). Every check is computed deterministically from the existing
 * store tables. Metrics are counts and classified labels only: queries,
 * prompts, document bodies, tokens, connection strings and hidden reasoning
 * never appear in the report, and security findings name only the table and
 * record category — never the offending content or row id.
 */
export interface ReleaseGateReport {
  ready: boolean;
  checkedAt: string;
  failures: string[];
  checks: {
    database: { ok: boolean; status: string };
    migrations: { ok: boolean; created: number; staged: number; published: number; failed: number; rolledBack: number };
    providers: { ok: boolean; configured: number; ready: number; degraded: number; disabled: number; pendingReindex: number };
    reindex: { ok: boolean; required: number; pendingJobs: number; runningJobs: number; completedJobs: number; failedJobs: number };
    acl: { ok: boolean; totalRows: number; invalidRows: number };
    publishedVisibility: { ok: boolean; stagedDocuments: number; publishedDocuments: number; publishedMissingExternalId: number; stagedVisible: number; deprecatedVisible: number };
    wiki: { ok: boolean; publishedWithoutSourceRefs: number };
    candidateEvidence: { ok: boolean; withoutEvidence: number; unresolvedEvidence: number };
    contextMetrics: { ok: boolean; uncorrelatedEvents: number };
    importMetrics: { ok: boolean; failedJobs: number };
    securityScan: { ok: boolean; findings: string[] };
    rollback: { ok: boolean; publishedWithoutManifest: number };
  };
  metrics: {
    sessions: { total: number; open: number; active: number; awaitingReview: number; needsClarification: number; completed: number; abandoned: number };
    events: { total: number; correlated: number; uncorrelated: number };
    candidates: { total: number; draft: number; accepted: number; edited: number; rejected: number; fallback: number; withEvidence: number; withoutEvidence: number; unresolvedEvidence: number; jobsQueued: number; jobsDone: number; jobsFailed: number; fallbackReasons: Record<string, number> };
    providers: { total: number; ready: number; degraded: number; disabled: number; pendingReindex: number; errorClasses: Record<string, number> };
    imports: {
      ingest: { total: number; queued: number; running: number; succeeded: number; failed: number; retried: number; avgDurationMs: number | null };
      weknora: { staged: number; published: number; deprecated: number; failed: number };
    };
    wiki: { total: number; draft: number; published: number; deprecated: number; revisions: number; withSourceRefs: number; publishedWithSourceRefs: number; rollbacks: number };
    outbox: { backlog: number; pendingClaims: number; deadLetter: number };
  };
}

/**
 * Value-level secret patterns: Bearer tokens, credential assignments,
 * connection strings with embedded credentials and raw provider keys.
 */
const SECRET_VALUE = /(bearer\s+\S+|(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|connection[-_ ]?string)\s*[:=]\s*["']?\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@|\bsk-[A-Za-z0-9_-]{8,})/i;
/** Exact-match sensitive field names; prefixed names like token_configured stay legitimate. */
const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|connection[-_]?string|authorization|client[-_]?secret)$/i;
/** Hidden reasoning / chain-of-thought fields are never persisted anywhere. */
const HIDDEN_REASONING_KEY = /chain.?of.?thought|hidden.?reasoning|^reasoning$|^thinking$|^thought$|scratchpad|internal.?monologue|system.?prompt/i;

type ScanCategory = "secret-like value" | "secret-like field" | "hidden reasoning field";

function scanSecretLike(value: unknown, depth = 0): ScanCategory | undefined {
  if (depth > 12 || value === null || value === undefined) return undefined;
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "secret-like value" : undefined;
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      const hit = scanSecretLike(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (SECRET_KEY.test(key)) return "secret-like field";
    if (HIDDEN_REASONING_KEY.test(key)) return "hidden reasoning field";
    const hit = scanSecretLike(item, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

export function runReleaseGates(store: KnowledgeStore, now = new Date()): ReleaseGateReport {
  const failures: string[] = [];
  const db = store.db;
  const tableExists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const count = (sql: string, ...params: unknown[]): number => Number((db.prepare(sql).get(...params) as { count: number }).count);
  const countIf = (table: string, sql: string, ...params: unknown[]): number => (tableExists(table) ? count(sql, ...params) : 0);
  const groupCounts = (table: string, sql: string): Map<string, number> => {
    const out = new Map<string, number>();
    if (!tableExists(table)) return out;
    for (const row of db.prepare(sql).all() as Array<{ status: string; count: number }>) out.set(String(row.status), Number(row.count));
    return out;
  };

  // ---- database -------------------------------------------------------
  const coreTables = ["knowledge_documents", "knowledge_audit", "knowledge_migrations", "knowledge_work_sessions"];
  const database = { ok: coreTables.every(tableExists), status: "available" };
  if (!database.ok) { database.status = "incomplete"; failures.push("knowledge database schema is incomplete"); }

  // ---- migrations ------------------------------------------------------
  const migrationCounts = groupCounts("knowledge_migrations", "SELECT status,COUNT(*) AS count FROM knowledge_migrations GROUP BY status");
  const migrations = {
    created: migrationCounts.get("created") ?? 0,
    staged: migrationCounts.get("staged") ?? 0,
    published: migrationCounts.get("published") ?? 0,
    failed: migrationCounts.get("failed") ?? 0,
    rolledBack: migrationCounts.get("rolled_back") ?? 0,
    ok: true,
  };
  migrations.ok = migrations.failed === 0 && migrations.staged === 0;
  if (migrations.failed > 0) failures.push("failed knowledge migrations exist");
  if (migrations.staged > 0) failures.push("staged knowledge migrations are not published");

  // ---- rollback manifests ----------------------------------------------
  let publishedWithoutManifest = 0;
  if (tableExists("knowledge_migrations")) {
    const rows = db.prepare("SELECT rollback_manifest_json FROM knowledge_migrations WHERE status='published'").all() as Array<{ rollback_manifest_json: string }>;
    for (const row of rows) {
      let manifest: Record<string, unknown> = {};
      try { const parsed = JSON.parse(String(row.rollback_manifest_json ?? "{}")); if (parsed && typeof parsed === "object") manifest = parsed as Record<string, unknown>; } catch { /* counted below */ }
      const documentIds = Array.isArray(manifest.documentIds) ? manifest.documentIds : [];
      if (typeof manifest.restoreProvider !== "string" || documentIds.length === 0) publishedWithoutManifest += 1;
    }
  }
  const rollback = { ok: publishedWithoutManifest === 0, publishedWithoutManifest };
  if (!rollback.ok) failures.push("published migration lacks a rollback manifest");

  // ---- providers --------------------------------------------------------
  const providerCounts = groupCounts("knowledge_provider_configs", "SELECT status,COUNT(*) AS count FROM knowledge_provider_configs GROUP BY status");
  const providerErrorClasses: Record<string, number> = {};
  let providerTotal = 0;
  if (tableExists("knowledge_provider_configs")) {
    for (const value of providerCounts.values()) providerTotal += value;
    const rows = db.prepare("SELECT last_error_code,COUNT(*) AS count FROM knowledge_provider_configs WHERE last_error_code IS NOT NULL GROUP BY last_error_code").all() as Array<{ last_error_code: string; count: number }>;
    for (const row of rows) {
      const code = String(row.last_error_code);
      // Error classes are classified labels only; anything else is bucketed.
      const label = /^[a-z0-9_:-]{1,64}$/i.test(code) ? code : "unclassified";
      providerErrorClasses[label] = (providerErrorClasses[label] ?? 0) + Number(row.count);
    }
  }
  const providers = {
    configured: providerTotal,
    ready: providerCounts.get("ready") ?? 0,
    degraded: providerCounts.get("degraded") ?? 0,
    disabled: providerCounts.get("disabled") ?? 0,
    pendingReindex: providerCounts.get("pending_reindex") ?? 0,
    ok: true,
  };
  providers.ok = providers.degraded === 0 && providers.disabled === 0;
  if (!providers.ok) failures.push("active provider is degraded or disabled");

  // ---- reindex -----------------------------------------------------------
  const reindexRequired = countIf("knowledge_provider_configs", "SELECT COUNT(*) AS count FROM knowledge_provider_configs WHERE reindex_required=1");
  const reindexCounts = groupCounts("knowledge_provider_reindex_jobs", "SELECT status,COUNT(*) AS count FROM knowledge_provider_reindex_jobs GROUP BY status");
  const reindex = {
    required: reindexRequired,
    pendingJobs: reindexCounts.get("pending") ?? 0,
    runningJobs: reindexCounts.get("running") ?? 0,
    completedJobs: reindexCounts.get("completed") ?? 0,
    failedJobs: reindexCounts.get("failed") ?? 0,
    ok: true,
  };
  reindex.ok = reindex.required === 0 && reindex.pendingJobs === 0 && reindex.runningJobs === 0;
  if (!reindex.ok) failures.push("provider reindex is pending");

  // ---- ACL ---------------------------------------------------------------
  const aclTotal = countIf("knowledge_acl", "SELECT COUNT(*) AS count FROM knowledge_acl");
  const aclInvalid = countIf("knowledge_acl", "SELECT COUNT(*) AS count FROM knowledge_acl WHERE can_read NOT IN (0,1) OR can_review NOT IN (0,1)");
  const acl = { ok: aclInvalid === 0, totalRows: aclTotal, invalidRows: aclInvalid };
  if (!acl.ok) failures.push("invalid knowledge ACL rows exist");

  // ---- published visibility ----------------------------------------------
  const weknoraCounts = groupCounts("knowledge_weknora_documents", "SELECT status,COUNT(*) AS count FROM knowledge_weknora_documents GROUP BY status");
  const publishedMissingExternalId = countIf(
    "knowledge_weknora_documents",
    "SELECT COUNT(*) AS count FROM knowledge_weknora_documents WHERE status='published' AND (external_document_id IS NULL OR length(trim(external_document_id))=0 OR external_document_id LIKE 'pending:%')",
  );
  const stagedVisible = tableExists("knowledge_migration_documents")
    ? count(`SELECT COUNT(*) AS count FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id = md.document_id WHERE md.status='published' AND w.status='staged'`)
    : 0;
  const deprecatedVisible = tableExists("knowledge_migration_documents")
    ? count(`SELECT COUNT(*) AS count FROM knowledge_migration_documents md JOIN knowledge_weknora_documents w ON w.id = md.document_id WHERE md.status='published' AND w.status='deprecated'`)
    : 0;
  const publishedVisibility = {
    stagedDocuments: weknoraCounts.get("staged") ?? 0,
    publishedDocuments: weknoraCounts.get("published") ?? 0,
    publishedMissingExternalId,
    stagedVisible,
    deprecatedVisible,
    ok: publishedMissingExternalId === 0 && stagedVisible === 0 && deprecatedVisible === 0,
  };
  if (publishedMissingExternalId > 0) failures.push("published WeKnora documents lack external ids");
  if (stagedVisible > 0 || deprecatedVisible > 0) failures.push("non-published WeKnora documents remain visible to routing");

  // ---- wiki ----------------------------------------------------------------
  const wikiCounts = groupCounts("knowledge_wiki_pages", "SELECT status,COUNT(*) AS count FROM knowledge_wiki_pages GROUP BY status");
  const wikiWithSourceRefs = countIf("knowledge_wiki_pages", "SELECT COUNT(*) AS count FROM knowledge_wiki_pages WHERE source_refs_json IS NOT NULL AND source_refs_json NOT IN ('','[]')");
  const wikiPublishedWithSourceRefs = countIf("knowledge_wiki_pages", "SELECT COUNT(*) AS count FROM knowledge_wiki_pages WHERE status='published' AND source_refs_json IS NOT NULL AND source_refs_json NOT IN ('','[]')");
  const wikiPublishedWithoutSourceRefs = countIf("knowledge_wiki_pages", "SELECT COUNT(*) AS count FROM knowledge_wiki_pages WHERE status='published' AND (source_refs_json IS NULL OR source_refs_json IN ('','[]'))");
  const wiki = { ok: wikiPublishedWithoutSourceRefs === 0, publishedWithoutSourceRefs: wikiPublishedWithoutSourceRefs };
  if (!wiki.ok) failures.push("published wiki pages lack source refs");

  // ---- candidate evidence ----------------------------------------------------
  let candidateWithoutEvidence = 0;
  let candidateUnresolvedEvidence = 0;
  let candidateWithEvidence = 0;
  const candidateCounts = groupCounts("knowledge_candidate_insights", "SELECT status,COUNT(*) AS count FROM knowledge_candidate_insights GROUP BY status");
  const candidateFallbackReasons: Record<string, number> = {};
  let candidateTotal = 0;
  let candidateFallback = 0;
  if (tableExists("knowledge_candidate_insights")) {
    for (const value of candidateCounts.values()) candidateTotal += value;
    const rows = db.prepare("SELECT evidence_refs_json,fallback_reason FROM knowledge_candidate_insights").all() as Array<{ evidence_refs_json: string; fallback_reason: string | null }>;
    const evidenceLookup = tableExists("knowledge_evidence")
      ? db.prepare("SELECT deleted_at FROM knowledge_evidence WHERE id=?")
      : undefined;
    for (const row of rows) {
      if (row.fallback_reason) {
        candidateFallback += 1;
        const label = String(row.fallback_reason);
        candidateFallbackReasons[label] = (candidateFallbackReasons[label] ?? 0) + 1;
      }
      let refs: string[] = [];
      try { const parsed = JSON.parse(String(row.evidence_refs_json ?? "[]")); if (Array.isArray(parsed)) refs = parsed.filter((item): item is string => typeof item === "string"); } catch { /* empty */ }
      if (refs.length === 0) { candidateWithoutEvidence += 1; continue; }
      const unresolved = refs.some((ref) => {
        const evidence = evidenceLookup?.get(ref) as { deleted_at?: string | null } | undefined;
        return !evidence || evidence.deleted_at;
      });
      if (unresolved) candidateUnresolvedEvidence += 1;
      else candidateWithEvidence += 1;
    }
  }
  const candidateEvidence = { ok: candidateWithoutEvidence === 0 && candidateUnresolvedEvidence === 0, withoutEvidence: candidateWithoutEvidence, unresolvedEvidence: candidateUnresolvedEvidence };
  if (!candidateEvidence.ok) failures.push("candidate insights lack valid evidence");

  const candidateJobCounts = groupCounts("knowledge_candidate_insight_jobs", "SELECT status,COUNT(*) AS count FROM knowledge_candidate_insight_jobs GROUP BY status");

  // ---- sessions / event correlation -------------------------------------------
  const sessionCounts = groupCounts("knowledge_work_sessions", "SELECT status,COUNT(*) AS count FROM knowledge_work_sessions GROUP BY status");
  let sessionTotal = 0;
  for (const value of sessionCounts.values()) sessionTotal += value;
  const eventsTotal = countIf("relay_domain_events", "SELECT COUNT(*) AS count FROM relay_domain_events WHERE type LIKE 'job.%' OR type LIKE 'deployment.%'");
  const correlatedEvents = tableExists("knowledge_work_session_events")
    ? count(`SELECT COUNT(DISTINCT e.id) AS count FROM relay_domain_events e JOIN knowledge_work_session_events se ON se.event_id = e.id WHERE e.type LIKE 'job.%' OR e.type LIKE 'deployment.%'`)
    : 0;
  const uncorrelatedEvents = eventsTotal - correlatedEvents;
  const contextMetrics = { ok: uncorrelatedEvents === 0, uncorrelatedEvents };
  if (!contextMetrics.ok) failures.push("uncorrelated relay events exist");

  // ---- imports ------------------------------------------------------------------
  const ingestCounts = groupCounts("knowledge_ingest_jobs", "SELECT status,COUNT(*) AS count FROM knowledge_ingest_jobs GROUP BY status");
  let ingestTotal = 0;
  for (const value of ingestCounts.values()) ingestTotal += value;
  const ingestRetried = countIf("knowledge_ingest_jobs", "SELECT COUNT(*) AS count FROM knowledge_ingest_jobs WHERE attempts > 1");
  let ingestAvgDurationMs: number | null = null;
  if (tableExists("knowledge_ingest_jobs")) {
    const row = db.prepare("SELECT AVG((julianday(finished_at) - julianday(started_at)) * 86400000) AS avg_ms FROM knowledge_ingest_jobs WHERE started_at IS NOT NULL AND finished_at IS NOT NULL").get() as { avg_ms: number | null };
    ingestAvgDurationMs = row.avg_ms === null || row.avg_ms === undefined ? null : Math.round(Number(row.avg_ms));
  }
  const ingestFailed = ingestCounts.get("failed") ?? 0;
  const importMetrics = { ok: true, failedJobs: ingestFailed };

  // ---- security scan --------------------------------------------------------------
  const findings = new Set<string>();
  const SCAN_ROW_LIMIT = 5000;
  const scanRows = (table: string, category: string, sql: string, columns: string[]) => {
    if (!tableExists(table) || findings.size >= 50) return;
    const rows = db.prepare(sql).all(SCAN_ROW_LIMIT) as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        const hit = scanSecretLike(parseMaybeJson(value));
        if (hit) findings.add(`${table}:${category}:${hit}`);
      }
      if (findings.size >= 50) return;
    }
  };
  scanRows("knowledge_provider_configs", "provider-config", "SELECT secret_ref,base_url,last_error_code FROM knowledge_provider_configs LIMIT ?", ["secret_ref", "base_url", "last_error_code"]);
  scanRows("knowledge_work_sessions", "work-session", "SELECT intent_json,summary,unknowns_json,acceptance_results_json FROM knowledge_work_sessions LIMIT ?", ["intent_json", "summary", "unknowns_json", "acceptance_results_json"]);
  scanRows("knowledge_evidence", "evidence-metadata", "SELECT source_locator FROM knowledge_evidence LIMIT ?", ["source_locator"]);
  scanRows("knowledge_candidate_insights", "candidate", "SELECT statement,why_proposed,evidence_refs_json,intent_refs_json,unknowns_json,reuse_boundary_json,confirmed_facts_json,observed_behavior_json,hypothesis,reusable_statement_json,fallback_reason,review_reason,promotion_json FROM knowledge_candidate_insights LIMIT ?", ["statement", "why_proposed", "evidence_refs_json", "intent_refs_json", "unknowns_json", "reuse_boundary_json", "confirmed_facts_json", "observed_behavior_json", "hypothesis", "reusable_statement_json", "fallback_reason", "review_reason", "promotion_json"]);
  scanRows("knowledge_wiki_pages", "wiki", "SELECT title,body,source_refs_json FROM knowledge_wiki_pages LIMIT ?", ["title", "body", "source_refs_json"]);
  scanRows("knowledge_wiki_page_revisions", "wiki", "SELECT title,body,change_reason FROM knowledge_wiki_page_revisions LIMIT ?", ["title", "body", "change_reason"]);
  scanRows("knowledge_audit", "audit", "SELECT details_json FROM knowledge_audit LIMIT ?", ["details_json"]);
  const securityScan = { ok: findings.size === 0, findings: [...findings].sort() };
  if (!securityScan.ok) failures.push("raw secret-like values persisted in knowledge tables");

  // ---- outbox ----------------------------------------------------------------------
  const outboxBacklog = countIf("knowledge_outbox", "SELECT COUNT(*) AS count FROM knowledge_outbox WHERE consumed_at IS NULL");
  const outboxPendingClaims = countIf("knowledge_outbox_claims", "SELECT COUNT(*) AS count FROM knowledge_outbox_claims WHERE consumed_at IS NULL");
  const outboxDeadLetter = countIf("knowledge_migration_dead_letter", "SELECT COUNT(*) AS count FROM knowledge_migration_dead_letter");

  const wikiRevisions = countIf("knowledge_wiki_page_revisions", "SELECT COUNT(*) AS count FROM knowledge_wiki_page_revisions");
  const wikiRollbacks = countIf("knowledge_audit", "SELECT COUNT(*) AS count FROM knowledge_audit WHERE action='wiki.rollback'");

  return {
    ready: failures.length === 0,
    checkedAt: now.toISOString(),
    failures,
    checks: {
      database,
      migrations: { ok: migrations.ok, created: migrations.created, staged: migrations.staged, published: migrations.published, failed: migrations.failed, rolledBack: migrations.rolledBack },
      providers: { ok: providers.ok, configured: providers.configured, ready: providers.ready, degraded: providers.degraded, disabled: providers.disabled, pendingReindex: providers.pendingReindex },
      reindex: { ok: reindex.ok, required: reindex.required, pendingJobs: reindex.pendingJobs, runningJobs: reindex.runningJobs, completedJobs: reindex.completedJobs, failedJobs: reindex.failedJobs },
      acl,
      publishedVisibility,
      wiki,
      candidateEvidence,
      contextMetrics,
      importMetrics,
      securityScan,
      rollback,
    },
    metrics: {
      sessions: {
        total: sessionTotal,
        open: sessionCounts.get("open") ?? 0,
        active: sessionCounts.get("active") ?? 0,
        awaitingReview: sessionCounts.get("awaiting_review") ?? 0,
        needsClarification: sessionCounts.get("needs_clarification") ?? 0,
        completed: sessionCounts.get("completed") ?? 0,
        abandoned: sessionCounts.get("abandoned") ?? 0,
      },
      events: { total: eventsTotal, correlated: correlatedEvents, uncorrelated: uncorrelatedEvents },
      candidates: {
        total: candidateTotal,
        draft: candidateCounts.get("draft") ?? 0,
        accepted: candidateCounts.get("accepted") ?? 0,
        edited: candidateCounts.get("edited") ?? 0,
        rejected: candidateCounts.get("rejected") ?? 0,
        fallback: candidateFallback,
        withEvidence: candidateWithEvidence,
        withoutEvidence: candidateWithoutEvidence,
        unresolvedEvidence: candidateUnresolvedEvidence,
        jobsQueued: candidateJobCounts.get("queued") ?? 0,
        jobsDone: candidateJobCounts.get("done") ?? 0,
        jobsFailed: candidateJobCounts.get("failed") ?? 0,
        fallbackReasons: candidateFallbackReasons,
      },
      providers: {
        total: providerTotal,
        ready: providers.ready,
        degraded: providers.degraded,
        disabled: providers.disabled,
        pendingReindex: providers.pendingReindex,
        errorClasses: providerErrorClasses,
      },
      imports: {
        ingest: {
          total: ingestTotal,
          queued: ingestCounts.get("queued") ?? 0,
          running: ingestCounts.get("running") ?? 0,
          succeeded: ingestCounts.get("succeeded") ?? 0,
          failed: ingestFailed,
          retried: ingestRetried,
          avgDurationMs: ingestAvgDurationMs,
        },
        weknora: {
          staged: weknoraCounts.get("staged") ?? 0,
          published: weknoraCounts.get("published") ?? 0,
          deprecated: weknoraCounts.get("deprecated") ?? 0,
          failed: weknoraCounts.get("failed") ?? 0,
        },
      },
      wiki: {
        total: (wikiCounts.get("draft") ?? 0) + (wikiCounts.get("published") ?? 0) + (wikiCounts.get("deprecated") ?? 0),
        draft: wikiCounts.get("draft") ?? 0,
        published: wikiCounts.get("published") ?? 0,
        deprecated: wikiCounts.get("deprecated") ?? 0,
        revisions: wikiRevisions,
        withSourceRefs: wikiWithSourceRefs,
        publishedWithSourceRefs: wikiPublishedWithSourceRefs,
        rollbacks: wikiRollbacks,
      },
      outbox: { backlog: outboxBacklog, pendingClaims: outboxPendingClaims, deadLetter: outboxDeadLetter },
    },
  };
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, EvidenceInput } from "./domain.js";
import type { KnowledgeStore } from "./store.js";

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|sql)|.*(?:json|xml|sql|log))/i;
const SENSITIVE_ASSIGNMENT = /((?:bearer\s+|(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|connection[-_ ]?string)\s*[:=]\s*["']?))([^\s"'&,;\]\}]+)/gi;
const URI_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi;
const SENSITIVE_XML = /(<(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|connection[-_ ]?string)\b[^>]*>)([^<]*)(<\/[^>]+>)/gi;

function redactText(text: string): string {
  return text.replace(URI_CREDENTIAL, "$1[REDACTED]$3").replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]").replace(SENSITIVE_XML, "$1[REDACTED]$3");
}
function sanitise(input: EvidenceInput): Buffer {
  return TEXT_MIME.test(input.mimeType) ? Buffer.from(redactText(input.content.toString("utf8")), "utf8") : Buffer.from(input.content);
}

type EvidenceRow = {
  id: string; sha256: string; storage_path: string; mime_type: string;
  size_bytes: number; source_kind: EvidenceInput["sourceKind"]; project_id: string | null;
  environment?: string | null;
  source_locator: string; retention: NonNullable<EvidenceInput["retention"]>;
  created_at: string; deleted_at: string | null;
};
export interface EvidenceCleanupOptions { retentionMs?: number; now?: Date; actorId?: number; environment?: string; mode?: "manual" | "automatic"; }
export interface EvidenceCleanupResult { scanned: number; deleted: number; bytesFreed: number; skippedHeld: number; errors: Array<{ evidenceId: string; error: string }>; }

export class EvidenceStore {
  constructor(private readonly store: KnowledgeStore, private readonly root: string) { mkdirSync(root, { recursive: true }); }
  private row(evidenceId: string, includeDeleted = false): EvidenceRow | undefined {
    const suffix = includeDeleted ? "" : " AND deleted_at IS NULL";
    return this.store.db.prepare(`SELECT id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,environment,source_locator,retention,created_at,deleted_at FROM knowledge_evidence WHERE id = ?${suffix}`).get(evidenceId) as EvidenceRow | undefined;
  }
  private projectIds(row: EvidenceRow): string[] {
    const acl = this.store.db.prepare("SELECT project_id FROM knowledge_evidence_acl WHERE evidence_id = ?").all(row.id) as Array<{ project_id: string }>;
    return [...new Set([...(row.project_id ? [row.project_id] : []), ...acl.map((item) => item.project_id)])];
  }
  private authorise(userId: number, row: EvidenceRow): string | undefined { return this.projectIds(row).find((projectId) => this.store.canRead(userId, projectId)); }
  private asEvidence(row: EvidenceRow): Evidence {
    return { id: row.id, sha256: row.sha256, storagePath: row.storage_path, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), sourceKind: row.source_kind, projectId: row.project_id ?? undefined, environment: row.environment ?? undefined, locator: row.source_locator, retention: row.retention, createdAt: row.created_at, deletedAt: row.deleted_at ?? undefined };
  }

  put(input: EvidenceInput): Evidence {
    const content = sanitise(input); const sha256 = createHash("sha256").update(content).digest("hex"); const now = new Date().toISOString(); const path = join(this.root, sha256);
    const existing = this.store.db.prepare("SELECT id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,environment,source_locator,retention,created_at,deleted_at FROM knowledge_evidence WHERE sha256 = ?").get(sha256) as EvidenceRow | undefined;
    if (existing) {
      if (!existsSync(path)) writeFileSync(path, content, { flag: "wx" });
      this.store.db.transaction(() => {
        if (existing.deleted_at || existing.storage_path !== path) this.store.db.prepare("UPDATE knowledge_evidence SET deleted_at = NULL, storage_path = ? WHERE id = ?").run(path, existing.id);
        if (input.projectId) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(existing.id, input.projectId, now);
        if (input.retention && input.retention !== "standard" && existing.retention === "standard") this.store.db.prepare("UPDATE knowledge_evidence SET retention = ? WHERE id = ?").run(input.retention, existing.id);
      })();
      const current = this.row(existing.id, true)!;
      this.store.audit({ projectId: input.projectId, action: "evidence.deduplicated", entityType: "evidence", entityId: existing.id, details: { sha256, projectId: input.projectId, sizeBytes: content.length } });
      return this.asEvidence(current);
    }
    if (!existsSync(path)) writeFileSync(path, content, { flag: "wx" });
    const record: EvidenceRow = { id: `evidence-${randomUUID()}`, sha256, storage_path: path, mime_type: input.mimeType, size_bytes: content.length, source_kind: input.sourceKind, project_id: input.projectId ?? null, environment: input.environment ?? null, source_locator: input.locator, retention: input.retention ?? "standard", created_at: now, deleted_at: null };
    this.store.db.transaction(() => {
      this.store.db.prepare("INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,environment,source_locator,retention,created_at) VALUES (@id,@sha256,@storage_path,@mime_type,@size_bytes,@source_kind,@project_id,@environment,@source_locator,@retention,@created_at)").run(record);
      if (record.project_id) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(record.id, record.project_id, now);
    })();
    this.store.audit({ projectId: input.projectId, action: "evidence.created", entityType: "evidence", entityId: record.id, details: { sha256, mimeType: input.mimeType, sizeBytes: content.length, retention: record.retention } });
    return this.asEvidence(record);
  }

  metadata(userId: number, evidenceId: string): Evidence {
    const row = this.row(evidenceId); const projectId = row && this.authorise(userId, row);
    if (!row || !projectId) { this.store.audit({ actorId: userId, action: "evidence.metadata_denied", entityType: "evidence", entityId: evidenceId }); throw new Error("Evidence access denied"); }
    this.store.audit({ actorId: userId, projectId, action: "evidence.metadata", entityType: "evidence", entityId: evidenceId }); return this.asEvidence(row);
  }
  getMetadata(userId: number, evidenceId: string): Evidence { return this.metadata(userId, evidenceId); }
  readMetadata(userId: number, evidenceId: string): Evidence { return this.metadata(userId, evidenceId); }
  read(userId: number, evidenceId: string): Buffer { return this.readWithAction(userId, evidenceId, "evidence.read"); }
  download(userId: number, evidenceId: string, maxBytes = 100 * 1024 * 1024): Buffer {
    const row = this.row(evidenceId);
    const projectId = row && this.authorise(userId, row);
    if (!row || !projectId) {
      this.store.audit({ actorId: userId, action: "evidence.read_denied", entityType: "evidence", entityId: evidenceId });
      throw new Error("Evidence access denied");
    }
    if (Number(row.size_bytes) > Math.max(0, maxBytes)) {
      this.store.audit({ actorId: userId, projectId, action: "evidence.download_denied", entityType: "evidence", entityId: evidenceId, details: { reason: "size_limit", sizeBytes: row.size_bytes, maxBytes } });
      throw new Error("Evidence exceeds download limit");
    }
    return this.readWithAction(userId, evidenceId, "evidence.download");
  }
  private readWithAction(userId: number, evidenceId: string, action: string): Buffer {
    const row = this.row(evidenceId); const projectId = row && this.authorise(userId, row);
    if (!row || !projectId) { this.store.audit({ actorId: userId, action: "evidence.read_denied", entityType: "evidence", entityId: evidenceId }); throw new Error("Evidence access denied"); }
    if (!existsSync(row.storage_path)) throw new Error("Evidence content is unavailable");
    const content = readFileSync(row.storage_path); this.store.audit({ actorId: userId, projectId, action, entityType: "evidence", entityId: evidenceId, details: { sizeBytes: content.length, sha256: row.sha256 } }); return content;
  }

  purge(evidenceId: string, actorId: number): void {
    const row = this.row(evidenceId, true);
    if (!row) { this.store.audit({ actorId, action: "evidence.purge_denied", entityType: "evidence", entityId: evidenceId, details: { reason: "not_found" } }); throw new Error("Evidence not found"); }
    const projectIds = this.projectIds(row); const reviewable = projectIds.some((projectId) => (this.store.db.prepare("SELECT can_review FROM knowledge_acl WHERE project_id = ? AND user_id = ?").get(projectId, actorId) as { can_review?: number } | undefined)?.can_review === 1 && this.store.canRead(actorId, projectId));
    if (!reviewable) { this.store.audit({ actorId, projectId: row.project_id ?? undefined, action: "evidence.purge_denied", entityType: "evidence", entityId: evidenceId, details: { reason: "reviewer_permission" } }); throw new Error("Evidence deletion requires reviewer permission"); }
    if (row.retention !== "standard") { this.store.audit({ actorId, projectId: row.project_id ?? undefined, action: "evidence.purge_blocked", entityType: "evidence", entityId: evidenceId, details: { retention: row.retention } }); throw new Error("Evidence under legal or GMP hold cannot be deleted"); }
    if (row.deleted_at) return;
    this.store.db.transaction(() => { this.store.db.prepare("UPDATE knowledge_evidence SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), evidenceId); this.store.audit({ actorId, projectId: row.project_id ?? undefined, action: "evidence.purge_committed", entityType: "evidence", entityId: evidenceId }); })();
    try { if (existsSync(row.storage_path)) unlinkSync(row.storage_path); } catch (error) {
      this.store.db.transaction(() => { this.store.db.prepare("UPDATE knowledge_evidence SET deleted_at = NULL WHERE id = ?").run(evidenceId); this.store.audit({ actorId, projectId: row.project_id ?? undefined, action: "evidence.purge_reverted", entityType: "evidence", entityId: evidenceId, details: { error: error instanceof Error ? error.message : String(error) } }); })(); throw error;
    }
  }

  cleanup(options: EvidenceCleanupOptions = {}): EvidenceCleanupResult {
    const environment = options.environment?.trim().toLowerCase();
    if (options.mode === "automatic" && (environment === "production" || environment === "prod" || environment === "gmp" || environment === "regulated")) {
      const blocked: EvidenceCleanupResult = { scanned: 0, deleted: 0, bytesFreed: 0, skippedHeld: 0, errors: [{ evidenceId: "*", error: "Automatic Evidence deletion is disabled for production/GMP environments" }] };
      this.store.audit({ actorId: options.actorId, action: "evidence.retention_cleanup_blocked", entityType: "evidence_store", entityId: "retention", details: { environment, mode: options.mode } });
      return blocked;
    }
    const now = options.now ?? new Date(); const retentionMs = Math.max(0, options.retentionMs ?? 30 * 24 * 60 * 60 * 1000); const cutoff = new Date(now.getTime() - retentionMs).toISOString();
    const rows = this.store.db.prepare("SELECT id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,environment,source_locator,retention,created_at,deleted_at FROM knowledge_evidence WHERE deleted_at IS NULL AND created_at <= ?").all(cutoff) as EvidenceRow[];
    const result: EvidenceCleanupResult = { scanned: rows.length, deleted: 0, bytesFreed: 0, skippedHeld: 0, errors: [] };
    for (const row of rows) {
      if (row.retention !== "standard") {
        result.skippedHeld++;
        this.store.audit({ actorId: options.actorId, projectId: row.project_id ?? undefined, action: "evidence.retention_skipped", entityType: "evidence", entityId: row.id, details: { retention: row.retention } });
        continue;
      }
      try { this.store.db.transaction(() => { this.store.db.prepare("UPDATE knowledge_evidence SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now.toISOString(), row.id); this.store.audit({ actorId: options.actorId, projectId: row.project_id ?? undefined, action: "evidence.retention_cleanup", entityType: "evidence", entityId: row.id, details: { sha256: row.sha256, sizeBytes: row.size_bytes, retentionMs } }); })(); if (existsSync(row.storage_path)) unlinkSync(row.storage_path); result.deleted++; result.bytesFreed += Number(row.size_bytes); }
      catch (error) { result.errors.push({ evidenceId: row.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    this.store.audit({ actorId: options.actorId, action: "evidence.retention_cleanup_completed", entityType: "evidence_store", entityId: "retention", details: { ...result, errors: result.errors } }); return result;
  }
  prune(options: EvidenceCleanupOptions = {}): EvidenceCleanupResult { return this.cleanup(options); }
  cleanupExpired(options: EvidenceCleanupOptions = {}): EvidenceCleanupResult { return this.cleanup(options); }
  verify(evidenceId: string): { ok: boolean; reason?: string } {
    const row = this.row(evidenceId, true); if (!row) return { ok: false, reason: "not_found" }; if (!existsSync(row.storage_path)) return { ok: false, reason: "missing_content" }; if (statSync(row.storage_path).size !== Number(row.size_bytes)) return { ok: false, reason: "size_mismatch" }; const hash = createHash("sha256").update(readFileSync(row.storage_path)).digest("hex"); return hash === row.sha256 ? { ok: true } : { ok: false, reason: "hash_mismatch" };
  }
}

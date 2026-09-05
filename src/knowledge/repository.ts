import { randomUUID } from "node:crypto";
import type { Case, Candidate, Evidence, Fact, Feedback, Pattern, Playbook, Relation, Review, KnowledgeAcl, KnowledgeKind } from "./domain.js";
import type { KnowledgeStore } from "./store.js";

/** Repository facade for type-specific Knowledge projections. */
export class KnowledgeRepository {
  constructor(private readonly store: KnowledgeStore) {}

  saveCase(value: Case): Case {
    this.store.upsertDocument(value);
    this.store.db.prepare(`INSERT INTO knowledge_cases
      (id,status,customer_case_id,deployment_id,job_id,event_id,source_candidate_id,version,samplemanager_version,solution,module,environment,symptoms,root_cause,fix,verification,applicability,created_by,reviewed_by,verified_at,expires_at,confidence,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
      VALUES (@id,@status,@customerCaseId,@deploymentId,@jobId,@eventId,@sourceCandidateId,@version,@sampleManagerVersion,@solution,@module,@environment,@symptoms,@rootCause,@fix,@verification,@applicability,@createdBy,@reviewedBy,@verifiedAt,@expiresAt,@confidence,@evidenceRefs,@sourceLocator,@sourceSha256,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,customer_case_id=excluded.customer_case_id,deployment_id=excluded.deployment_id,job_id=excluded.job_id,event_id=excluded.event_id,source_candidate_id=excluded.source_candidate_id,version=excluded.version,samplemanager_version=excluded.samplemanager_version,solution=excluded.solution,module=excluded.module,environment=excluded.environment,symptoms=excluded.symptoms,root_cause=excluded.root_cause,fix=excluded.fix,verification=excluded.verification,applicability=excluded.applicability,created_by=excluded.created_by,reviewed_by=excluded.reviewed_by,verified_at=excluded.verified_at,expires_at=excluded.expires_at,confidence=excluded.confidence,evidence_refs_json=excluded.evidence_refs_json,source_locator=excluded.source_locator,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at`).run({
      id: value.id, status: value.lifecycle, customerCaseId: value.customerCaseId ?? null, deploymentId: value.deploymentId ?? null, jobId: value.jobId ?? null,
      eventId: value.eventId ?? null, sourceCandidateId: value.sourceCandidateId ?? null,
      version: value.version ?? "1", sampleManagerVersion: value.sampleManagerVersion ?? null, solution: value.solution ?? null, module: value.module ?? null, environment: value.environment ?? null, symptoms: value.symptoms ?? null, rootCause: value.rootCause ?? null, fix: value.fix ?? null,
      verification: value.verification ?? null, applicability: value.applicability ?? null, createdBy: value.createdBy ?? null,
      reviewedBy: value.reviewedBy ?? null, verifiedAt: value.verifiedAt ?? null, expiresAt: value.expiresAt ?? null,
      confidence: value.confidence ?? null, evidenceRefs: JSON.stringify(value.evidenceRefs ?? []), sourceLocator: value.locator,
      sourceSha256: value.sha256 ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt,
    });
    return value;
  }

  savePattern(value: Pattern): Pattern {
    this.store.upsertDocument(value);
    this.store.db.prepare(`INSERT INTO knowledge_patterns
      (id,status,version,samplemanager_version,solution,module,environment,applicability,case_refs_json,created_by,reviewed_by,verified_at,expires_at,confidence,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
      VALUES (@id,@status,@version,@sampleManagerVersion,@solution,@module,@environment,@applicability,@caseRefs,@createdBy,@reviewedBy,@verifiedAt,@expiresAt,@confidence,@evidenceRefs,@sourceLocator,@sourceSha256,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,samplemanager_version=excluded.samplemanager_version,solution=excluded.solution,module=excluded.module,environment=excluded.environment,applicability=excluded.applicability,case_refs_json=excluded.case_refs_json,created_by=excluded.created_by,reviewed_by=excluded.reviewed_by,verified_at=excluded.verified_at,expires_at=excluded.expires_at,confidence=excluded.confidence,evidence_refs_json=excluded.evidence_refs_json,source_locator=excluded.source_locator,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at`).run({
      id: value.id, status: value.lifecycle, version: value.version ?? "1", sampleManagerVersion: value.sampleManagerVersion ?? null, solution: value.solution ?? null, module: value.module ?? null, environment: value.environment ?? null, applicability: value.applicability ?? null,
      caseRefs: JSON.stringify(value.caseRefs ?? []), createdBy: value.createdBy ?? null, reviewedBy: value.reviewedBy ?? null,
      verifiedAt: value.verifiedAt ?? null, expiresAt: value.expiresAt ?? null, confidence: value.confidence ?? null,
      evidenceRefs: JSON.stringify(value.evidenceRefs ?? []), sourceLocator: value.locator, sourceSha256: value.sha256 ?? null,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    });
    return value;
  }

  savePlaybook(value: Playbook): Playbook {
    this.store.upsertDocument(value);
    this.store.db.prepare(`INSERT INTO knowledge_playbooks
      (id,status,version,samplemanager_version,solution,module,environment,steps_json,rollback,skill_diff,created_by,reviewed_by,verified_at,expires_at,confidence,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
      VALUES (@id,@status,@version,@sampleManagerVersion,@solution,@module,@environment,@steps,@rollback,@skillDiff,@createdBy,@reviewedBy,@verifiedAt,@expiresAt,@confidence,@evidenceRefs,@sourceLocator,@sourceSha256,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,version=excluded.version,samplemanager_version=excluded.samplemanager_version,solution=excluded.solution,module=excluded.module,environment=excluded.environment,steps_json=excluded.steps_json,rollback=excluded.rollback,skill_diff=excluded.skill_diff,created_by=excluded.created_by,reviewed_by=excluded.reviewed_by,verified_at=excluded.verified_at,expires_at=excluded.expires_at,confidence=excluded.confidence,evidence_refs_json=excluded.evidence_refs_json,source_locator=excluded.source_locator,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at`).run({
      id: value.id, status: value.lifecycle, version: value.version ?? "1", sampleManagerVersion: value.sampleManagerVersion ?? null, solution: value.solution ?? null, module: value.module ?? null, environment: value.environment ?? null, steps: JSON.stringify(value.steps ?? []), rollback: value.rollback ?? null,
      skillDiff: value.skillDiff ?? null, createdBy: value.createdBy ?? null, reviewedBy: value.reviewedBy ?? null,
      verifiedAt: value.verifiedAt ?? null, expiresAt: value.expiresAt ?? null, confidence: value.confidence ?? null,
      evidenceRefs: JSON.stringify(value.evidenceRefs ?? []), sourceLocator: value.locator, sourceSha256: value.sha256 ?? null,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    });
    return value;
  }

  saveCandidate(value: Candidate): Candidate {
    this.store.upsertDocument(value);
    this.store.db.prepare(`INSERT INTO knowledge_candidates
      (id,status,candidate_type,samplemanager_version,solution,module,environment,event_id,deployment_id,job_id,evidence_refs_json,source_locator,source_sha256,created_at,updated_at)
      VALUES (@id,@status,@candidateType,@sampleManagerVersion,@solution,@module,@environment,@eventId,@deploymentId,@jobId,@evidenceRefs,@sourceLocator,@sourceSha256,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,candidate_type=excluded.candidate_type,samplemanager_version=excluded.samplemanager_version,solution=excluded.solution,module=excluded.module,environment=excluded.environment,event_id=excluded.event_id,deployment_id=excluded.deployment_id,job_id=excluded.job_id,evidence_refs_json=excluded.evidence_refs_json,source_locator=excluded.source_locator,source_sha256=excluded.source_sha256,updated_at=excluded.updated_at`).run({
      id: value.id, status: value.lifecycle, candidateType: value.candidateType ?? "case", sampleManagerVersion: value.sampleManagerVersion ?? null, solution: value.solution ?? null, module: value.module ?? null, environment: value.environment ?? null, eventId: value.eventId ?? null,
      deploymentId: value.deploymentId ?? null, jobId: value.jobId ?? null, evidenceRefs: JSON.stringify(value.evidenceRefs ?? []),
      sourceLocator: value.locator, sourceSha256: value.sha256 ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt,
    });
    if (value.card) this.store.saveCandidateCard(value.card);
    return value;
  }

  saveFact(value: Fact): Fact {
    this.store.db.prepare(`INSERT INTO knowledge_facts(id,user_id,project_id,project_name_snapshot,text,tags_json,source_locator,status,created_at)
      VALUES (@id,@userId,@projectId,@projectNameSnapshot,@text,@tags,@sourceLocator,@status,@createdAt)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,project_id=excluded.project_id,project_name_snapshot=excluded.project_name_snapshot,text=excluded.text,tags_json=excluded.tags_json,source_locator=excluded.source_locator,status=excluded.status`).run({
      id: value.id, userId: value.userId, projectId: value.projectId ?? null, projectNameSnapshot: value.projectNameSnapshot ?? null,
      text: value.text, tags: JSON.stringify(value.tags), sourceLocator: value.locator, status: value.status, createdAt: value.createdAt,
    });
    return value;
  }

  saveEvidence(value: Evidence): Evidence {
    const existingById = this.store.db.prepare("SELECT id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at,deleted_at FROM knowledge_evidence WHERE id = ?").get(value.id) as Record<string, unknown> | undefined;
    if (existingById) {
      const immutableMatches = String(existingById.sha256) === value.sha256
        && String(existingById.storage_path) === value.storagePath
        && String(existingById.mime_type) === value.mimeType
        && Number(existingById.size_bytes) === value.sizeBytes
        && String(existingById.source_kind) === value.sourceKind;
      if (!immutableMatches) throw new Error("Evidence content and immutable metadata cannot be changed");
      if (value.projectId) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(value.id, value.projectId, value.createdAt);
      return value;
    }
    const existing = this.store.db.prepare("SELECT id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at,deleted_at FROM knowledge_evidence WHERE sha256 = ?").get(value.sha256) as Record<string, unknown> | undefined;
    if (existing && String(existing.id) !== value.id) {
      if (value.projectId) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(existing.id, value.projectId, value.createdAt);
      if (value.retention !== "standard" && String(existing.retention) === "standard") this.store.db.prepare("UPDATE knowledge_evidence SET retention = ? WHERE id = ?").run(value.retention, existing.id);
      const retention = value.retention !== "standard" && String(existing.retention) === "standard" ? value.retention : existing.retention as Evidence["retention"];
      return { ...value, id: String(existing.id), storagePath: String(existing.storage_path), mimeType: String(existing.mime_type), sizeBytes: Number(existing.size_bytes), sourceKind: existing.source_kind as Evidence["sourceKind"], retention, deletedAt: existing.deleted_at ? String(existing.deleted_at) : undefined };
    }
    this.store.db.prepare(`INSERT INTO knowledge_evidence(id,sha256,storage_path,mime_type,size_bytes,source_kind,project_id,source_locator,retention,created_at,deleted_at)
      VALUES (@id,@sha256,@storagePath,@mimeType,@sizeBytes,@sourceKind,@projectId,@locator,@retention,@createdAt,@deletedAt)`).run({
      id: value.id, sha256: value.sha256, storagePath: value.storagePath, mimeType: value.mimeType, sizeBytes: value.sizeBytes, sourceKind: value.sourceKind, projectId: value.projectId ?? null, locator: value.locator, retention: value.retention, createdAt: value.createdAt, deletedAt: value.deletedAt ?? null,
    });
    if (value.projectId) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(value.id, value.projectId, value.createdAt);
    return value;
  }

  saveRelation(value: Relation): Relation {
    if (!value.projectId) throw new Error("Relation projectId is required");
    const endpoints = this.store.db.prepare("SELECT id,project_id FROM knowledge_documents WHERE id IN (?,?)").all(value.from, value.to) as Array<{ id: string; project_id?: string }>;
    if (endpoints.length !== 2 || endpoints.some((endpoint) => endpoint.project_id !== value.projectId)) {
      throw new Error("Relation endpoints must exist in the relation project scope");
    }
    this.store.db.prepare(`INSERT OR REPLACE INTO knowledge_relations(id,from_document_id,to_document_id,relation_type,source_locator,confidence,verified,extraction_version,created_at,project_id,samplemanager_version,solution,module,environment,source_sha256)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(value.id, value.from, value.to, value.relationType, value.locator, value.confidence, value.verified ? 1 : 0, value.extractionVersion, value.createdAt, value.projectId, value.sampleManagerVersion ?? null, value.solution ?? null, value.module ?? null, value.environment ?? null, value.sha256 ?? null);
    return value;
  }

  saveReview(value: Review): Review {
    const documentId = this.store.db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(value.entityId) ? value.entityId : null;
    this.store.db.prepare("INSERT INTO knowledge_reviews(id,document_id,entity_type,entity_id,reviewer_id,action,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(value.id, documentId, value.entityType, value.entityId, value.reviewerId, value.action, value.reason, JSON.stringify(value.before), JSON.stringify(value.after), value.createdAt);
    return value;
  }

  grantAcl(value: KnowledgeAcl): KnowledgeAcl {
    this.store.db.prepare("INSERT INTO knowledge_acl(project_id,user_id,can_read,can_review) VALUES (?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET can_read=excluded.can_read,can_review=excluded.can_review").run(value.projectId, value.userId, value.canRead ? 1 : 0, value.canReview ? 1 : 0);
    return value;
  }

  attachEvidence(entityType: KnowledgeKind, entityId: string, evidenceId: string): void {
    const entity = this.store.db.prepare("SELECT id,kind,project_id FROM knowledge_documents WHERE id = ?").get(entityId) as { id?: string; kind?: string; project_id?: string } | undefined;
    if (!entity || entity.kind !== entityType) throw new Error("Knowledge entity not found or kind mismatch");
    const evidence = this.store.db.prepare("SELECT id,project_id FROM knowledge_evidence WHERE id = ? AND deleted_at IS NULL").get(evidenceId) as { id?: string; project_id?: string } | undefined;
    if (!evidence) throw new Error("Knowledge evidence not found");
    this.store.db.prepare("INSERT OR IGNORE INTO knowledge_entity_evidence(entity_type,entity_id,evidence_id,created_at) VALUES (?,?,?,?)")
      .run(entityType, entityId, evidenceId, new Date().toISOString());
    if (entity.project_id) this.store.db.prepare("INSERT OR IGNORE INTO knowledge_evidence_acl(evidence_id,project_id,created_at) VALUES (?,?,?)").run(evidenceId, entity.project_id, new Date().toISOString());
  }

  recordFeedback(value: Omit<Feedback, "id" | "createdAt"> & { id?: string; createdAt?: string }): Feedback {
    const result: Feedback = { ...value, id: value.id ?? `feedback-${randomUUID()}`, createdAt: value.createdAt ?? new Date().toISOString() };
    const document = this.store.db.prepare("SELECT id FROM knowledge_documents WHERE id = ?").get(result.entityId);
    if (!document) throw new Error("Feedback entity must reference a Knowledge document");
    this.store.db.prepare("INSERT INTO knowledge_feedback(id,document_id,entity_id,user_id,helpful,comment,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(result.id, result.entityId, result.entityId, result.userId, result.helpful === undefined ? null : result.helpful ? 1 : 0, result.comment ?? null, result.createdAt);
    return result;
  }
}

/** Application-layer name retained as a stable import for API/MCP adapters. */
export class KnowledgeApplicationService extends KnowledgeRepository {}

export function createKnowledgeRepository(store: KnowledgeStore): KnowledgeRepository {
  return new KnowledgeRepository(store);
}

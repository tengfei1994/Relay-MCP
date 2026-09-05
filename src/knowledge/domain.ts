/** States shared by every promotable knowledge object. */
export const KNOWLEDGE_LIFECYCLE = ["draft", "reproduced", "verified", "approved", "deprecated"] as const;
export type KnowledgeLifecycle = typeof KNOWLEDGE_LIFECYCLE[number];
export type KnowledgeKind = "candidate" | "case" | "pattern" | "playbook" | "product_document" | "fact" | "evidence" | "relation";

const transitions: Record<KnowledgeLifecycle, readonly KnowledgeLifecycle[]> = {
  draft: ["reproduced", "deprecated"],
  reproduced: ["verified", "deprecated"],
  verified: ["approved", "deprecated"],
  approved: ["deprecated"],
  deprecated: [],
};

export const KNOWLEDGE_LIFECYCLE_TRANSITIONS: Readonly<Record<KnowledgeLifecycle, readonly KnowledgeLifecycle[]>> = transitions;

export function canTransitionLifecycle(from: KnowledgeLifecycle, to: KnowledgeLifecycle): boolean {
  return from === to || (transitions[from]?.includes(to) ?? false);
}

export function assertLifecycleTransition(from: KnowledgeLifecycle, to: KnowledgeLifecycle): void {
  if (!canTransitionLifecycle(from, to)) throw new Error(`Invalid knowledge lifecycle transition: ${from} -> ${to}`);
}

export interface KnowledgeScope {
  projectId?: string;
  projectNameSnapshot?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  environment?: string;
  scopeType?: KnowledgeScopeType;
  scopeKey?: string;
  visibility?: KnowledgeVisibility;
  sourceProjectId?: string;
  sourceCaseId?: string;
  sourceDeploymentId?: string;
  redactionStatus?: KnowledgeRedactionStatus;
}

export type KnowledgeScopeType = "system" | "version" | "solution" | "module" | "organization" | "project" | "environment";
export type KnowledgeVisibility = "private" | "project" | "organization" | "global";
export type KnowledgeRedactionStatus = "unknown" | "unredacted" | "redacted";

export interface KnowledgeSource {
  locator: string;
  commit?: string;
  sha256?: string;
}

export interface KnowledgeDocument extends KnowledgeScope, KnowledgeSource {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  lifecycle: KnowledgeLifecycle;
  createdAt: string;
  updatedAt: string;
}

/** Common provenance and review fields used by Case/Pattern/Playbook records. */
export interface KnowledgeEntity extends KnowledgeScope, KnowledgeSource {
  id: string;
  title: string;
  body: string;
  lifecycle: KnowledgeLifecycle;
  version?: string;
  createdBy?: number;
  reviewedBy?: number;
  verifiedAt?: string;
  expiresAt?: string;
  confidence?: number;
  evidenceRefs?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Case extends KnowledgeEntity {
  kind: "case";
  sourceCandidateId?: string;
  eventId?: string;
  symptoms?: string;
  rootCause?: string;
  fix?: string;
  verification?: string;
  applicability?: string;
  customerCaseId?: string;
  deploymentId?: string;
  jobId?: string;
}

export interface Pattern extends KnowledgeEntity {
  kind: "pattern";
  applicability?: string;
  caseRefs?: string[];
}

export interface Playbook extends KnowledgeEntity {
  kind: "playbook";
  steps?: string[];
  rollback?: string;
  skillDiff?: string;
}

export interface Candidate extends KnowledgeEntity {
  kind: "candidate";
  candidateType?: "case" | "pattern" | "playbook";
  eventId?: string;
  deploymentId?: string;
  jobId?: string;
  card?: CandidateCard;
}

export interface CandidateCard {
  candidateId: string;
  summary: string;
  problemStatement: string;
  facts: Array<Record<string, unknown>>;
  symptoms: string[];
  hypothesis: string;
  verificationPlan: string[];
  verifiedConclusion?: string;
  actions: string[];
  verification: string[];
  applicability?: string;
  tags: string[];
  confidence?: number;
  generatedBy: string;
  inferenceStatus: "deterministic" | "provider" | "rejected";
  eventClass?: string;
  captureReason?: string;
  impact?: string;
  updatedAt: string;
}

export interface KnowledgeScopeBinding {
  id: string;
  documentId: string;
  scopeType: KnowledgeScopeType;
  scopeKey: string;
  visibility: KnowledgeVisibility;
  sourceProjectId?: string;
  sourceCaseId?: string;
  sourceDeploymentId?: string;
  redactionStatus: KnowledgeRedactionStatus;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export type FactStatus = "resolved" | "unresolved";
export interface Fact extends KnowledgeScope, KnowledgeSource {
  id: string;
  userId: number;
  text: string;
  tags: string[];
  status: FactStatus;
  createdAt: string;
}

export interface Evidence extends KnowledgeScope {
  id: string;
  sha256: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  sourceKind: EvidenceInput["sourceKind"];
  locator: string;
  retention: NonNullable<EvidenceInput["retention"]>;
  createdAt: string;
  deletedAt?: string;
}

export type RelationType = string;
export interface Relation extends KnowledgeScope {
  id: string;
  from: string;
  to: string;
  relationType: RelationType;
  locator: string;
  sha256?: string;
  confidence: number;
  verified: boolean;
  extractionVersion: string;
  createdAt: string;
}

export interface Review {
  id: string;
  entityType: KnowledgeKind;
  entityId: string;
  reviewerId: number;
  action: string;
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface Feedback {
  id: string;
  entityId: string;
  userId: number;
  helpful?: boolean;
  comment?: string;
  createdAt: string;
}

export interface KnowledgeAcl {
  projectId: string;
  userId: number;
  canRead: boolean;
  canReview: boolean;
}

export interface EvidenceInput extends KnowledgeScope, KnowledgeSource {
  content: Buffer;
  mimeType: string;
  sourceKind: "log" | "xml" | "sql" | "artifact" | "test" | "manifest" | "other";
  retention?: "standard" | "legal_hold" | "gmp_hold";
}

export function assertReviewer(canReview: boolean): void {
  if (!canReview) throw new Error("Knowledge review requires an authorized reviewer");
}

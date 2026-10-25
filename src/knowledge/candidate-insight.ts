import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { KnowledgeStore } from "./store.js";
import { WorkSessionService, type WorkSession } from "./work-session.js";
import { candidateScopeSnapshot, candidateScopeMatches, readCandidateScope, type CandidateScopeSnapshot } from "./candidate-scope.js";

export const CANDIDATE_INSIGHT_KINDS = ["fact", "pattern", "case", "playbook", "decision", "observation"] as const;
export type CandidateInsightKind = typeof CANDIDATE_INSIGHT_KINDS[number];
export type CandidateInsightStatus = "draft" | "accepted" | "edited" | "rejected";

export const FALLBACK_GENERATED_BY = "deterministic-fallback-v1";
const LEGACY_GENERATED_BY = "candidate-insight-compiler-v1";
const MANAGED_GENERATED_BY_PREFIX = "managed-candidate-llm";

export interface CandidateInsightReusableStatement {
  statement: string;
  applicability?: string;
  boundary?: string;
}

export interface CandidateInsight {
  id: string;
  workSessionId: string;
  projectId: string;
  kind: CandidateInsightKind;
  statement: string;
  whyProposed: string;
  evidenceRefs: string[];
  intentRefs: string[];
  unknowns: string[];
  reuseBoundary: Record<string, unknown>;
  scopeReviewRequired: boolean;
  sourceScope?: Pick<CandidateScopeSnapshot, "projectId" | "environment" | "sampleManagerVersion" | "solution" | "module">;
  confirmedFacts: string[];
  observedBehavior: string[];
  hypothesis?: string;
  reusableStatement?: CandidateInsightReusableStatement;
  confidence?: number;
  status: CandidateInsightStatus;
  generatedBy: string;
  fallbackReason?: string;
  inputHash: string;
  /** False when the insight was returned without persistence (no valid Evidence). */
  persisted: boolean;
  reviewedBy?: number;
  reviewedAt?: string;
  reviewReason?: string;
  promotion?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateInsightInput {
  actorId: number;
  sessionId: string;
  evidenceRefs: string[];
  context: Record<string, unknown>;
}

/** Classified failure modes of the managed Candidate Insight provider. */
export type CandidateProviderErrorKind = "timeout" | "rate_limited" | "invalid_output" | "overlong_output" | "unavailable";

export class CandidateProviderError extends Error {
  readonly code = "candidate_provider_error";
  constructor(readonly kind: CandidateProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CandidateProviderError";
  }
}

/** Map an arbitrary provider failure to a safe, audit-friendly classification. */
export function classifyCandidateProviderError(error: unknown): CandidateProviderErrorKind {
  if (error instanceof CandidateProviderError) return error.kind;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || /timed?\s?out|timeout|aborted/i.test(`${name} ${message}`)) return "timeout";
  if (/429|rate.?limit|too many requests|quota/i.test(message)) return "rate_limited";
  if (/invalid|schema|parse|json|markdown|malformed|unexpected token/i.test(message)) return "invalid_output";
  if (/overlong|too long|length|token limit|context window/i.test(message)) return "overlong_output";
  return "unavailable";
}

export interface CandidateInsightProviderRequest {
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  maxTokens?: number;
}

/**
 * Managed Candidate Insight LLM provider. The unified provider
 * registry/runtime injects an implementation; the compiler owns timeout
 * enforcement and output validation so any conforming adapter is safe.
 */
export interface ManagedCandidateInsightProvider {
  readonly providerId: string;
  readonly modelId: string;
  complete(request: CandidateInsightProviderRequest): Promise<string>;
}

/** Legacy function provider retained for backwards compatibility. */
export type InsightProvider = (prompt: string) => Promise<string>;
export type CandidateInsightProvider = ManagedCandidateInsightProvider | InsightProvider;

export interface CandidateInsightCompilerOptions {
  timeoutMs?: number;
  maxTokens?: number;
  maxOutputChars?: number;
  maxPromptChars?: number;
  evidenceExcerptChars?: number;
  maxEvidence?: number;
}

const reusableStatementSchema = z.object({
  statement: z.string().trim().min(1).max(2_000),
  applicability: z.string().trim().min(1).max(2_000).optional(),
  boundary: z.string().trim().min(1).max(2_000).optional(),
}).strict();

/** Strict output contract for the managed provider; extra keys (including hidden chain-of-thought fields) are rejected. */
export const candidateInsightOutputSchema = z.object({
  kind: z.enum(CANDIDATE_INSIGHT_KINDS),
  statement: z.string().trim().min(1).max(4_000),
  whyProposed: z.string().trim().min(1).max(4_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(300)).max(100),
  intentRefs: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  unknowns: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  reuseBoundary: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1).optional(),
  confirmedFacts: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  observedBehavior: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  hypothesis: z.string().trim().min(1).max(2_000).optional(),
  reusableStatement: reusableStatementSchema.optional(),
}).strict();

export type CandidateInsightModelOutput = z.infer<typeof candidateInsightOutputSchema>;

const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key|ssh[-_]?key|connection[-_]?string|cookie|bearer)/i;
const HIDDEN_REASONING_KEY = /^(?:hidden[-_ ]?reasoning|thought|thinking|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|reflection|internal[-_ ]?monologue|deliberation)$/i;
const SENSITIVE_VALUE = /(bearer\s+[a-z0-9._~+/=-]+|(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|connection[-_ ]?string)\s*[:=]\s*\S+|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const URI_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi;
const SENSITIVE_ASSIGNMENT = /((?:bearer\s+|(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|connection[-_ ]?string)\s*[:=]\s*["']?))([^\s"'&,;\]}]+)/gi;
const SENSITIVE_XML = /(<(?:password|passwd|pwd|token|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|connection[-_ ]?string)\b[^>]*>)([^<]*)(<\/[^>]+>)/gi;
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|sql)|.*(?:json|xml|sql|log))/i;

/** Recursively redact sensitive fields from input before it reaches any provider. */
export function redactCandidateInput(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? "[REDACTED]" : value.slice(0, 2_000);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactCandidateInput(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      // Omit private reasoning before queue persistence, idempotency hashing and provider input.
      .filter(([key]) => !HIDDEN_REASONING_KEY.test(key))
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactCandidateInput(item, depth + 1)]),
  );
}

/**
 * Recursively scan model output for credential material and hidden reasoning
 * fields. Returns a generic category (never the offending content) or undefined.
 */
export function scanCandidateContent(value: unknown, depth = 0): string | undefined {
  if (depth > 12) return "excessively nested content";
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? "sensitive credential material" : undefined;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      const hit = scanCandidateContent(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (SENSITIVE_KEY.test(key)) return "a sensitive field";
    if (HIDDEN_REASONING_KEY.test(key)) return "a hidden reasoning field";
    const hit = scanCandidateContent(item, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function redactExcerpt(text: string): string {
  return text.replace(URI_CREDENTIAL, "$1[REDACTED]$3").replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]").replace(SENSITIVE_XML, "$1[REDACTED]$3");
}

/** Canonical JSON used for idempotency hashes; key order is stable. */
export function canonicalCandidateJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalCandidateJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalCandidateJson(record[key])}`).join(",")}}`;
}

function text(value: unknown, fallback: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  return result.slice(0, 4_000) || fallback;
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value!))) : fallback;
}

export function candidateInsightFromRow(row: Record<string, unknown>, store?: KnowledgeStore): CandidateInsight {
  const reusable = parseJsonObject(row.reusable_statement_json ?? "null");
  const snapshot = readCandidateScope(row.scope_snapshot_json);
  const projection = store?.db.prepare("SELECT project_id,environment,samplemanager_version,solution,module,source_locator FROM knowledge_documents WHERE id=? AND kind='case'").get(`case-${row.id}`) as Record<string, unknown> | undefined;
  const scopeReviewRequired = !snapshot || snapshot.projectId !== row.project_id || Boolean(projection && (!candidateScopeMatches(snapshot, projection) || projection.source_locator !== `candidate-insight:${row.id}`));
  return {
    id: String(row.id), workSessionId: String(row.work_session_id), projectId: String(row.project_id),
    kind: String(row.kind) as CandidateInsightKind, statement: String(row.statement), whyProposed: String(row.why_proposed),
    evidenceRefs: parseJsonArray(row.evidence_refs_json), intentRefs: parseJsonArray(row.intent_refs_json),
    unknowns: parseJsonArray(row.unknowns_json), reuseBoundary: parseJsonObject(row.reuse_boundary_json),
    scopeReviewRequired,
    sourceScope: snapshot && snapshot.projectId === row.project_id ? { projectId: snapshot.projectId, environment: snapshot.environment, sampleManagerVersion: snapshot.sampleManagerVersion, solution: snapshot.solution, module: snapshot.module } : undefined,
    confirmedFacts: parseJsonArray(row.confirmed_facts_json), observedBehavior: parseJsonArray(row.observed_behavior_json),
    hypothesis: row.hypothesis ? String(row.hypothesis) : undefined,
    reusableStatement: typeof reusable.statement === "string" ? { statement: reusable.statement, applicability: typeof reusable.applicability === "string" ? reusable.applicability : undefined, boundary: typeof reusable.boundary === "string" ? reusable.boundary : undefined } : undefined,
    confidence: row.confidence === null || row.confidence === undefined ? undefined : Number(row.confidence),
    status: String(row.status) as CandidateInsightStatus, generatedBy: String(row.generated_by),
    fallbackReason: row.fallback_reason ? String(row.fallback_reason) : undefined,
    inputHash: String(row.input_hash), persisted: true,
    reviewedBy: row.reviewed_by === null || row.reviewed_by === undefined ? undefined : Number(row.reviewed_by),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
    reviewReason: row.review_reason ? String(row.review_reason) : undefined,
    promotion: row.promotion_json ? parseJsonObject(row.promotion_json) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

type CandidateInsightFields = Pick<CandidateInsight, "kind" | "statement" | "whyProposed" | "evidenceRefs" | "intentRefs" | "unknowns" | "reuseBoundary" | "confirmedFacts" | "observedBehavior"> & Partial<Pick<CandidateInsight, "hypothesis" | "reusableStatement" | "confidence">>;

interface ValidatedEvidence {
  id: string;
  locator: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  sha256: string;
}

export class CandidateInsightCompiler {
  private static readonly compileLocks = new WeakMap<KnowledgeStore, Map<string, Promise<CandidateInsight>>>();
  private readonly sessions: WorkSessionService;
  private readonly provider: ManagedCandidateInsightProvider;
  private readonly managed: boolean;
  private readonly options: Required<CandidateInsightCompilerOptions>;

  constructor(
    private readonly store: KnowledgeStore,
    provider: CandidateInsightProvider,
    private readonly clock: () => Date = () => new Date(),
    options: CandidateInsightCompilerOptions = {},
  ) {
    this.sessions = new WorkSessionService(store, clock);
    if (typeof provider === "function") {
      this.managed = false;
      this.provider = { providerId: "legacy-function-provider", modelId: "unspecified", complete: (request) => Promise.resolve(provider(request.prompt)) };
    } else {
      this.managed = true;
      this.provider = provider;
    }
    this.options = {
      timeoutMs: bounded(options.timeoutMs, 30_000, 1, 120_000),
      maxTokens: bounded(options.maxTokens, 4096, 1, 32768),
      maxOutputChars: bounded(options.maxOutputChars, 32_000, 1_000, 200_000),
      maxPromptChars: bounded(options.maxPromptChars, 24_000, 2_000, 200_000),
      evidenceExcerptChars: bounded(options.evidenceExcerptChars, 1_200, 0, 8_000),
      maxEvidence: bounded(options.maxEvidence, 100, 1, 100),
    };
  }

  private generatedByLabel(): string {
    return this.managed ? `${MANAGED_GENERATED_BY_PREFIX}:${this.provider.providerId}/${this.provider.modelId}` : LEGACY_GENERATED_BY;
  }

  /** Evidence must exist, not be deleted, and be visible to the session project (same project or explicit ACL grant). */
  private validateEvidence(session: WorkSession, refs: string[]): ValidatedEvidence[] {
    const results: ValidatedEvidence[] = [];
    const aclLookup = this.store.db.prepare("SELECT 1 FROM knowledge_evidence_acl WHERE evidence_id = ? AND project_id = ?");
    for (const evidenceId of refs) {
      const row = this.store.db.prepare("SELECT id,project_id,mime_type,size_bytes,source_locator,storage_path,sha256,deleted_at FROM knowledge_evidence WHERE id = ?").get(evidenceId) as Record<string, unknown> | undefined;
      if (!row || row.deleted_at) throw new Error(`Evidence reference is not available: ${evidenceId}`);
      const visible = row.project_id === session.projectId || Boolean(aclLookup.get(evidenceId, session.projectId));
      if (!visible) throw new Error(`Evidence reference is outside the session project: ${evidenceId}`);
      results.push({ id: String(row.id), locator: String(row.source_locator), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), storagePath: String(row.storage_path), sha256: String(row.sha256) });
    }
    return results;
  }

  private evidenceExcerpt(evidence: ValidatedEvidence): string | undefined {
    if (this.options.evidenceExcerptChars === 0 || evidence.sizeBytes > 64_000 || !TEXT_MIME.test(evidence.mimeType)) return undefined;
    try {
      if (!existsSync(evidence.storagePath)) return undefined;
      return redactExcerpt(readFileSync(evidence.storagePath, "utf8")).slice(0, this.options.evidenceExcerptChars);
    } catch {
      return undefined;
    }
  }

  private buildPrompt(session: WorkSession, context: unknown, evidence: ValidatedEvidence[]): string {
    const instructions = {
      task: "candidate_insight",
      rules: [
        "Respond with a single bare JSON object; no Markdown fences, no prose, no comments.",
        "Never include chain-of-thought or hidden reasoning fields (thought, reasoning, scratchpad, ...).",
        "Never include credentials, tokens, passwords or connection strings.",
        "Every evidenceRefs entry must be one of the provided evidence ids.",
        "Match every field type in outputSchema; omit unknown optional fields instead of null or empty placeholders.",
      ],
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["kind", "statement", "whyProposed", "evidenceRefs", "intentRefs", "unknowns", "reuseBoundary", "confirmedFacts", "observedBehavior"],
        properties: {
          kind: { type: "string", enum: CANDIDATE_INSIGHT_KINDS },
          statement: { type: "string", minLength: 1, maxLength: 4_000 },
          whyProposed: { type: "string", minLength: 1, maxLength: 4_000 },
          evidenceRefs: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", enum: evidence.map(item => item.id) } },
          intentRefs: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 300 } },
          unknowns: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1_000 } },
          reuseBoundary: { type: "object", description: "Explicit project scope and applicability limits as named properties." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          confirmedFacts: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 2_000 } },
          observedBehavior: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 2_000 } },
          hypothesis: { type: "string", minLength: 1, maxLength: 2_000 },
          reusableStatement: { type: "object", additionalProperties: false, required: ["statement"], properties: {
            statement: { type: "string", minLength: 1, maxLength: 2_000 },
            applicability: { type: "string", minLength: 1, maxLength: 2_000 },
            boundary: { type: "string", minLength: 1, maxLength: 2_000 },
          } },
        },
      },
      kinds: CANDIDATE_INSIGHT_KINDS,
    };
    const build = (excerptChars: number): string => JSON.stringify({
      ...instructions,
      session: { projectId: session.projectId },
      context,
      evidence: evidence.map((item) => ({
        id: item.id,
        locator: item.locator,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        excerpt: excerptChars > 0 && item.sizeBytes <= 64_000 && TEXT_MIME.test(item.mimeType)
          ? this.evidenceExcerpt(item)?.slice(0, excerptChars)
          : undefined,
      })),
    });
    let prompt = build(this.options.evidenceExcerptChars);
    if (prompt.length > this.options.maxPromptChars) prompt = build(200);
    if (prompt.length > this.options.maxPromptChars) prompt = build(0);
    return prompt.slice(0, this.options.maxPromptChars);
  }

  private async callProvider(prompt: string): Promise<string> {
    const timeoutMs = this.options.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new CandidateProviderError("timeout", `Candidate Insight provider timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await Promise.race([
        this.provider.complete({ prompt, timeoutMs, signal: controller.signal, maxTokens:this.options.maxTokens }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => {
          const reason = controller.signal.reason;
          reject(reason instanceof Error ? reason : new CandidateProviderError("timeout", "Candidate Insight provider aborted"));
        }, { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseModelOutput(raw: string): CandidateInsightModelOutput {
    const trimmed = raw.trim();
    if (trimmed.length > this.options.maxOutputChars) throw new CandidateProviderError("overlong_output", `Model output exceeded ${this.options.maxOutputChars} characters`);
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new CandidateProviderError("invalid_output", "Model output is not a bare JSON object");
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new CandidateProviderError("invalid_output", "Model output is not valid JSON", { cause: error });
    }
    const disallowed = scanCandidateContent(parsed);
    if (disallowed) throw new CandidateProviderError("invalid_output", `Model output contains ${disallowed}`);
    try {
      return candidateInsightOutputSchema.parse(parsed);
    } catch (error) {
      throw new CandidateProviderError("invalid_output", "Model output failed the Candidate Insight schema", { cause: error });
    }
  }

  private fallbackDraft(session: WorkSession, evidenceRefs: string[], context: Record<string, unknown>, reason: string): CandidateInsightFields {
    return {
      kind: "observation",
      statement: text(context.statement, "Evidence requires human review"),
      whyProposed: "Deterministic fallback: the managed provider could not produce a validated insight",
      evidenceRefs,
      intentRefs: [],
      unknowns: [`Managed provider output unavailable (${reason}); awaiting human review`],
      reuseBoundary: { scope: "project", projectId: session.projectId },
      confirmedFacts: [],
      observedBehavior: [],
    };
  }

  async compile(input: CandidateInsightInput): Promise<CandidateInsight> {
    const session = this.sessions.get({ actorId: input.actorId, sessionId: input.sessionId });
    if (!session) throw new Error("Work Session not found");
    const evidenceRefs = [...new Set(input.evidenceRefs.map((ref) => String(ref).trim()).filter(Boolean))].sort().slice(0, this.options.maxEvidence);
    const safeContext = redactCandidateInput(input.context ?? {}) as Record<string, unknown>;
    const inputHash = createHash("sha256").update(canonicalCandidateJson({ sessionId: session.id, projectId: session.projectId, evidenceRefs, context: safeContext })).digest("hex");
    const lockKey = `${session.id}\0${inputHash}`;
    let locks = CandidateInsightCompiler.compileLocks.get(this.store);
    if (!locks) {
      locks = new Map();
      CandidateInsightCompiler.compileLocks.set(this.store, locks);
    }
    const pending = locks.get(lockKey);
    if (pending) return pending;
    const promise = this.compileOnce(input);
    locks.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(lockKey) === promise) locks.delete(lockKey);
    }
  }

  private async compileOnce(input: CandidateInsightInput): Promise<CandidateInsight> {
    const session = this.sessions.get({ actorId: input.actorId, sessionId: input.sessionId });
    if (!session) throw new Error("Work Session not found");
    const evidenceRefs = [...new Set(input.evidenceRefs.map((ref) => String(ref).trim()).filter(Boolean))].sort().slice(0, this.options.maxEvidence);
    const evidence = this.validateEvidence(session, evidenceRefs);
    const safeContext = redactCandidateInput(input.context ?? {}) as Record<string, unknown>;
    const inputHash = createHash("sha256").update(canonicalCandidateJson({ sessionId: session.id, projectId: session.projectId, evidenceRefs, context: safeContext })).digest("hex");
    const existing = this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE work_session_id = ? AND input_hash = ?").get(session.id, inputHash) as Record<string, unknown> | undefined;
    if (existing) return candidateInsightFromRow(existing, this.store);

    const now = this.clock().toISOString();
    const id = `insight-${inputHash.slice(0, 32)}`;

    // No valid Evidence means nothing may be persisted; return an ephemeral
    // draft so callers can still surface a deterministic review hint.
    if (evidence.length === 0) {
      const draft = this.fallbackDraft(session, [], safeContext, "no_evidence");
      this.store.audit({ actorId: input.actorId, projectId: session.projectId, action: "candidate_insight.skipped_no_evidence", entityType: "candidate_insight", entityId: id, details: { workSessionId: session.id } });
      return { id, workSessionId: session.id, projectId: session.projectId, ...draft, scopeReviewRequired: true, confidence: undefined, status: "draft", generatedBy: FALLBACK_GENERATED_BY, fallbackReason: "no_evidence", inputHash, persisted: false, createdAt: now, updatedAt: now };
    }

    let fields: CandidateInsightFields;
    let generatedBy = this.generatedByLabel();
    let fallbackReason: string | undefined;
    try {
      const output = this.parseModelOutput(await this.callProvider(this.buildPrompt(session, safeContext, evidence)));
      const citedRefs = output.evidenceRefs.filter((ref) => evidenceRefs.includes(ref));
      if (citedRefs.length === 0) throw new CandidateProviderError("invalid_output", "Model output cited no valid Evidence");
      fields = {
        kind: output.kind, statement: output.statement, whyProposed: output.whyProposed,
        evidenceRefs: citedRefs, intentRefs: output.intentRefs, unknowns: output.unknowns,
        reuseBoundary: output.reuseBoundary, confirmedFacts: output.confirmedFacts, observedBehavior: output.observedBehavior,
        hypothesis: output.hypothesis, reusableStatement: output.reusableStatement, confidence: output.confidence,
      };
    } catch (error) {
      fallbackReason = classifyCandidateProviderError(error);
      fields = this.fallbackDraft(session, evidenceRefs, safeContext, fallbackReason);
      generatedBy = FALLBACK_GENERATED_BY;
    }

    // Applicability scope is a Relay fact, not a model inference. Preserve it
    // even when the provider omits or attempts to broaden these fields.
    fields.reuseBoundary = { ...fields.reuseBoundary, scope: "project", projectId: session.projectId,
      environment: session.environment, sampleManagerVersion: session.intent.sampleManagerVersion,
      solution: session.intent.solution, module: session.intent.module };
    const snapshot = candidateScopeSnapshot(session, "compile", now);
    const result: CandidateInsight = {
      id, workSessionId: session.id, projectId: session.projectId, ...fields,
      scopeReviewRequired: false, sourceScope: { projectId: snapshot.projectId, environment: snapshot.environment, sampleManagerVersion: snapshot.sampleManagerVersion, solution: snapshot.solution, module: snapshot.module },
      status: "draft", generatedBy, fallbackReason, inputHash, persisted: true, createdAt: now, updatedAt: now,
    };

    // Record and audit commit atomically; a concurrent replay of the same
    // input hash loses the INSERT race and receives the original record.
    let inserted = false;
    this.store.db.transaction(() => {
      const write = this.store.db.prepare(`INSERT OR IGNORE INTO knowledge_candidate_insights
        (id,work_session_id,project_id,kind,statement,why_proposed,evidence_refs_json,intent_refs_json,unknowns_json,reuse_boundary_json,confirmed_facts_json,observed_behavior_json,hypothesis,reusable_statement_json,confidence,status,generated_by,fallback_reason,input_hash,created_at,updated_at,scope_snapshot_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(result.id, result.workSessionId, result.projectId, result.kind, result.statement, result.whyProposed,
          JSON.stringify(result.evidenceRefs), JSON.stringify(result.intentRefs), JSON.stringify(result.unknowns), JSON.stringify(result.reuseBoundary),
          JSON.stringify(result.confirmedFacts), JSON.stringify(result.observedBehavior), result.hypothesis ?? null,
          result.reusableStatement ? JSON.stringify(result.reusableStatement) : null, result.confidence ?? null,
          result.status, result.generatedBy, result.fallbackReason ?? null, result.inputHash, result.createdAt, result.updatedAt, JSON.stringify(snapshot));
      inserted = write.changes === 1;
      if (inserted) {
        this.store.audit({ actorId: input.actorId, projectId: session.projectId, action: "candidate_insight.compiled", entityType: "candidate_insight", entityId: result.id, details: { workSessionId: session.id, evidenceCount: result.evidenceRefs.length, generatedBy: result.generatedBy, fallbackReason: result.fallbackReason } });
      }
    })();
    if (!inserted) {
      const winner = this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE work_session_id = ? AND input_hash = ?").get(session.id, inputHash) as Record<string, unknown> | undefined;
      if (winner) return candidateInsightFromRow(winner, this.store);
    }
    return result;
  }

  get(actorId: number, id: string): CandidateInsight | undefined {
    const row = this.store.db.prepare("SELECT * FROM knowledge_candidate_insights WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    try {
      this.sessions.get({ actorId, sessionId: String(row.work_session_id) });
    } catch {
      return undefined;
    }
    return candidateInsightFromRow(row, this.store);
  }
}

import type { IntentEnvelope } from "./work-session.js";

/** Search intents are routing hints for the existing Product search, not search entry points. */
export const PRODUCT_SEARCH_INTENTS = [
  "direct_document",
  "version_comparison",
  "relation_context",
  "procedure",
  "entity",
  "topic",
] as const;

export type ProductSearchIntent = typeof PRODUCT_SEARCH_INTENTS[number];

/** Filters shared by Product retrieval callers. Unknown filters are intentionally ignored. */
export interface ProductSearchIntentFilters {
  projectId?: string;
  environment?: string;
  product?: string;
  productVersion?: string;
  sampleManagerVersion?: string;
  solution?: string;
  module?: string;
  topicId?: string;
  documentId?: string;
  documentType?: string;
  sourcePath?: string;
  /** Optional pair supplied by a comparison UI. */
  fromVersion?: string;
  toVersion?: string;
  versions?: readonly string[];
}

export interface ProductSearchIntentInput {
  query: string;
  /** A partial envelope is accepted so callers do not need to reconstruct a session. */
  intent?: Partial<IntentEnvelope>;
  /** Alias for callers that name the object after the persisted model. */
  intentEnvelope?: Partial<IntentEnvelope>;
  filters?: ProductSearchIntentFilters;
}

export interface ProductGraphExpansionSettings {
  enabled: boolean;
  /** Always bounded to 0..2. */
  maxHops: 0 | 1 | 2;
  /** Always bounded to 0..16. */
  maxEntities: number;
  relationTypes: readonly string[];
}

export interface ProductSearchIntentResult {
  intent: ProductSearchIntent;
  /** Normalized, de-duplicated query terms suitable for bounded lexical/graph expansion. */
  terms: readonly string[];
  graphExpansion: ProductGraphExpansionSettings;
}

/** Exported to make precedence reviewable and stable for callers and tests. */
export const PRODUCT_SEARCH_INTENT_PRECEDENCE: readonly ProductSearchIntent[] = [
  "version_comparison",
  "direct_document",
  "relation_context",
  "procedure",
  "entity",
  "topic",
] as const;

const MAX_QUERY_LENGTH = 4_000;
const MAX_TERMS = 24;
const MAX_TERM_LENGTH = 80;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "please", "the", "to", "what", "when", "where", "which", "who", "why", "with",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function combinedContext(input: ProductSearchIntentInput): string {
  const intent = input.intentEnvelope ?? input.intent;
  if (!intent) return "";
  return [
    intent.objective,
    intent.desiredOutcome,
    intent.phase,
    ...(intent.actions ?? []),
    ...(intent.constraints ?? []),
  ].filter((value): value is string => typeof value === "string").join(" ");
}

function versionValues(input: ProductSearchIntentInput): string[] {
  const filters = input.filters ?? {};
  return [
    filters.fromVersion,
    filters.toVersion,
    filters.productVersion,
    filters.sampleManagerVersion,
    ...(filters.versions ?? []),
  ].map(text).filter(Boolean);
}

function versionMarkers(value: string): string[] {
  // Product versions are deliberately conservative: a comparison needs two
  // explicit markers, rather than treating arbitrary numbers as versions.
  return value.match(/\b(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?\b/gi) ?? [];
}

function hasVersionComparison(query: string, context: string, input: ProductSearchIntentInput): boolean {
  const filters = input.filters ?? {};
  const values = versionValues(input);
  if ((text(filters.fromVersion) && text(filters.toVersion)) || (filters.versions?.filter((value) => text(value)).length ?? 0) >= 2) return true;
  const comparison = /\b(compare|comparison|compared|difference|differ|versus|vs\.?|between|upgrade\s+path|migrat(?:e|ion)|changes?\s+(?:from|since|between))\b/i.test(`${query} ${context}`);
  if (!comparison) return false;
  const markers = [...versionMarkers(query), ...versionMarkers(context), ...values];
  return new Set(markers.map((marker) => marker.toLowerCase())).size >= 2;
}

function hasDirectDocument(query: string, input: ProductSearchIntentInput): boolean {
  const filters = input.filters ?? {};
  if (text(filters.documentId) || text(filters.sourcePath)) return true;
  if (/\.(?:pdf|md|markdown|html?|chm)\b/i.test(query) || /(?:^|[\\/])[^\s]+\.(?:pdf|md|markdown|html?|chm)\b/i.test(query)) return true;
  if (/\b(document(?:ation)?|docs?|manual|guide|reference|release\s+notes?|readme|spec(?:ification)?|article|chapter|page)\b/i.test(query)) return true;
  return /\b(?:find|open|show|locate|lookup|read)\b/i.test(query) && /\b(?:file|source|document|page|manual|guide)\b/i.test(query);
}

function hasRelationContext(value: string): boolean {
  return /\b(?:depend(?:s|ency|encies)?|impact(?:s|ed)?|affect(?:s|ed)?|upstream|downstream|related|relationship|connect(?:s|ed|ion)?|integrat(?:e|ed|ion)|used\s+by|calls?|invokes?|requires?|links?|trace(?:s|d)?|blast\s+radius)\b/i.test(value);
}

function hasProcedure(value: string): boolean {
  return /\b(?:how\s+(?:do|can|to)|steps?|procedure|configure|configuring|install(?:ation|ing)?|setup|set\s+up|enable|disable|create|remove|delete|run|execute|troubleshoot(?:ing)?|fix|resolve|migrat(?:e|ion)|upgrade)\b/i.test(value);
}

function hasEntity(value: string): boolean {
  return /\b(?:what\s+is|which\s+(?:component|module|service|instrument|feature|setting|parameter)|where\s+is|who\s+owns?|identify|name\s+the|entity|component|instrument|endpoint|field|parameter|setting|service)\b/i.test(value);
}

function queryTerms(query: string): string[] {
  const normalized = text(query).toLowerCase().slice(0, MAX_QUERY_LENGTH);
  const matches = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_./:+-]{0,79}/gu) ?? [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const term = match.slice(0, MAX_TERM_LENGTH);
    if (!term || STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
    if (result.length >= MAX_TERMS) break;
  }
  return result;
}

function graphExpansion(intent: ProductSearchIntent): ProductGraphExpansionSettings {
  switch (intent) {
    case "relation_context": return { enabled: true, maxHops: 2, maxEntities: 16, relationTypes: ["depends_on", "impacts", "related_to", "used_by"] };
    case "entity": return { enabled: true, maxHops: 1, maxEntities: 8, relationTypes: ["related_to", "depends_on", "used_by"] };
    case "version_comparison": return { enabled: true, maxHops: 1, maxEntities: 10, relationTypes: ["changed_in", "related_to", "depends_on"] };
    case "procedure": return { enabled: true, maxHops: 1, maxEntities: 8, relationTypes: ["enables", "depends_on", "related_to"] };
    case "topic": return { enabled: true, maxHops: 1, maxEntities: 6, relationTypes: ["related_to"] };
    case "direct_document": return { enabled: false, maxHops: 0, maxEntities: 0, relationTypes: [] };
  }
}

/**
 * Deterministically routes a Product query to bounded retrieval hints.
 *
 * Precedence is explicit: version comparison, direct document, relation context,
 * procedure, entity, then topic. A topic route is the safe default, including
 * empty or unrecognized queries; graph expansion never receives an unbounded
 * caller-controlled limit.
 */
export function routeProductSearchIntent(input: ProductSearchIntentInput): ProductSearchIntentResult {
  const query = text(input?.query).slice(0, MAX_QUERY_LENGTH);
  const context = combinedContext(input ?? {});
  const signalText = `${query} ${context}`;
  let intent: ProductSearchIntent = "topic";
  if (hasVersionComparison(query, context, input)) intent = "version_comparison";
  else if (hasDirectDocument(query, input)) intent = "direct_document";
  else if (hasRelationContext(signalText)) intent = "relation_context";
  else if (hasProcedure(signalText)) intent = "procedure";
  else if (hasEntity(signalText)) intent = "entity";
  return { intent, terms: queryTerms(query), graphExpansion: graphExpansion(intent) };
}

/** Descriptive alias for callers that prefer classification terminology. */
export const classifyProductSearchIntent = routeProductSearchIntent;

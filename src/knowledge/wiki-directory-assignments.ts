import type { KnowledgeStore } from "./store.js";
import { canonicalWikiRows } from "./wiki-identity.js";
import { isSourceHierarchyPath, buildWikiDirectoryPaths } from "./wiki-directory.js";

export const WIKI_DIRECTORY_TAXONOMY_VERSION = 2;
export const TOPIC_FAMILY_LABEL = "Topic families";
export const OTHER_TOPICS_LABEL = "Other topics";

export interface WikiDirectoryScope {
  projectId?: string;
  environment?: string;
}

export interface WikiDirectoryCandidate {
  identityKey: string;
  pageId: string;
  topicGroupId?: string;
  title: string;
  rawPath?: string;
  solution?: string;
  module?: string;
}

export interface WikiDirectoryAssignment {
  scopeProjectId: string;
  scopeEnvironment: string;
  identityKey: string;
  pageId: string;
  topicGroupId?: string;
  displayPath: string[];
  directoryContext?: string;
  rawPath?: string;
  classificationSource: string;
  taxonomyVersion: number;
  updatedAt?: string;
}

export interface WikiDirectoryRefreshResult {
  total: number;
  written: number;
  taxonomyVersion: number;
}

type Row = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function scopeValue(value: unknown): string {
  return text(value) ?? "";
}

function parseStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? [...new Set(parsed.map(text).filter((item): item is string => Boolean(item)))] : [];
  } catch {
    return [];
  }
}

function splitPath(value: unknown): string[] {
  return String(value ?? "").split(/[\\/]+/).map((part) => part.trim()).filter(Boolean);
}

function cleanLabel(value: unknown): string | undefined {
  const result = text(value)?.replace(/[\\/]+/g, " — ");
  if (!result || normalized(result) === "unassigned") return undefined;
  return result;
}

function identityFor(pageId: string, topicGroupId?: string): string {
  return topicGroupId ? `topic:${topicGroupId}` : `page:${pageId}`;
}

function withoutTitle(path: string[], title: string): string[] {
  if (!path.length) return [];
  return normalized(path[path.length - 1]) === normalized(title) ? path.slice(0, -1) : path;
}

function rawFamilyKey(candidate: WikiDirectoryCandidate): string | undefined {
  const base = withoutTitle(splitPath(candidate.rawPath), candidate.title);
  const root = cleanLabel(base[0]);
  const family = cleanLabel(base[1]);
  return root && family ? `${normalized(root)}\u0000${normalized(family)}` : undefined;
}

function scopeWhere(scope: WikiDirectoryScope): { sql: string; params: Array<string | null> } {
  const projectId = text(scope.projectId), environment = text(scope.environment);
  if (!projectId) return { sql: "p.project_id IS NULL AND p.environment IS NULL", params: [] };
  return {
    sql: "((p.project_id IS NULL AND p.environment IS NULL) OR (p.project_id=? AND p.environment IS ?))",
    params: [projectId, environment ?? null],
  };
}

function loadCanonicalRows(store: KnowledgeStore, scope: WikiDirectoryScope): Row[] {
  const where = scopeWhere(scope);
  const rows = store.db.prepare(`SELECT p.rowid AS __wiki_rowid,p.id,p.title,p.topic_group_id,p.source_refs_json,p.solution,p.module,p.directory_path,p.project_id,p.environment
    FROM knowledge_wiki_pages p
    WHERE p.id NOT LIKE 'engine-wiki:%' AND ${where.sql}
    ORDER BY p.updated_at DESC,p.id`).all(...where.params) as Row[];
  return canonicalWikiRows(rows);
}

function candidatesFromRows(store: KnowledgeStore, rows: Row[], rebuildSourcePaths = false): WikiDirectoryCandidate[] {
  const base = rows.map((row) => ({
    pageId: String(row.id),
    topicGroupId: text(row.topic_group_id),
    title: String(row.title ?? row.id),
    sourceRefs: parseStrings(row.source_refs_json),
    solution: cleanLabel(row.solution),
    module: cleanLabel(row.module),
    rawPath: text(row.directory_path),
  }));
  const missing = base.map((item, index) => item.rawPath ? undefined : index).filter((index): index is number => index !== undefined);
  const rebuild = rebuildSourcePaths
    ? base.map((item, index) => item.sourceRefs.length ? index : undefined).filter((index): index is number => index !== undefined)
    : missing;
  if (rebuild.length) {
    const paths = buildWikiDirectoryPaths(store, rebuild.map((index) => ({
      title: base[index].title,
      sourceRefs: base[index].sourceRefs,
      solution: base[index].solution,
      module: base[index].module,
    })));
    rebuild.forEach((index, pathIndex) => { base[index].rawPath = paths[pathIndex]; });
  }
  return base.map((item) => ({
    identityKey: identityFor(item.pageId, item.topicGroupId),
    pageId: item.pageId,
    topicGroupId: item.topicGroupId,
    title: item.title,
    rawPath: item.rawPath,
    solution: item.solution,
    module: item.module,
  }));
}

function scopeKey(scope: WikiDirectoryScope): { projectId: string; environment: string } {
  return { projectId: scopeValue(scope.projectId), environment: scopeValue(scope.environment) };
}

/**
 * Convert source paths to stable user-facing folders. The family threshold is
 * evaluated across the complete scope, so the result never depends on the
 * current UI page or the order in which rows were loaded.
 */
export function classifyWikiDirectory(candidates: WikiDirectoryCandidate[], taxonomyVersion = WIKI_DIRECTORY_TAXONOMY_VERSION): Map<string, WikiDirectoryAssignment> {
  const familyCounts = new Map<string, number>();
  const prepared = candidates.map((candidate) => {
    const sourcePath = splitPath(candidate.rawPath);
    const base = withoutTitle(sourcePath, candidate.title);
    const sourceHierarchy = isSourceHierarchyPath(sourcePath.join("/"));
    const root = cleanLabel(base[0]) ?? OTHER_TOPICS_LABEL;
    const family = cleanLabel(base[1]);
    const familyKey = family ? `${normalized(root)}\u0000${normalized(family)}` : undefined;
    if (familyKey) familyCounts.set(familyKey, (familyCounts.get(familyKey) ?? 0) + 1);
    return { candidate, sourcePath, base, sourceHierarchy, root, family, familyKey };
  });
  const assignments = new Map<string, WikiDirectoryAssignment>();
  for (const item of prepared) {
    const grouped = Boolean(item.familyKey && (familyCounts.get(item.familyKey!) ?? 0) >= 2);
    const displayPath = item.sourceHierarchy
      ? (item.base.length ? item.base : [item.root])
      : item.root === OTHER_TOPICS_LABEL
        ? [OTHER_TOPICS_LABEL]
        : grouped
          ? [item.root, TOPIC_FAMILY_LABEL, item.family!]
          : [item.root, OTHER_TOPICS_LABEL];
    const contextStart = grouped ? 2 : 1;
    const directoryContext = item.sourceHierarchy ? undefined : item.base.slice(contextStart).join(" / ") || undefined;
    assignments.set(item.candidate.identityKey, {
      scopeProjectId: "",
      scopeEnvironment: "",
      identityKey: item.candidate.identityKey,
      pageId: item.candidate.pageId,
      topicGroupId: item.candidate.topicGroupId,
      displayPath,
      directoryContext,
      rawPath: item.sourcePath.join("/"),
      classificationSource: item.sourceHierarchy ? "source_hierarchy" : grouped ? "topic_family" : "other_topics",
      taxonomyVersion,
    });
  }
  return assignments;
}

function assignmentRow(store: KnowledgeStore, scope: WikiDirectoryScope, assignment: WikiDirectoryAssignment): WikiDirectoryAssignment {
  const key = scopeKey(scope);
  const row = { ...assignment, scopeProjectId: key.projectId, scopeEnvironment: key.environment };
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO knowledge_wiki_directory_assignments
    (scope_project_id,scope_environment,identity_key,page_id,topic_group_id,display_path,directory_context,raw_path,classification_source,taxonomy_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(scope_project_id,scope_environment,identity_key) DO UPDATE SET
      page_id=excluded.page_id,topic_group_id=excluded.topic_group_id,display_path=excluded.display_path,
      directory_context=excluded.directory_context,raw_path=excluded.raw_path,classification_source=excluded.classification_source,
      taxonomy_version=excluded.taxonomy_version,updated_at=excluded.updated_at`).run(
    key.projectId, key.environment, row.identityKey, row.pageId, row.topicGroupId ?? null,
    row.displayPath.join("/"), row.directoryContext ?? null, row.rawPath ?? null, row.classificationSource,
    row.taxonomyVersion, now, now,
  );
  return { ...row, updatedAt: now };
}

function persistAssignments(store: KnowledgeStore, scope: WikiDirectoryScope, assignments: Iterable<WikiDirectoryAssignment>): number {
  let written = 0;
  const persist = store.db.transaction(() => {
    for (const assignment of assignments) {
      assignmentRow(store, scope, assignment);
      written += 1;
    }
  });
  persist.immediate();
  return written;
}

export function listWikiDirectoryAssignments(store: KnowledgeStore, scope: WikiDirectoryScope = {}): WikiDirectoryAssignment[] {
  const key = scopeKey(scope);
  const rows = store.db.prepare(`SELECT scope_project_id,scope_environment,identity_key,page_id,topic_group_id,display_path,directory_context,raw_path,classification_source,taxonomy_version,updated_at
    FROM knowledge_wiki_directory_assignments WHERE scope_project_id=? AND scope_environment=? ORDER BY display_path, page_id`).all(key.projectId, key.environment) as Row[];
  return rows.map((row) => ({
    scopeProjectId: String(row.scope_project_id ?? ""),
    scopeEnvironment: String(row.scope_environment ?? ""),
    identityKey: String(row.identity_key),
    pageId: String(row.page_id),
    topicGroupId: text(row.topic_group_id),
    displayPath: splitPath(row.display_path),
    directoryContext: text(row.directory_context),
    rawPath: text(row.raw_path),
    classificationSource: String(row.classification_source ?? "derived"),
    taxonomyVersion: Number(row.taxonomy_version ?? WIKI_DIRECTORY_TAXONOMY_VERSION),
    updatedAt: text(row.updated_at),
  }));
}

export function backfillWikiDirectoryAssignments(store: KnowledgeStore, scope: WikiDirectoryScope = {}): WikiDirectoryRefreshResult {
  const rows = loadCanonicalRows(store, scope);
  const candidates = candidatesFromRows(store, rows, true);
  const assignments = classifyWikiDirectory(candidates);
  const key = scopeKey(scope);
  assignments.forEach((assignment) => { assignment.scopeProjectId = key.projectId; assignment.scopeEnvironment = key.environment; });
  const written = persistAssignments(store, scope, assignments.values());
  return { total: assignments.size, written, taxonomyVersion: WIKI_DIRECTORY_TAXONOMY_VERSION };
}

export function ensureWikiDirectoryAssignments(store: KnowledgeStore, scope: WikiDirectoryScope = {}): WikiDirectoryRefreshResult {
  const rows = loadCanonicalRows(store, scope);
  const expected = new Set(candidatesFromRows(store, rows).map((candidate) => candidate.identityKey));
  const current = listWikiDirectoryAssignments(store, scope);
  const missing = [...expected].some((identity) => !current.some((assignment) => assignment.identityKey === identity));
  const stale = current.some((assignment) => assignment.taxonomyVersion !== WIKI_DIRECTORY_TAXONOMY_VERSION);
  if (!missing && !stale) return { total: expected.size, written: 0, taxonomyVersion: WIKI_DIRECTORY_TAXONOMY_VERSION };
  return backfillWikiDirectoryAssignments(store, scope);
}

export function refreshWikiDirectoryAssignments(store: KnowledgeStore, input: WikiDirectoryScope & { topicGroupIds?: string[] } = {}): WikiDirectoryRefreshResult {
  const rows = loadCanonicalRows(store, input);
  const taxonomyStale = listWikiDirectoryAssignments(store, input).some((assignment) => assignment.taxonomyVersion !== WIKI_DIRECTORY_TAXONOMY_VERSION);
  const candidates = candidatesFromRows(store, rows, taxonomyStale);
  const assignments = classifyWikiDirectory(candidates);
  if (taxonomyStale) {
    const key = scopeKey(input);
    assignments.forEach((assignment) => { assignment.scopeProjectId = key.projectId; assignment.scopeEnvironment = key.environment; });
    const written = persistAssignments(store, input, assignments.values());
    return { total: assignments.size, written, taxonomyVersion: WIKI_DIRECTORY_TAXONOMY_VERSION };
  }
  const requested = new Set((input.topicGroupIds ?? []).map((value) => value.trim()).filter(Boolean));
  if (!requested.size) {
    const key = scopeKey(input);
    assignments.forEach((assignment) => { assignment.scopeProjectId = key.projectId; assignment.scopeEnvironment = key.environment; });
    const written = persistAssignments(store, input, assignments.values());
    return { total: assignments.size, written, taxonomyVersion: WIKI_DIRECTORY_TAXONOMY_VERSION };
  }
  const affectedFamilyKeys = new Set<string>();
  candidates.forEach((candidate) => {
    if (!candidate.topicGroupId || !requested.has(candidate.topicGroupId)) return;
    // Use the raw graph path to discover the affected family. A topic can be
    // classified as Other topics while it is the only member, then become a
    // Topic families entry when a later version arrives. Looking only at the
    // current persisted display path would miss that singleton -> family
    // transition and leave the sibling assignment stale.
    const familyKey = rawFamilyKey(candidate);
    if (familyKey) affectedFamilyKeys.add(familyKey);
  });
  const affected = [...assignments.values()].filter((assignment) => {
    if (requested.has(assignment.topicGroupId ?? "")) return true;
    const candidate = candidates.find((item) => item.identityKey === assignment.identityKey);
    return Boolean(candidate && rawFamilyKey(candidate) && affectedFamilyKeys.has(rawFamilyKey(candidate)!));
  });
  const key = scopeKey(input);
  affected.forEach((assignment) => { assignment.scopeProjectId = key.projectId; assignment.scopeEnvironment = key.environment; });
  const written = persistAssignments(store, input, affected);
  return { total: assignments.size, written, taxonomyVersion: WIKI_DIRECTORY_TAXONOMY_VERSION };
}

export function assignmentsByPage(store: KnowledgeStore, scope: WikiDirectoryScope = {}): Map<string, WikiDirectoryAssignment> {
  return new Map(listWikiDirectoryAssignments(store, scope).map((assignment) => [assignment.pageId, assignment]));
}

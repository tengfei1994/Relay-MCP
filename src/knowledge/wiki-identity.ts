export type WikiIdentityRow = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalize upstream/product metadata without making identity depend on slug punctuation. */
export function normalizeWikiTopic(value: unknown): string | undefined {
  const source = text(value);
  if (!source) return undefined;
  const normalized = source.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function scope(row: WikiIdentityRow): string {
  // Scope values are opaque identifiers. JSON gives us an unambiguous field
  // delimiter even when an upstream identifier contains punctuation.
  return JSON.stringify([text(row.project_id) ?? null, text(row.environment) ?? null]);
}
/** Scope keeps global and private pages from collapsing into one identity. */
export function wikiCanonicalKey(row: WikiIdentityRow): string {
  return `${scope(row)}\u0000${wikiTopicIdentity(row)}`;
}

/**
 * Explicit Product topic IDs are authoritative. Engine-backed pages use their
 * stable upstream slug when no topic binding exists; legacy local rows without
 * either identity fall back to source references and descriptive metadata.
 */
export function wikiTopicIdentity(row: WikiIdentityRow): string {
  // Product topic IDs and upstream slugs are opaque identifiers. Do not
  // normalize them: TOPIC_A, topic-a, and two distinct Wiki slugs are different
  const topicGroup = text(row.topic_group_id);
  if (topicGroup) return `topic-group:${JSON.stringify(topicGroup)}`;
  const explicit = text(row.topic_id);
  if (explicit) return `topic:${JSON.stringify(explicit)}`;
  const externalSlug = text(row.external_slug) ?? (text(row.id)?.startsWith("engine-wiki:") ? text(row.page_key) : undefined);
  if (externalSlug) return `external:${JSON.stringify(externalSlug)}`;
  const refs = (() => {
    try {
      const raw = row.source_refs_json;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.map(text).filter((value): value is string => Boolean(value)))].sort();
    } catch {
      return [];
    }
  })();
  if (refs.length) return `fallback:source:${JSON.stringify(refs)}`;
  // Legacy rows without authoritative IDs use bounded, field-labelled
  // metadata. Keeping each field separate prevents accidental concatenation
  // collisions while retaining convergence across generated page slugs.
  const metadata = {
    title: normalizeWikiTopic(row.title)?.slice(0, 200) ?? null,
    productVersion: normalizeWikiTopic(row.product_version)?.slice(0, 120) ?? null,
    solution: normalizeWikiTopic(row.solution)?.slice(0, 200) ?? null,
    module: normalizeWikiTopic(row.module)?.slice(0, 200) ?? null,
  };
  if (Object.values(metadata).some(Boolean)) return `fallback:metadata:${JSON.stringify(metadata)}`;
  // A page key is only a final fallback for legacy rows with no descriptive
  // metadata. It is intentionally last so title/source metadata wins.
  return `fallback:page_key:${JSON.stringify((normalizeWikiTopic(row.page_key) ?? "unknown").slice(0, 300))}`;
}

function canonicalRank(row: WikiIdentityRow): [number, string, number, string] {
  // A reviewed/published page remains canonical; otherwise retain the oldest
  // row. SQLite rowid resolves equal test/import timestamps by insertion order.
  const reviewed = row.status === "published" ? 0 : 1;
  const rowid = Number(row.__wiki_rowid);
  return [reviewed, text(row.created_at) ?? "", Number.isSafeInteger(rowid) ? rowid : Number.MAX_SAFE_INTEGER, String(row.id ?? "")];
}

function before(left: WikiIdentityRow, right: WikiIdentityRow): boolean {
  const a = canonicalRank(left), b = canonicalRank(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

export function canonicalWikiRow(rows: WikiIdentityRow[], row: WikiIdentityRow): WikiIdentityRow {
  return rows.filter(candidate => wikiCanonicalKey(candidate) === wikiCanonicalKey(row))
    .reduce((best, candidate) => before(candidate, best) ? candidate : best, row);
}

export function isCanonicalWikiRow(rows: WikiIdentityRow[], row: WikiIdentityRow): boolean {
  return String(canonicalWikiRow(rows, row).id) === String(row.id);
}

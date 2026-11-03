export type WikiCitationRecord = Record<string, unknown>;

export interface WikiCitationSection {
  title?: unknown;
  citations?: unknown;
}

export interface WikiPageSource {
  citation: WikiCitationRecord;
  sectionTitles: string[];
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function citationKey(citation: WikiCitationRecord): string {
  const documentId = text(citation.documentId);
  const externalDocumentId = text(citation.externalDocumentId);
  if (documentId || externalDocumentId) return `${documentId}\u0000${externalDocumentId}`;
  return [text(citation.title), text(citation.productVersion), text(citation.sourceLocator)].join("\u0000");
}

function mergeCitation(current: WikiCitationRecord, incoming: WikiCitationRecord): WikiCitationRecord {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if ((merged[key] == null || merged[key] === "") && value != null && value !== "") merged[key] = value;
  }
  merged.chunkIds = [...new Set([...strings(current.chunkIds), ...strings(incoming.chunkIds)])];
  return merged;
}

/** Merge section citations into one page-level source list without losing chunk coverage. */
export function mergeWikiPageSources(sections: WikiCitationSection[], pageCitations: WikiCitationRecord[]): WikiPageSource[] {
  const grouped = new Map<string, WikiPageSource>();
  let hasSectionCitations = false;
  const add = (citation: WikiCitationRecord, sectionTitle?: string) => {
    const key = citationKey(citation);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { citation: { ...citation, chunkIds: strings(citation.chunkIds) }, sectionTitles: sectionTitle ? [sectionTitle] : [] });
      return;
    }
    existing.citation = mergeCitation(existing.citation, citation);
    if (sectionTitle && !existing.sectionTitles.includes(sectionTitle)) existing.sectionTitles.push(sectionTitle);
  };

  for (const section of sections) {
    const citations = Array.isArray(section.citations) ? section.citations.filter((item): item is WikiCitationRecord => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
    if (citations.length > 0) hasSectionCitations = true;
    for (const citation of citations) add(citation, text(section.title, "Section"));
  }
  if (!hasSectionCitations) for (const citation of pageCitations) add(citation);
  return [...grouped.values()];
}

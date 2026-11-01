export type WikiDirectoryPage = Record<string, unknown>;

export interface WikiDirectoryNode {
  key: string;
  label: string;
  path: string[];
  children: WikiDirectoryNode[];
  pages: WikiDirectoryPage[];
  count: number;
}

export interface WikiDirectoryTree {
  nodes: WikiDirectoryNode[];
  pages: WikiDirectoryPage[];
}

function displayText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function splitPath(value: unknown): string[] {
  return displayText(value).split(/[\\/]+/).map((part) => part.trim()).filter(Boolean);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pageTitle(page: WikiDirectoryPage): string {
  return displayText(page.title) || displayText(page.pageKey) || displayText(page.id) || "Untitled topic";
}

/**
 * The API now returns a persisted display path. Older/manual pages still use
 * solution/module as a safe fallback, but no client-side letter buckets or
 * page-window thresholds are applied here.
 */
export function wikiDirectoryPath(page: WikiDirectoryPage): string[] {
  const title = pageTitle(page);
  const path = splitPath(page.directoryPath);
  if (path.length > 0) {
    const last = path[path.length - 1];
    return normalized(last) === normalized(title) ? path.slice(0, -1) : path;
  }
  return [displayText(page.solution), displayText(page.module)]
    .filter((part) => part && normalized(part) !== "unassigned");
}

function compareLabels(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase();
  const normalizedRight = right.toLocaleLowerCase();
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortNode(node: WikiDirectoryNode): void {
  node.children.sort((left, right) => compareLabels(left.label, right.label));
  node.pages.sort((left, right) => compareLabels(pageTitle(left), pageTitle(right)));
  node.children.forEach(sortNode);
}

function countNode(node: WikiDirectoryNode): number {
  node.count = node.pages.length + node.children.reduce((total, child) => total + countNode(child), 0);
  return node.count;
}

/** Build a stable, expandable tree from persisted directory paths. */
export function buildWikiDirectoryTree(items: WikiDirectoryPage[]): WikiDirectoryTree {
  const roots: WikiDirectoryNode[] = [];
  const rootPages: WikiDirectoryPage[] = [];
  for (const page of items) {
    const path = wikiDirectoryPath(page);
    if (path.length === 0) {
      rootPages.push(page);
      continue;
    }
    let siblings = roots;
    let current: WikiDirectoryNode | undefined;
    const traversed: string[] = [];
    for (const label of path) {
      traversed.push(label);
      current = siblings.find((candidate) => normalized(candidate.label) === normalized(label));
      if (!current) {
        current = { key: traversed.join("/"), label, path: [...traversed], children: [], pages: [], count: 0 };
        siblings.push(current);
      }
      siblings = current.children;
    }
    current?.pages.push(page);
  }
  roots.sort((left, right) => compareLabels(left.label, right.label));
  roots.forEach(sortNode);
  roots.forEach(countNode);
  rootPages.sort((left, right) => compareLabels(pageTitle(left), pageTitle(right)));
  return { nodes: roots, pages: rootPages };
}

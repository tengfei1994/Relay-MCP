export type WikiDirectoryPage = Record<string, unknown>;

export interface WikiDirectoryNode {
  key: string;
  label: string;
  path: string[];
  children: WikiDirectoryNode[];
  pages: WikiDirectoryPage[];
  count: number;
  semanticFamily?: boolean;
}

export interface WikiDirectoryTree {
  nodes: WikiDirectoryNode[];
  pages: WikiDirectoryPage[];
}

function displayText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function splitPath(value: unknown): string[] {
  return displayText(value)
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function pageTitle(page: WikiDirectoryPage): string {
  return displayText(page.title) || displayText(page.pageKey) || displayText(page.id) || "Untitled topic";
}

/**
 * Prefer the generated directory_path. Older/manual pages have no path, so
 * their solution/module metadata remains a safe fallback.
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

function semanticFamilyLabel(label: string): string | undefined {
  const match = label.trim().match(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z][a-z]+/);
  const family = match?.[0]?.trim();
  return family && family.length >= 3 ? family : undefined;
}

function rebaseNode(node: WikiDirectoryNode, path: string[]): void {
  node.path = path;
  node.key = path.join("/");
  node.children.forEach((child) => rebaseNode(child, [...path, child.label]));
}

/**
 * API class labels such as Cert, CertJob and CertSectionResult are sibling
 * concepts even when the graph projection did not materialize a shared
 * namespace entity. Keep the base family as the visible topic and retain the
 * original class in directoryContext after singleton promotion.
 */
function mergeSemanticFamilies(nodes: WikiDirectoryNode[]): void {
  const byFamily = new Map<string, WikiDirectoryNode[]>();
  for (const node of nodes) {
    const family = semanticFamilyLabel(node.label);
    if (!family) continue;
    const members = byFamily.get(family.toLocaleLowerCase()) ?? [];
    members.push(node);
    byFamily.set(family.toLocaleLowerCase(), members);
  }
  const consumed = new Set<WikiDirectoryNode>();
  const merged: WikiDirectoryNode[] = [];
  for (const node of nodes) {
    if (consumed.has(node)) continue;
    const family = semanticFamilyLabel(node.label);
    const members = family ? byFamily.get(family.toLocaleLowerCase()) ?? [] : [];
    const base = members.find((candidate) => normalized(candidate.label) === normalized(family ?? ""));
    if (!family || members.length < 2 || !base) {
      merged.push(node);
      continue;
    }
    const familyNode = base ?? {
      key: [...node.path.slice(0, -1), family].join("/"),
      label: family,
      path: [...node.path.slice(0, -1), family],
      children: [],
      pages: [],
      count: 0,
      semanticFamily: true,
    };
    familyNode.semanticFamily = true;
    for (const member of members) {
      consumed.add(member);
      if (member === familyNode) continue;
      rebaseNode(member, [...familyNode.path, member.label]);
      familyNode.children.push(member);
    }
    merged.push(familyNode);
  }
  nodes.splice(0, nodes.length, ...merged);
  nodes.forEach((node) => {
    if (!node.semanticFamily) mergeSemanticFamilies(node.children);
  });
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

function collectPages(node: WikiDirectoryNode): WikiDirectoryPage[] {
  return [...node.pages, ...node.children.flatMap(collectPages)];
}

/**
 * A singleton graph branch is not useful as an extra folder, but dropping it
 * hides the relation that put the page there. Promote the page to the nearest
 * shared folder and keep the full promoted path as a compact context label.
 */
function summarizeSingletonBranches(node: WikiDirectoryNode, depth: number): void {
  const keptChildren: WikiDirectoryNode[] = [];
  for (const child of node.children) {
    summarizeSingletonBranches(child, depth + 1);
    if ((depth >= 1 || node.semanticFamily) && child.count === 1) {
      const contextPrefix = child.path.slice(node.path.length).join(" / ");
      node.pages.push(...collectPages(child).map((page) => {
        const previous = displayText(page.directoryContext);
        const directoryContext = [contextPrefix, previous].filter(Boolean).join(" / ");
        return directoryContext ? { ...page, directoryContext } : page;
      }));
      continue;
    }
    keptChildren.push(child);
  }
  node.children = keptChildren;
  node.pages.sort((left, right) => compareLabels(pageTitle(left), pageTitle(right)));
}

/** Build a stable, expandable tree from directory_path and page metadata. */
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

  mergeSemanticFamilies(roots);
  roots.sort((left, right) => compareLabels(left.label, right.label));
  roots.forEach(sortNode);
  roots.forEach(countNode);
  roots.forEach((root) => summarizeSingletonBranches(root, 0));
  rootPages.sort((left, right) => compareLabels(pageTitle(left), pageTitle(right)));
  return { nodes: roots, pages: rootPages };
}

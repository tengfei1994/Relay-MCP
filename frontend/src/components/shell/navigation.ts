import type { ReactNode } from "react";

/**
 * Match path segments rather than raw prefixes so `/knowledge/memory` does
 * not accidentally activate for an unrelated path such as
 * `/knowledge/memory-bank`.
 */
export function matchesPath(pathname: string, path: string, end = false): boolean {
  const current = pathname.replace(/\/+$/, "") || "/";
  const target = path.replace(/\/+$/, "") || "/";
  return end ? current === target : current === target || current.startsWith(`${target}/`);
}

const productDocsTabPaths = [
  "/knowledge/product-docs/topics",
  "/knowledge/product-docs/imports",
  "/knowledge/product-docs/versions",
  "/knowledge/product-docs/search",
] as const;

function matchesProductDocsTab(pathname: string, path: string): boolean {
  if (!matchesPath(pathname, path)) return false;
  // The documents tab owns otherwise-unclassified nested product-document
  // routes, while each named child route remains the active tab for its own
  // nested pages.
  return path !== "/knowledge/product-docs" || !productDocsTabPaths.some((tabPath) => matchesPath(pathname, tabPath));
}

export interface PrimaryNavItem {
  label: string;
  path: string;
  icon?: ReactNode;
}

export const primaryNavigation = [
  { label: "Projects", path: "/projects" },
  { label: "Servers", path: "/servers" },
  { label: "Instances", path: "/instances" },
  { label: "Tools", path: "/tools" },
  { label: "Knowledge", path: "/knowledge" },
  { label: "Tokens", path: "/tokens" },
  { label: "Users", path: "/users", adminOnly: true },
] as const;
export const knowledgeNavigation = [
  { label: "Overview", path: "/knowledge", matches: (pathname: string) => matchesPath(pathname, "/knowledge", true) },
  { label: "Control plane", path: "/knowledge/integrated", matches: (pathname: string) => matchesPath(pathname, "/knowledge/integrated") },
  { label: "Product docs", path: "/knowledge/product-docs", matches: (pathname: string) => matchesPath(pathname, "/knowledge/product-docs") },
  { label: "Solutions", path: "/knowledge/solution", matches: (pathname: string) => matchesPath(pathname, "/knowledge/solution") },
  {
    label: "Memory",
    path: "/knowledge/memory",
    matches: (pathname: string) => [
      "/knowledge/memory",
      "/knowledge/sessions",
      "/knowledge/evidence",
      "/knowledge/observations",
      "/knowledge/candidate-insights",
      "/knowledge/candidates",
      "/knowledge/cases",
      "/knowledge/patterns",
      "/knowledge/confirmed-memory",
    ].some((path) => matchesPath(pathname, path)),
  },
  { label: "Playbooks", path: "/knowledge/playbooks", matches: (pathname: string) => matchesPath(pathname, "/knowledge/playbooks") },
  { label: "Operations", path: "/knowledge/operations/capture", matches: (pathname: string) => matchesPath(pathname, "/knowledge/operations") },
];

export const pageTabNavigation = {
  productDocs: [
    { label: "Documents", path: "/knowledge/product-docs", end: true, matches: (pathname: string) => matchesProductDocsTab(pathname, "/knowledge/product-docs") },
    { label: "Topics", path: "/knowledge/product-docs/topics", end: true, matches: (pathname: string) => matchesProductDocsTab(pathname, "/knowledge/product-docs/topics") },
    { label: "Imports", path: "/knowledge/product-docs/imports", end: true, adminOnly: true, matches: (pathname: string) => matchesProductDocsTab(pathname, "/knowledge/product-docs/imports") },
    { label: "Versions and diffs", path: "/knowledge/product-docs/versions", end: true, matches: (pathname: string) => matchesProductDocsTab(pathname, "/knowledge/product-docs/versions") },
    { label: "Search", path: "/knowledge/product-docs/search", end: true, matches: (pathname: string) => matchesProductDocsTab(pathname, "/knowledge/product-docs/search") },
  ],
  memory: [
    { label: "Workspace", path: "/knowledge/memory", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/memory") },
    { label: "Sessions", path: "/knowledge/sessions", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/sessions") },
    { label: "Evidence", path: "/knowledge/evidence", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/evidence") },
    { label: "Observations", path: "/knowledge/observations", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/observations") },
    { label: "Candidate insights", path: "/knowledge/candidate-insights", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/candidate-insights") },
    { label: "Confirmed memory", path: "/knowledge/confirmed-memory", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/confirmed-memory") },
  ],
  operations: [
    { label: "Capture", path: "/knowledge/operations/capture", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/operations/capture") },
    { label: "Ingest", path: "/knowledge/operations/ingest", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/operations/ingest") },
    { label: "Index and providers", path: "/knowledge/operations/index", end: true, matches: (pathname: string) => matchesPath(pathname, "/knowledge/operations/index") },
  ],
} as const;

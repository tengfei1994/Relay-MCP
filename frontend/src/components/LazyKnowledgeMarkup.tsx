import React, {lazy, Suspense} from "react";
import type {KnowledgeScope} from "../knowledge/integrated-search";

const Reader=lazy(() => import("./KnowledgeMarkup").then(module => ({default: module.KnowledgeMarkup})));
export function LazyKnowledgeMarkup({source,wikiScope,wikiPageKey}: {source:string;wikiScope?:KnowledgeScope;wikiPageKey?:string}) {
  return <Suspense fallback={<p className="text-sm text-gray-400" role="status">Loading document content…</p>}><Reader source={source} wikiScope={wikiScope} wikiPageKey={wikiPageKey} /></Suspense>;
}

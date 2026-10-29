import React, {createContext, useContext} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {defaultSchema} from "rehype-sanitize";
import {Link} from "react-router-dom";
import {remarkWikiLinks, wikiLinkHref} from "../knowledge/wiki-links";
import type {KnowledgeScope} from "../knowledge/integrated-search";

const anchorPrefix = "knowledge-content-";
const InCodeBlock = createContext(false);
const SourceText = createContext("");
function sourceReferences(node: unknown): string[] {
  const value = node as {properties?: {href?: unknown}; children?: unknown[]} | undefined;
  return [...new Set([...(typeof value?.properties?.href === "string" ? [value.properties.href] : []), ...(value?.children ?? []).flatMap(sourceReferences)])];
}
const schema = {
  ...defaultSchema,
  clobberPrefix: anchorPrefix,
  tagNames: ["a","p","br","hr","h1","h2","h3","h4","h5","h6","pre","code","strong","em","del","s","b","i","blockquote","ul","ol","li","table","thead","tbody","tfoot","tr","th","td","caption","div","span","img","sup","sub","dl","dt","dd"],
};

const linkClass = "text-mint underline decoration-mint/60 underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mint";

/** Render source structure without executing source HTML or fetching its assets.
 * Relative files remain source references until Relay has an authorized asset
 * resolver. They must not become accidental requests against the current route. */
export function KnowledgeMarkup({source, wikiScope, wikiPageKey}: {source: string; wikiScope?: KnowledgeScope; wikiPageKey?: string}) {
  return <SourceText.Provider value={source}><div className="min-w-0 space-y-3 break-words text-sm leading-6 text-fg [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-fg [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg [&_h3]:font-semibold [&_h3]:text-fg [&_h4]:font-semibold [&_h4]:text-fg [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-field [&_pre]:border [&_pre]:border-line [&_pre]:bg-black/20 [&_pre]:p-3 [&_pre]:text-xs [&_code]:font-mono [&_blockquote]:border-l-2 [&_blockquote]:border-mint [&_blockquote]:pl-3">
    <Markdown remarkPlugins={wikiPageKey ? [remarkGfm,remarkWikiLinks] : [remarkGfm]} rehypePlugins={[rehypeRaw,[rehypeSanitize,schema]]} components={{
      table: ({children,id}) => <div className="max-w-full overflow-x-auto"><table id={id} className="w-full border-collapse text-left text-sm">{children}</table></div>,
      th: ({children,colSpan,rowSpan,id}) => <th id={id} colSpan={colSpan} rowSpan={rowSpan} className="border border-line bg-mint/10 px-3 py-2 align-top font-medium text-fg">{children}</th>,
      td: ({children,colSpan,rowSpan,id}) => <td id={id} colSpan={colSpan} rowSpan={rowSpan} className="border border-line px-3 py-2 align-top text-muted">{children}</td>,
      pre: ({children,node,id}) => {
        const references=sourceReferences(node);
        return <><InCodeBlock.Provider value={true}><pre id={id}>{children}</pre></InCodeBlock.Provider>{references.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">Source references</summary><ul>{references.map(ref=><li key={ref} className="break-all font-mono">{ref}</li>)}</ul></details>}</>;
      },
      img: ({src,alt}) => <span className="inline-block break-all rounded-field border border-sun/40 bg-sun/10 px-2 py-1 text-xs text-sun">Image reference: {alt ? `${alt} — ` : ""}{src || "unavailable"}</span>,
      a: ({href,id,node,children}) => {
        const name=typeof node?.properties.name === "string" ? node.properties.name : undefined;
        const inCode=useContext(InCodeBlock), rawSource=useContext(SourceText), anchor=id ?? name;
        const content=<>{id && name && id!==name && <span id={name} />}{children}</>;
        if (!href || inCode) return <span id={anchor} title={inCode ? href : undefined}>{content}</span>;
        const wikiWrappedUrl = rawSource.includes(`[[${href}|`) || rawSource.includes(`[[${href}]]`);
        if (wikiWrappedUrl) return <span id={anchor}>{content}</span>;
        if (href.startsWith('/knowledge/wiki-link/')) {
          let target: string | undefined;
          try { target=wikiScope && wikiLinkHref(decodeURIComponent(href.slice('/knowledge/wiki-link/'.length)),wikiScope,wikiPageKey); } catch { /* Invalid source reference remains text. */ }
          return target ? <Link id={anchor} to={target} className={linkClass}>{content}</Link> : <span id={anchor}>{content}</span>;
        }
        if (href.startsWith("#")) return <a id={anchor} href={`#${anchorPrefix}${href.slice(1)}`} className={linkClass}>{content}</a>;
        if (/^https?:\/\//i.test(href)) return <a id={anchor} href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>{content}</a>;
        return <span id={anchor}>{content}<span className="ml-1 break-all font-mono text-xs text-muted">({href})</span></span>;
      },
    }}>{source}</Markdown>
  </div></SourceText.Provider>;
}

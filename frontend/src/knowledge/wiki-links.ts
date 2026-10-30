import {buildKnowledgeScope, withKnowledgeScope, type KnowledgeScope} from './integrated-search';

export function validWikiSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 255 && slug.split('/').every(part => /^[\p{L}\p{N}_-]+$/u.test(part));
}

export function wikiLinkHref(slug: string, scope: KnowledgeScope, pageKey?: string): string | undefined {
  if (!validWikiSlug(slug)) return undefined;
  const prefix=pageKey?.match(/^engine-wiki:[a-f0-9]{16}:/)?.[0];
  if (!prefix) return undefined;
  return withKnowledgeScope(`/knowledge/wiki?wikiKey=${encodeURIComponent(prefix+slug)}`, scope);
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  position?: unknown;
}

/** Transform Markdown text nodes, never code or existing links. */
export function remarkWikiLinks() {
  return (tree: MdastNode) => {
    const walk = (node: MdastNode) => {
      if (!node.children || ['code','inlineCode','link','linkReference','html'].includes(node.type)) return;
      // GFM parses bare URLs before remark transforms. Keep URLs enclosed in
      // Wiki syntax as text, so invalid Wiki targets cannot become external links.
      const children = node.children.map((child,index) => {
        const before=node.children?.[index-1]?.value ?? '',after=node.children?.[index+1]?.value ?? '';
        if (child.type === 'link' && !child.position && before.lastIndexOf('[[')>before.lastIndexOf(']]') && after.includes(']]')) {
          return {type:'text',value:child.children?.map(part=>part.value ?? '').join('') ?? ''};
        }
        return child;
      });
      const merged: MdastNode[]=[];
      for (const child of children) {
        const previous=merged.at(-1);
        if (child.type==='text' && previous?.type==='text') previous.value=(previous.value ?? '')+(child.value ?? '');
        else merged.push(child);
      }
      node.children=merged.flatMap(child => {
        if (child.type!=='text') { walk(child); return [child]; }
        const parts: MdastNode[]=[]; let cursor=0;
        const value=child.value ?? '';
        for (const match of value.matchAll(/\[\[([^\[\]\r\n]+)\]\]/g)) {
          const [slug,label,...extra]=match[1].split('|');
          if (extra.length || !validWikiSlug(slug) || label==='') continue;
          parts.push({type:'text',value:value.slice(cursor,match.index)});
          parts.push({type:'link',url:`/knowledge/wiki-link/${encodeURIComponent(slug)}`,children:[{type:'text',value:label ?? slug}]});
          cursor=match.index+match[0].length;
        }
        parts.push({type:'text',value:value.slice(cursor)});
        return parts;
      });
    };
    walk(tree);
  };
}

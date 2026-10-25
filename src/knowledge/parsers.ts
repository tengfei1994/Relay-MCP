/** Small, dependency-free parsers used by the Product/Solution ingestion boundary. */
import { PDFParse } from "pdf-parse";
import { renderProductHtml } from "./html-markdown.js";
export interface ParsedHelpHtml { text: string; title?: string; stableIdentifiers: Record<string, string>; links: string[]; images: string[]; sourceFormat: "madcap-html" | "innovasys-html" | "html"; }

function decode(value: string): string { return value.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'"); }
export function parseHelpHtml(source: string): ParsedHelpHtml {
  const value=renderProductHtml(source);
  return {text:value.markdown,title:value.title,stableIdentifiers:value.stableIdentifiers,links:value.links,images:value.images,sourceFormat:value.sourceFormat};
}

export function parseToc(source: string): Array<{ title: string; path: string; href?: string }> {
  const result: Array<{ title: string; path: string; href?: string }> = [];
  for (const match of source.matchAll(/\{"id"\s*:\s*"[^"]+"\s*,\s*"t"\s*:\s*"([^"]+)"\s*,\s*"u"\s*:\s*"([^"]+)"/g)) result.push({ title: decode(match[1]), path: match[2], href: match[2] });
  for (const match of source.matchAll(/(?:title|text|name)\s*[:=]\s*["']([^"']+)["'][\s\S]{0,300}?(?:url|href|link)\s*[:=]\s*["']([^"']+)["']/gi)) result.push({ title: match[1], path: match[2], href: match[2] });
  return result;
}

export function parseChmExtractedHtml(source: string): ParsedHelpHtml { return { ...parseHelpHtml(source), sourceFormat: "html" }; }

export async function parsePdfBytes(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try { return (await parser.getText()).text.trim(); } finally { await parser.destroy(); }
}

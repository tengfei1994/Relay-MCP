/** Small, dependency-free parsers used by the Product/Solution ingestion boundary. */
export interface ParsedHelpHtml { text: string; title?: string; stableIdentifiers: Record<string, string>; links: string[]; images: string[]; sourceFormat: "madcap-html" | "innovasys-html" | "html"; }

function decode(value: string): string { return value.replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'"); }
export function parseHelpHtml(source: string): ParsedHelpHtml {
  const stableIdentifiers: Record<string, string> = {};
  for (const match of source.matchAll(/<meta\s+[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)) { const key = match[1].toLowerCase(); if (/^(ait_topic_id|microsoft\.help\.(?:id|f1)|title|product)$/.test(key)) stableIdentifiers[key] = decode(match[2].trim()); }
  const sourceFormat: ParsedHelpHtml = { text: "", stableIdentifiers, links: [], images: [], sourceFormat: /i-page-title-text|i-section-heading/i.test(source) ? "innovasys-html" : /MadCap|mc-.*|data-mc/i.test(source) ? "madcap-html" : "html" };
  sourceFormat.links = [...source.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]); sourceFormat.images = [...source.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  let text = source.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<(?:nav|aside|footer|header)[^>]*>[\s\S]*?<\/(?:nav|aside|footer|header)>/gi, "");
  text = text.replace(/<div[^>]*class=["'][^"']*i-page-title-text[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, "\n# $1\n").replace(/<div[^>]*class=["'][^"']*i-section-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, "\n## $1\n").replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, d, b) => `\n${"#".repeat(Number(d))} ${b}\n`);
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, b) => `\n\n\`\`\`\n${b}\n\`\`\`\n`).replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, b) => `\n${b}\n`).replace(/<tr[^>]*>/gi, "\n").replace(/<\/(?:tr)>/gi, "\n").replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_m, b) => ` | ${b} `).replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|li|td|th)>/gi, "\n").replace(/<[^>]+>/g, "");
  sourceFormat.text = decode(text).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/^([#]{1,6})\s*\n\s*([^\n#][^\n]*)/gm, "$1 $2").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim(); sourceFormat.title = sourceFormat.text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? stableIdentifiers.title;
  return sourceFormat;
}

export function parseToc(source: string): Array<{ title: string; path: string; href?: string }> {
  const result: Array<{ title: string; path: string; href?: string }> = [];
  for (const match of source.matchAll(/\{"id"\s*:\s*"[^"]+"\s*,\s*"t"\s*:\s*"([^"]+)"\s*,\s*"u"\s*:\s*"([^"]+)"/g)) result.push({ title: decode(match[1]), path: match[2], href: match[2] });
  for (const match of source.matchAll(/(?:title|text|name)\s*[:=]\s*["']([^"']+)["'][\s\S]{0,300}?(?:url|href|link)\s*[:=]\s*["']([^"']+)["']/gi)) result.push({ title: match[1], path: match[2], href: match[2] });
  return result;
}

export function parseChmExtractedHtml(source: string): ParsedHelpHtml { return { ...parseHelpHtml(source), sourceFormat: "html" }; }

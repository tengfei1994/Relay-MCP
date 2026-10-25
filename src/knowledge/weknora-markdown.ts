/**
 * Structured HTML -> Markdown normalization for Product Knowledge ingestion.
 *
 * Unlike a flatten-to-text cleanup this preserves the structures retrieval
 * and citation depend on: headings (with anchors), lists, tables, fenced
 * code blocks, images and links. The output is stable across runs of the
 * same source so normalized hashes stay comparable.
 */
export interface StructuredMarkdown {
  markdown: string;
  title?: string;
  anchors: string[];
  links: string[];
  images: string[];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

function attr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeEntities(match[1].trim()) : undefined;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function anchorPlaceholder(id: string): string {
  return `@@ANCHOR:${id.replace(/[^A-Za-z0-9_.:-]/g, "-")}@@`;
}

function convertTable(tableBody: string): string {
  const rows: string[][] = [];
  let headerFromTh = false;
  for (const rowMatch of tableBody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    let rowHasTh = false;
    for (const cellMatch of rowMatch[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)) {
      if (cellMatch[1].toLowerCase() === "th") rowHasTh = true;
      cells.push(escapeCell(stripTags(cellMatch[2])));
    }
    if (!cells.length) continue;
    if (!rows.length && rowHasTh) headerFromTh = true;
    rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array<string>(Math.max(0, width - row.length)).fill("")];
  const header = headerFromTh ? rows[0] : Array<string>(width).fill(" ");
  const bodyRows = headerFromTh ? rows.slice(1) : rows;
  const lines = [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...bodyRows.map((row) => `| ${pad(row).join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

function convertList(tag: "ul" | "ol", body: string): string {
  const items = body.split(/<li[^>]*>/i).slice(1).map((item) => item.replace(/<\/li>/gi, "").trim()).filter(Boolean);
  const lines = items.map((item, index) => {
    const bullet = tag === "ol" ? `${index + 1}.` : "-";
    const [first, ...rest] = item.split("\n");
    const continuation = rest.map((line) => (line.trim() ? `  ${line}` : ""));
    return [`${bullet} ${first}`, ...continuation].join("\n");
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

/** Mask source code before HTML processing; restore after cleanup. */
function protectedMarkdown(source: string) {
  let prefix = "\uE000RELAY_LITERAL_";
  while (source.includes(prefix)) prefix += "_";
  const values: string[] = [];
  const keep = (value: string) => prefix + (values.push(value) - 1) + "\uE001";
  const lines = source.split(/(?<=\n)/), parts: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].replace(/\r?\n$/, "").match(/^[ \t]{0,3}(\x60{3,}|~{3,})([^\r\n]*)$/);
    if (!opening || (opening[1][0] === "\x60" && opening[2].includes("\x60"))) { parts.push(lines[index]); continue; }
    const block = [lines[index]];
    while (++index < lines.length) {
      block.push(lines[index]);
      const closing = lines[index].replace(/\r?\n$/, "").match(/^[ \t]{0,3}(\x60+|~+)[ \t]*$/);
      if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length) break;
    }
    parts.push(keep(block.join("")));
  }
  const text = parts.join("").replace(/(?<!\x60)(\x60+)(?!\x60)([\s\S]*?)(?<!\x60)\1(?!\x60)/g, match => keep(match));
  return { text, keep, restore: (value: string) => values.reduceRight((result, literal, index) => result.split(prefix + index + "\uE001").join(literal), value) };
}

function removeNonContentMarkup(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

const CANONICAL_ANCHOR = /<a\s+id="([A-Za-z0-9_.:-]+)"\s*><\/a>/gi;
const HTML_CONTENT_TAG = /<!doctype\s+html\b|<\/?(?:html|head|body|h[1-6]|p|pre|code|div|section|article|table|thead|tbody|tr|td|th|ul|ol|li|blockquote|br|hr|script|style|nav|aside|header|footer|a|img|strong|em|b|i)\b[^>]*>/i;

/** Imported Product bodies are Markdown even if their original path is HTML.
 * Detect markup outside literals; retain HTML cleanup for actual HTML. */
export function normalizeProductMarkup(source: string): string {
  const literals = protectedMarkdown(source);
  if (HTML_CONTENT_TAG.test(literals.text.replace(CANONICAL_ANCHOR, ""))) return htmlToStructuredMarkdown(source).markdown;
  let text = removeNonContentMarkup(literals.text);
  text = text.replace(CANONICAL_ANCHOR, match => literals.keep(match));
  // Unrecognized raw HTML remains stripped outside literal code. Markdown
  // entities, indentation, blank lines and link syntax retain their meaning.
  return literals.restore(text.replace(/<[^>]+>/g, "")).trim();
}

export function htmlToStructuredMarkdown(source: string): StructuredMarkdown {
  return convertProductHtml(source, true);
}

/** Compatibility proof only: reproduce the old normalization to recognize an
 * immutable same-parser mapping. Never use this output for uploads or repair. */
export function legacyProductMarkupForReplay(source: string): string {
  return convertProductHtml(source, false).markdown;
}

function convertProductHtml(source: string, preserveCode: boolean): StructuredMarkdown {
  const links: string[] = [];
  const images: string[] = [];
  const anchors: string[] = [];

  const literals = preserveCode ? protectedMarkdown(source) : { text: source, keep: (value: string) => value, restore: (value: string) => value };
  let text = preserveCode ? removeNonContentMarkup(literals.text) : source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:nav|aside|footer|header)[^>]*>[\s\S]*?<\/(?:nav|aside|footer|header)>/gi, "");

  // Fenced code blocks first so their contents survive tag stripping.
  text = text.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (_m, attrs: string, body: string) => {
    const codeAttrs = body.match(/<code([^>]*)>/i)?.[1] ?? "";
    const language = attr(`${attrs} ${codeAttrs}`, "class")?.match(/(?:language|lang)-([A-Za-z0-9]+)/)?.[1] ?? "";
    const code = decodeEntities(literals.restore(body).replace(/<\/?code[^>]*>/gi, "").replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "");
    const fence = "\x60".repeat(preserveCode ? Math.max(3, ...[...code.matchAll(/\x60+/g)].map(match => match[0].length + 1)) : 3);
    return "\n\n" + literals.keep(fence + language + "\n" + code + "\n" + fence) + "\n\n";
  });

  // Tables, innermost first so nested markup collapses deterministically.
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/<table[^>]*>((?:(?!<\/?table[^>]*>)[\s\S])*)<\/table>/gi, (_m, body: string) => convertTable(body));
  }

  // Headings keep their anchor via a placeholder that tag stripping cannot eat.
  text = text.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, depth: string, attrs: string, body: string) => {
    const id = attr(attrs, "id");
    if (id) anchors.push(id);
    const marker = id ? `${anchorPlaceholder(id)}\n` : "";
    return `\n\n${marker}${"#".repeat(Number(depth))} ${stripTags(body)}\n\n`;
  });

  // Named anchors outside headings.
  text = text.replace(/<a([^>]*)\bname\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/a>/gi, (_m, _pre: string, name: string) => {
    anchors.push(name);
    return anchorPlaceholder(name);
  });

  // Lists, innermost first; converted nested lists become continuation lines.
  previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/<(ul|ol)[^>]*>((?:(?!<\/?(?:ul|ol)[^>]*>)[\s\S])*)<\/\1>/gi, (_m, tag: string, body: string) => convertList(tag.toLowerCase() as "ul" | "ol", body));
  }

  text = text
    .replace(/<img([^>]*)>/gi, (_m, attrs: string) => {
      const src = attr(attrs, "src") ?? "";
      const alt = attr(attrs, "alt") ?? "";
      if (src) images.push(src);
      return src ? `![${alt}](${src})` : "";
    })
    .replace(/<a([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, body: string) => {
      const href = attr(attrs, "href");
      const label = stripTags(body);
      if (!href) return label;
      links.push(href);
      return `[${label || href}](${href})`;
    })
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => { const code = stripTags(literals.restore(body)); const ticks = "\x60".repeat(preserveCode ? Math.max(1, ...[...code.matchAll(/\x60+/g)].map(match => match[0].length + 1)) : 1); return literals.keep(ticks + code + ticks); })
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|blockquote|figure|figcaption)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  let inFence = false;
  const normalized = decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^```/.test(line.trimStart())) { inFence = !inFence; return line.trim(); }
      // Outside fenced code, HTML source indentation must not turn lines
      // into indented code blocks; nested-list continuation stays readable
      // even when flattened.
      return inFence ? line.trimEnd() : line.trim();
    })
    .join("\n")
    .replace(/@@ANCHOR:([A-Za-z0-9_.:-]+)@@/g, '<a id="$1"></a>')
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const markdown = literals.restore(normalized).trim();
  const title = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || undefined;
  return { markdown, title, anchors: [...new Set(anchors)], links: [...new Set(links)], images: [...new Set(images)] };
}

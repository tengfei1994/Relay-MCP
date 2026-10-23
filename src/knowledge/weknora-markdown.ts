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

export function htmlToStructuredMarkdown(source: string): StructuredMarkdown {
  const links: string[] = [];
  const images: string[] = [];
  const anchors: string[] = [];

  let text = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:nav|aside|footer|header)[^>]*>[\s\S]*?<\/(?:nav|aside|footer|header)>/gi, "");

  // Fenced code blocks first so their contents survive tag stripping.
  text = text.replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (_m, attrs: string, body: string) => {
    const codeAttrs = body.match(/<code([^>]*)>/i)?.[1] ?? "";
    const language = attr(`${attrs} ${codeAttrs}`, "class")?.match(/(?:language|lang)-([A-Za-z0-9]+)/)?.[1] ?? "";
    const code = decodeEntities(body.replace(/<\/?code[^>]*>/gi, "").replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "");
    return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
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
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => `\`${stripTags(body)}\``)
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|blockquote|figure|figcaption)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");

  let inFence = false;
  const markdown = decodeEntities(text)
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

  const title = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || undefined;
  return { markdown, title, anchors: [...new Set(anchors)], links: [...new Set(links)], images: [...new Set(images)] };
}
